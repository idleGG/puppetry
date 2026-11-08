import { freemem, loadavg, totalmem } from 'node:os'
import { authHeader, openCommandEnvelope, sealResultEnvelope } from './protocol.js'
import { PairingManager } from './pairing.js'
import { sealSymmetric } from './crypto/hpke.js'
import {
  PROTOCOL_VERSION,
  PLUGIN_VERSION,
  b64u,
  clamp,
  randomToken,
  sha256Hex,
  sleep,
  unixSeconds,
  unb64u,
} from './util.js'

class HttpError extends Error {
  constructor(status, code, detail) {
    super(`${code || 'http_error'} (HTTP ${status})${detail ? `: ${detail}` : ''}`)
    this.status = status
    this.code = code
  }
}

/** Implementation-only heartbeat acceleration while a pairing QR is on screen. */
const PAIRING_FAST_HB_MS = 2000

/** Bounds for the sealed session digest carried to the controller (e2e-encryption.md §1.4). */
const DIGEST_SESSIONS = 10
const DIGEST_MESSAGES = 20

/** 工作区别名（路径最后一段）与类型（local / wsl）。 */
function workspaceInfo(cwd) {
  const p = String(cwd || '')
  const lower = p.toLowerCase()
  let type = 'local'
  if (lower.startsWith('\\\\wsl') || lower.startsWith('//wsl') || /^\/mnt\/[a-z]\//.test(lower)) {
    type = 'wsl'
  }
  const norm = p.replace(/\\/g, '/').replace(/\/+$/u, '')
  const parts = norm.split('/').filter(Boolean)
  return { alias: parts.length ? parts[parts.length - 1] : norm, type }
}

/**
 * The agent-side control loop.
 *
 * One iteration: ensure enrollment, upload the sealed/summary session digest,
 * send a heartbeat, execute any piggybacked commands, and schedule the next
 * beat. No persistent connection is opened.
 */
export class RemoteAgent {
  constructor({ ctx, store, adapter, snapshot, wake, log }) {
    this.ctx = ctx
    this.store = store
    this.adapter = adapter
    this.snapshot = snapshot
    this.wake = wake
    this.log = log
    this.running = false
    this.ticking = false
    this.abort = null
    this.bootId = `b_${randomToken(8)}`
    this.seq = 0
    this.heartbeatCount = 0
    this.commandCount = 0
    this.lastHeartbeatAt = null
    this.lastCommandAt = null
    this.lastError = null
    this.nextHeartbeatAt = null
    this.state = 'stopped'
    this.acks = []
    this.results = new Map()
    this.digest = { epoch: 1, rev: 0, hash: '', count: 0 }
    this.messageCache = new Map()
    this.kickRequested = false
    this.kickResolve = null
    this.pairing = new PairingManager({ store, agent: this, log })
  }

  get config() {
    return this.store.config
  }

  get identity() {
    return this.store.identity
  }

  get agentId() {
    return this.store.state.serverAgentId || this.identity.agentId
  }

  setState(state, detail) {
    if (this.state === state) return
    this.state = state
    if (detail) this.log.info(`[dsh-puppet] ${state}: ${detail}`)
    else this.log.info(`[dsh-puppet] ${state}`)
  }

  status() {
    return {
      state: this.state,
      relayUrl: this.config.relayUrl,
      agentId: this.agentId,
      localAgentId: this.identity.agentId,
      bootId: this.bootId,
      heartbeatCount: this.heartbeatCount,
      commandCount: this.commandCount,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastCommandAt: this.lastCommandAt,
      lastError: this.lastError,
      nextHeartbeatAt: this.nextHeartbeatAt,
      sessions: this.digest.count,
      bindings: this.store.bindings.length,
      pairing: this.pairing.status(),
      wake: this.wake.status(),
    }
  }

  start() {
    if (this.running) return
    if (!this.config.enabled) {
      this.setState('disabled', 'plugin is disabled')
      return
    }
    if (!this.config.relayUrl) {
      this.setState('unconfigured', 'set a relay URL in the setup page')
      return
    }
    this.running = true
    this.abort = new AbortController()
    this.setState('connecting')
    this.loop().catch((error) => {
      this.lastError = error.message
      this.setState('error', error.message)
    })
  }

  stop() {
    this.running = false
    this.abort?.abort()
    this.abort = null
    this.nextHeartbeatAt = null
    if (this.state !== 'disabled') this.setState('stopped')
  }

  restart() {
    this.stop()
    setTimeout(() => this.start(), 80).unref?.()
  }

