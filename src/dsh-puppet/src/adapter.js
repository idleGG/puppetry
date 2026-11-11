import { statfsSync } from 'node:fs'
import { cpus, freemem, hostname, loadavg, platform, release, totalmem } from 'node:os'

/**
 * Host Adapter: the only module that knows DSH's session/workspace services.
 * The puppet loop talks to this interface, so a different harness can
 * implement the same handful of methods.
 */
export class DshAdapter {
  constructor(ctx, store, log) {
    this.ctx = ctx
    this.store = store
    this.log = log
    this.cache = { at: 0, sessions: [] }
    this.titleCache = new Map()
  }

  sessionController() {
    try {
      return this.ctx.sessionController ?? this.ctx.get?.('sessionController')
    } catch {
      return undefined
    }
  }

  requireSessionController() {
    const controller = this.sessionController()
    if (!controller) throw new Error('DSH sessionController is not available in this profile')
    return controller
  }

  async listSessions() {
    if (Date.now() - this.cache.at < 5000) return this.cache.sessions
    const controller = this.sessionController()
    if (!controller) return []
    const signal = AbortSignal.timeout(8000)
    const result = await controller.list(signal)
    const rows = Array.isArray(result) ? result : (result?.items ?? [])
    let archived = new Set()
    const workspaceTitle = new Map()
    const workspacePath = new Map()
    try {
      const registry = this.ctx.get?.('workspaceRegistry')
      archived = new Set(registry?.archivedSessionIds ?? [])
      // 工作区实体注册表：sessionId -> 工作区显示名(title) / 规范化路径(path)。
      // DSH 里用户可对工作区「重命名」，title 与路径最后一段可以不一致，故以 title 为准。
      if (registry?.list) {
        for (const ws of registry.list()) {
          for (const sid of ws.sessionIds ?? []) {
            workspaceTitle.set(sid, typeof ws.title === 'string' ? ws.title : '')
            workspacePath.set(sid, typeof ws.path === 'string' ? ws.path : '')
          }
        }
      }
    } catch {
      // Workspace registry is optional in a headless profile.
    }
    const sessions = []
    const deadline = Date.now() + 3000
    for (const row of rows.slice(0, 80)) {
      const id = row.sessionId ?? row.id
      if (!id) continue
      const cachedTitle = this.titleCache.get(id)
      let title = cachedTitle && Date.now() - cachedTitle.at < 60_000 ? cachedTitle.title : ''
      if (Date.now() < deadline) {
        try {
          const projection = await controller.projections({ sessionId: id }, AbortSignal.timeout(1200))
          title =
            projection?.values?.title ??
            projection?.values?.sessionTitle ??
            projection?.values?.sessionListMetadata?.title ??
            title
          this.titleCache.set(id, { title, at: Date.now() })
        } catch {
          // Projection read is best-effort; the id/status still keep the list useful.
        }
      }
      sessions.push({
        id,
        title: typeof title === 'string' ? title.slice(0, 200) : '',
        running: Boolean(row.running),
        updatedAt: Number(row.updatedAt ?? 0),
        cwd: typeof row.cwd === 'string' ? row.cwd : '',
        workspaceTitle: workspaceTitle.get(id) || '',
        workspacePath: workspacePath.get(id) || '',
        origin: row.origin ?? 'root',
        parentId: row.parentSessionId ?? null,
        archived: archived.has(id) || Boolean(row.archived),
        agentAvailable: row.agentAvailable !== false,
      })
    }
    this.cache = { at: Date.now(), sessions }
    return sessions
  }

  /**
   * Read the last `limit` messages of a session via sessionController.page
   * (cold-safe, message-aligned history). Returns [] when the profile does not
   * expose history reads; the digest then simply omits messages.
   */
  async getSessionMessages(sessionId, limit = 20) {
    const controller = this.sessionController()
    if (!controller || typeof controller.page !== 'function') return []
    let throughSeq = 0
    try {
      const projection = await controller.projections({ sessionId }, AbortSignal.timeout(1500))
      throughSeq = Number(projection?.asOfSeq ?? 0)
    } catch {
      throughSeq = 0
    }
    if (!throughSeq) return []
    try {
      const page = await controller.page(
        { address: { kind: 'session', sessionId }, throughSeq, maxMessages: limit },
        AbortSignal.timeout(6000),
      )
      return normalizeMessages(page?.records ?? [], limit)
    } catch (error) {
      this.log?.warn?.(`[dsh-puppet] session history read failed for ${sessionId}: ${error.message}`)
      return []
    }
  }