  async loop() {
    let backoff = 2000
    while (this.running) {
      const started = Date.now()
      try {
        await this.tick()
        backoff = 2000
      } catch (error) {
        if (error instanceof HttpError && error.status === 401 && this.store.state.serverAgentId) {
          this.store.state.serverAgentId = null
          this.store.saveState()
        }
        this.lastError = error instanceof Error ? error.message : String(error)
        this.setState('error', this.lastError)
        this.log.warn(`[dsh-puppet] heartbeat failed: ${this.lastError}`)
      }
      if (!this.running) break

      // Implementation strategy (not wire protocol): after creating a pairing
      // window or processing an invitation, run the next tick immediately so
      // the invitation or the digest/pairing state flushes without delay.
      if (this.kickRequested) {
        this.kickRequested = false
        this.nextHeartbeatAt = new Date().toISOString()
        continue
      }

      const configured = clamp(Number(this.config.heartbeatMs) || 30000, 15000, 120000)
      const pairingActive = this.pairing.active !== null && this.pairing.active.expiresAt > Date.now()
      const delay = this.lastError
        ? Math.min(60000, backoff)
        : pairingActive
          ? PAIRING_FAST_HB_MS
          : configured
      if (this.lastError) backoff = Math.min(60000, Math.round(backoff * 1.8))
      this.nextHeartbeatAt = new Date(Date.now() + delay).toISOString()
      await this.sleepOrKick(delay)
      if (Date.now() - started < 100) await sleep(50)
    }
  }