  async prompt({ sessionId, text, commandId, model }) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw Object.assign(new Error('prompt text must not be empty'), { code: 'bad_request' })
    }
    const controller = this.requireSessionController()
    const requestId = commandId
    if (model && typeof model === 'object' && model.provider && model.model) {
      try {
        await controller.selectModel({ sessionId, provider: model.provider, model: model.model })
      } catch (error) {
        throw Object.assign(new Error(`model unavailable: ${error.message}`), { code: 'session/model-unavailable' })
      }
    }
    await controller.prompt(
      {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(20000),
    )
    return { accepted: true }
  }

  /**
   * 受控端可用模型列表（按 provider 分组），用于心跳上报给控制端选择。
   * 依赖 DSH 的 llm registry：ctx.get('llm').listProviders() + listModels(providerId)。
   * 注意：llm / agentDefaultModel 是注入服务，直接属性访问在未注入时会抛
   * "cannot get property ... without inject"，统一走 ctx.get() 服务定位并兜底。
   */
  async listModels() {
    let llm
    try {
      llm = this.ctx.get?.('llm')
    } catch {
      llm = undefined
    }
    if (!llm || typeof llm.listProviders !== 'function') {
      return { groups: [], default: null }
    }
    let defaultSel = null
    try {
      const adm = this.ctx.get?.('agentDefaultModel')
      defaultSel = adm?.currentSelection?.() ?? null
    } catch {
      defaultSel = null
    }
    const groups = []
    try {
      for (const provider of llm.listProviders()) {
        const providerId = provider?.id
        if (!providerId) continue
        try {
          const models = await llm.listModels(providerId)
          if (Array.isArray(models) && models.length) {
            groups.push({
              id: providerId,
              name: provider?.name ?? providerId,
              models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
            })
          }
        } catch {
          // 单个 provider 失败不影响其它 provider。
        }
      }
    } catch {
      // llm registry 不可用时返回空列表。
    }
    return { groups, default: defaultSel }
  }

  async cancel(sessionId) {
    const controller = this.requireSessionController()
    const result = await controller.cancel({ sessionId })
    return { cancelled: Boolean(result?.accepted ?? true) }
  }

  async rename(sessionId, title) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw Object.assign(new Error('title must not be empty'), { code: 'bad_request' })
    }
    const controller = this.requireSessionController()
    await controller.rename({ sessionId, title: title.slice(0, 200) })
    return {}
  }

  async archive(sessionId) {
    const registry = (() => { try { return this.ctx.get?.('workspaceRegistry') } catch { return undefined } })()
    if (!registry?.archiveSession) throw new Error('workspace archive is not available in this profile')
    await registry.archiveSession(sessionId, { stopActivity: false })
    return {}
  }

  async createSession({ cwd, title, agentPreset } = {}) {
    if (!this.store.config.allowRemoteCreate) {
      throw Object.assign(new Error('remote session creation is disabled'), { code: 'policy_denied' })
    }
    const requested = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : ''
    if (requested) this.assertAllowedPath(requested)
    const controller = this.requireSessionController()
    const created = await controller.create({
      ...(requested ? { cwd: requested } : {}),
      ...(agentPreset ? { agentPreset } : {}),
    })
    const sessionId = created.sessionId
    if (title) {
      try {
        await controller.rename({ sessionId, title: String(title).slice(0, 200) })
      } catch {
        // Creation succeeded; a title failure must not fail the command.
      }
    }
    return { session_id: sessionId }
  }

  assertAllowedPath(path) {
    const roots = this.store.config.allowedRoots
    if (!Array.isArray(roots) || roots.length === 0) return
    const normalized = path.replace(/\\/gu, '/').toLowerCase()
    const allowed = roots.some((root) => {
      const candidate = String(root).replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
      return candidate.length > 0 && (normalized === candidate || normalized.startsWith(`${candidate}/`))
    })
    if (!allowed) {
      throw Object.assign(new Error(`path is outside allowedRoots: ${path}`), { code: 'policy_denied' })
    }
  }

  async respondApproval() {
    throw Object.assign(new Error('remote approval is not implemented yet'), { code: 'unsupported' })
  }

  async respondQuestion() {
    throw Object.assign(new Error('remote questions are not implemented yet'), { code: 'unsupported' })
  }

  environment() {
    const disk = diskFree(process.cwd())
    return {
      os: { platform: platform(), release: release(), hostname: hostname() },
      cpu: { model: cpus()[0]?.model ?? 'unknown', cores: cpus().length, load: loadavg() },
      memory: { total: totalmem(), free: freemem() },
      disk,
      node: process.version,
      versions: {
        electron: process.versions.electron ?? null,
        dsh: process.env.DSH_VERSION ?? '0.2.x',
      },
      cwd: process.cwd(),
      uptime: Math.round(process.uptime()),
    }
  }
}

function diskFree(path) {
  try {
    const stats = statfsSync(path)
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) }
  } catch {
    return { free: null, total: null }
  }
}

function messageText(data) {
  // user/message 的事件 data 就是消息本身（content 数组在顶层）；
  // assistant/tool/system/developer 消息则包在 data.message 里。
  const message = data?.message ?? data
  const content = message?.content
  if (Array.isArray(content)) {
    // 仅取最终回复文本块（type==='text'），排除 reasoning/thinking 等思考块。
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text))
      .join('')
  }
  if (typeof content === 'string') return content
  if (typeof message?.text === 'string') return message.text
  return ''
}

/** Fold a raw history page into a bounded, digest-friendly message list. */
function normalizeMessages(records, limit) {
  const out = []
  for (const record of records ?? []) {
    const event = record?.event ?? record
    const type = event?.type
    const data = event?.data ?? {}
    let role = null
    let text = ''
    if (type === 'user/message') {
      role = 'user'
      text = messageText(data)
    } else if (type === 'assistant/message') {
      role = 'assistant'
      text = messageText(data)
    } else if (type === 'tool/call') {
      role = 'tool'
      text = `[tool] ${String(data.name ?? data.tool ?? '')}`
    } else if (type === 'tool/result') {
      role = 'tool'
      text = `[result] ${messageText(data).slice(0, 300)}`
    }
    if (!role || !text) continue
    out.push({
      role,
      text: text.slice(0, 1000),
      ts: Number(event.time ?? 0),
      seq: Number(event.seq ?? 0),
    })
  }
  return out.slice(-limit)
}