  sleepOrKick(ms) {
    return new Promise((resolve) => {
      let settled = false
      let onAbort = null
      const finish = () => {
        if (settled) return
        settled = true
        if (onAbort) this.abort?.signal.removeEventListener('abort', onAbort)
        this.kickResolve = null
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      this.kickResolve = finish
      if (this.abort?.signal) {
        onAbort = () => finish()
        this.abort.signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  kick() {
    this.kickRequested = true
    if (this.kickResolve) {
      const resolve = this.kickResolve
      this.kickResolve = null
      resolve()
    }
  }

  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.ensureEnrolled()
      await this.uploadDigest()
      const response = await this.heartbeat()
      await this.processCommands(response.commands ?? [])
      const processedPairings = await this.pairing.handleInvitations(response.pairings ?? [])
      if (processedPairings > 0) this.kickRequested = true
      const revoked = response.bindings?.revoked
      if (Array.isArray(revoked)) {
        for (const bindingId of revoked) {
          if (this.store.removeBinding(bindingId)) {
            this.log.warn(`[dsh-puppet] pairing revoked: ${bindingId}`)
          }
        }
      }
      this.setState('online')
      this.lastError = null
    } finally {
      this.ticking = false
    }
  }

  async ensureEnrolled() {
    if (this.store.state.serverAgentId) return
    const body = {
      role: 'agent',
      name: this.config.agentName,
      ed25519_pub: this.identity.ed.pub,
      x25519_pub: this.identity.x.pub,
      protocol: PROTOCOL_VERSION,
      ts: Date.now(),
      nonce: randomToken(16),
    }
    const response = await this.request('POST', '/v1/devices/enroll', body, { deviceId: '' })
    const deviceId = response.device_id ?? response.agent_id
    if (!deviceId) throw new Error('enrollment response did not include device_id')
    this.store.state.serverAgentId = deviceId
    this.store.saveState()
    this.log.info(`[dsh-puppet] enrolled as ${deviceId}`)
  }

  async uploadDigest() {
    const all = await this.adapter.listSessions()
    this.digest.count = all.length
    const metaKey = this.store.metaKey()
    const sealed = Boolean(metaKey)
    const epoch = sealed ? this.store.metaEpoch() : this.digest.epoch
    const window = all.slice(0, DIGEST_SESSIONS)

    let sessionRows
    if (sealed) {
      // 每会话只带最近 m 条消息；消息窗口按 updatedAt + 30s TTL 缓存，减少心跳开销。
      sessionRows = await Promise.all(
        window.map(async (session) => {
          const cached = this.messageCache.get(session.id)
          let messages
          if (cached && cached.updatedAt === session.updatedAt && Date.now() - cached.at < 30000) {
            messages = cached.messages
          } else {
            messages = await this.adapter.getSessionMessages(session.id, DIGEST_MESSAGES)
            this.messageCache.set(session.id, { updatedAt: session.updatedAt, at: Date.now(), messages })
          }
          return {
            id: session.id,
            title: session.title,
            running: session.running,
            updatedAt: session.updatedAt,
            origin: session.origin,
            parentId: session.parentId,
            archived: session.archived,
            ...(session.cwd ? {
              cwd: session.cwd,
              workspace: session.workspaceTitle || workspaceInfo(session.cwd).alias,
              workspace_type: workspaceInfo(session.cwd).type,
            } : {}),
            ...(messages.length ? { messages } : {}),
          }
        }),
      )
    } else {
      sessionRows = window.map((session) => ({
        id: session.id,
        running: session.running,
        updatedAt: session.updatedAt,
        origin: session.origin,
        parentId: session.parentId,
        archived: session.archived,
      }))
    }

    const payload = { mode: sealed ? 'sealed' : 'summary', epoch, sessions: sessionRows }
    const plain = Buffer.from(JSON.stringify(payload), 'utf8')
    const hash = sha256Hex(plain)

    // 增量提交：内容未变化时不重复上传（服务端保留旧 blob，控制端按 rev 判断）。
    if (hash === this.digest.hash) return

    this.digest.rev += 1
    this.digest.hash = hash
    this.digest.epoch = epoch

    const body = {
      epoch,
      rev: this.digest.rev,
      hash,
      count: this.digest.count,
      mode: sealed ? 'sealed' : 'summary',
    }
    if (sealed) {
      try {
        const key = unb64u(metaKey)
        const nonce = Buffer.from(randomToken(12), 'base64url').subarray(0, 12)
        const sealedValue = sealSymmetric(
          key,
          plain,
          Buffer.from(`digest|${this.agentId}|${epoch}|${this.digest.rev}`, 'utf8'),
          nonce,
        )
        body.blob = b64u(Buffer.concat([sealedValue.nonce, sealedValue.ct]))
      } catch (error) {
        this.log.warn(`[dsh-puppet] digest sealing failed: ${error.message}`)
        body.mode = 'summary'
        body.blob = b64u(plain)
      }
    } else {
      body.blob = b64u(plain)
    }
    try {
      await this.request('PUT', `/v1/agents/${encodeURIComponent(this.agentId)}/digest`, body)
    } catch (error) {
      if (!(error instanceof HttpError) || ![404, 405, 501].includes(error.status)) throw error
    }
  }

  async heartbeat() {
    this.seq += 1
    const acks = this.acks.splice(0)
    const sessions = await this.adapter.listSessions()
    const running = sessions.filter((session) => session.running).length
    const body = {
      v: 1,
      agent_id: this.agentId,
      boot_id: this.bootId,
      seq: this.seq,
      ts: Date.now(),
      presence: 'online',
      version: { agent: PLUGIN_VERSION, dsh: process.env.DSH_VERSION ?? '0.2.x', protocol: PROTOCOL_VERSION },
      caps: ['mailbox', 'snapshot', 'sig-v1', 'keep-awake'],
      limits: { max_cmd: 65536, max_result: 65536, max_streams: 0 },
      digest: {
        epoch: this.digest.epoch,
        rev: this.digest.rev,
        hash: this.digest.hash,
        count: sessions.length,
      },
      active: { running, tunnel: null },
      health: {
        cpu: loadavg()[0] ?? 0,
        mem: totalmem() > 0 ? 1 - freemem() / totalmem() : 0,
      },
      bindings: { count: this.store.bindings.length, epoch: 1 },
      acks: acks,
      resync: [],
    }
    let response
    try {
      response = await this.request('POST', '/v1/agent/hb', body)
    } catch (error) {
      this.acks.unshift(...acks)
      throw error
    }
    this.heartbeatCount += 1
    this.lastHeartbeatAt = new Date().toISOString()
    if (response.next_hb_ms) {
      this.config.heartbeatMs = clamp(Number(response.next_hb_ms), 15000, 120000)
    }
    return response
  }

  async processCommands(commands) {
    for (const command of commands) {
      const commandId = command.id ?? command.command_id
      const binding = this.store.bindingById(command.binding_id)
      if (!binding) {
        this.log.warn(`[dsh-puppet] command ${commandId} for unknown binding ${command.binding_id}`)
        this.acks.push({ command_id: commandId, state: 'error' })
        continue
      }
      let envelope
      try {
        envelope =
          typeof command.envelope === 'string'
            ? JSON.parse(unb64u(command.envelope).toString('utf8'))
            : command.envelope
      } catch (error) {
        this.log.warn(`[dsh-puppet] command ${commandId} envelope is not decodable: ${error.message}`)
        this.acks.push({ command_id: commandId, state: 'error' })
        continue
      }
      const cached = this.results.get(commandId)
      if (cached) {
        await this.postResult(commandId, cached.state, cached.envelope)
        continue
      }
      let opened
      try {
        opened = openCommandEnvelope({ envelope, identity: this.identity, binding, store: this.store })
      } catch (error) {
        this.log.warn(`[dsh-puppet] command ${commandId} rejected: ${error.message}`)
        this.store.audit('command-rejected', { commandId, reason: error.message })
        this.acks.push({ command_id: commandId, state: 'error' })
        continue
      }
      if (opened.duplicate) {
        this.acks.push({ command_id: commandId, state: 'done' })
        continue
      }
      const result = await this.execute(opened.payload, envelope, commandId)
      const state = result.ok ? 'done' : 'error'
      const sealed = sealResultEnvelope({
        identity: this.identity,
        binding,
        command: envelope,
        payload: result,
        store: this.store,
      })
      this.results.set(commandId, { state, envelope: sealed })
      if (this.results.size > 200) this.results.delete(this.results.keys().next().value)
      this.store.rememberMessage(envelope.mid, { commandId })
      await this.postResult(commandId, state, sealed)
      this.commandCount += 1
      this.lastCommandAt = new Date().toISOString()
      this.store.audit('command-executed', {
        commandId,
        type: opened.payload?.type,
        state,
        controller: binding.controller_id,
      })
    }
  }

  async execute(payload, envelope, commandId) {
    const type = payload?.type
    try {
      switch (type) {
        case 'agent.ping':
          return { ok: true, data: { pong: Date.now(), agent_time: new Date().toISOString() } }
        case 'session.prompt': {
          const data = await this.adapter.prompt({
            sessionId: String(payload.session_id ?? ''),
            text: String(payload.text ?? ''),
            commandId,
          })
          return { ok: true, data }
        }
        case 'session.cancel': {
          const data = await this.adapter.cancel(String(payload.session_id ?? ''))
          return { ok: true, data }
        }
        case 'session.rename': {
          const data = await this.adapter.rename(String(payload.session_id ?? ''), String(payload.title ?? ''))
          return { ok: true, data }
        }
        case 'session.archive': {
          const data = await this.adapter.archive(String(payload.session_id ?? ''))
          return { ok: true, data }
        }
        case 'session.create': {
          const data = await this.adapter.createSession({
            cwd: payload.cwd,
            title: payload.title,
            agentPreset: payload.preset,
          })
          return { ok: true, data }
        }
        case 'session.snapshot': {
          const data = this.snapshot.snapshot(String(payload.session_id ?? ''), Number(payload.after_seq ?? 0))
          return { ok: true, data }
        }
        case 'env.info':
          return { ok: true, data: this.adapter.environment() }
        case 'approval.respond':
          return { ok: true, data: await this.adapter.respondApproval(payload) }
        case 'question.respond':
          return { ok: true, data: await this.adapter.respondQuestion(payload) }
        default:
          return { ok: false, error: { code: 'unsupported', message: `unknown command type: ${String(type)}` } }
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error?.code ?? 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  async postResult(commandId, state, envelope) {
    await this.request('POST', `/v1/commands/${encodeURIComponent(commandId)}/result`, {
      state,
      envelope: b64u(JSON.stringify(envelope)),
    })
    this.acks.push({ command_id: commandId, state })
  }

  async createPairing() {
    await this.ensureEnrolled()
    const result = await this.pairing.create()
    this.kick()
    return result
  }

  async cancelPairing() {
    return this.pairing.cancel()
  }

  async testConnection() {
    await this.ensureEnrolled()
    const response = await this.heartbeat()
    return { ok: true, server_time: response.server_time ?? null, commands: response.commands?.length ?? 0 }
  }

  async request(method, path, body, { deviceId } = {}) {
    if (!this.config.relayUrl) throw new Error('relay URL is not configured')
    if (this.config.relayUrl.startsWith('http:') && !this.config.allowInsecureHttp) {
      throw new Error('plain HTTP relay is disabled by configuration')
    }
    const url = `${this.config.relayUrl}${path}`
    const parsed = new URL(url)
    const signedPath = parsed.pathname + parsed.search
    const text = body === undefined ? '' : JSON.stringify(body)
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: this.authHeader(method, signedPath, text, deviceId),
    }
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: text === '' ? undefined : text,
        signal: AbortSignal.timeout(15000),
      })
    } catch (error) {
      throw new Error(`cannot reach relay: ${error.message}`)
    }
    const raw = await response.text()
    let parsedBody
    try {
      parsedBody = raw ? JSON.parse(raw) : {}
    } catch {
      parsedBody = { raw }
    }
    if (!response.ok) {
      const code = parsedBody?.error?.code ?? parsedBody?.code ?? `http_${response.status}`
      const message = parsedBody?.error?.message ?? parsedBody?.message ?? raw.slice(0, 300)
      throw new HttpError(response.status, code, message)
    }
    return parsedBody
  }

  authHeader(method, path, bodyText, deviceId) {
    return authHeader({
      method,
      path,
      body: Buffer.from(bodyText, 'utf8'),
      identity: this.identity,
      deviceId: deviceId ?? this.agentId,
    })
  }
}

export { HttpError }
