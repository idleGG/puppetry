import { renderSetupPage } from './setup-page.js'
import { bindingPayload, verifyBindingRecord } from './protocol.js'
import { PLUGIN_VERSION } from './util.js'

const MAX_BODY = 256 * 1024

export function registerRoutes({ ctx, store, agent, wake, log, applyWakeMode }) {
  const base = '/puppet'
  const webServer = ctx.webServer
  const disposer = webServer.register({
    kind: 'prefix',
    path: base,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        log.error(`[dsh-puppet] setup route failed: ${error.message}`)
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: error.message } })
        else res.end()
      })
    },
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://local')
    const path = url.pathname
    if (path === base || path === `${base}/`) {
      res.writeHead(302, { location: `${base}/setup` })
      res.end()
      return
    }
    if (path === `${base}/setup`) {
      if (!guard(req, res, { mutating: false, url })) return
      sendHtml(res, renderSetupPage({ version: PLUGIN_VERSION, basePath: base }))
      return
    }
    if (path === `${base}/health`) {
      sendJson(res, 200, { ok: true, plugin: 'dsh-puppet', version: PLUGIN_VERSION, state: agent.status().state })
      return
    }
    if (path.startsWith(`${base}/api/`)) {
      const mutating = req.method !== 'GET' && req.method !== 'HEAD'
      if (!guard(req, res, { mutating, url })) return
      await api(req, res, path.slice(`${base}/api`.length), url)
      return
    }
    sendJson(res, 404, { error: { code: 'not_found', message: 'unknown puppet route' } })
  }

  function guard(req, res, { mutating, url }) {
    const loopback = isLoopback(req)
    if (!loopback) {
      const token = req.headers['x-puppet-setup-token'] ?? url.searchParams.get('token') ?? ''
      if (!store.config.setupToken || token !== store.config.setupToken) {
        sendJson(res, 403, { error: { code: 'forbidden', message: 'setup token required' } })
        return false
      }
    }
    if (mutating) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'POST required' } })
        return false
      }
      if (req.headers['x-puppet-setup'] !== '1') {
        sendJson(res, 403, { error: { code: 'forbidden', message: 'missing x-puppet-setup header' } })
        return false
      }
      const origin = req.headers.origin
      if (origin && !sameOrigin(origin, req.headers.host)) {
        sendJson(res, 403, { error: { code: 'forbidden', message: 'cross-origin setup write rejected' } })
        return false
      }
    }
    return true
  }

  async function api(req, res, action, url) {
    if (action === '/state' && req.method === 'GET') {
      sendJson(res, 200, statePayload(req))
      return
    }
    if (action === '/config' && req.method === 'POST') {
      const body = await readJson(req)
      const previousUrl = store.config.relayUrl
      const previousEnabled = store.config.enabled
      let config
      try {
        config = store.saveConfig(body)
      } catch (error) {
        sendJson(res, 400, { error: { code: 'bad_request', message: error.message } })
        return
      }
      log.info('[dsh-puppet] configuration saved from setup page')
      if (config.relayUrl !== previousUrl || config.enabled !== previousEnabled) agent.restart()
      sendJson(res, 200, { ok: true, config: store.publicConfig() })
      return
    }
    if (action === '/wake' && req.method === 'POST') {
      const body = await readJson(req)
      const mode = body.mode
      if (!['off', 'task', 'always'].includes(mode)) {
        sendJson(res, 400, { error: { code: 'bad_request', message: 'mode must be off, task, or always' } })
        return
      }
      store.saveConfig({ keepAwake: mode })
      applyWakeMode(mode)
      sendJson(res, 200, { ok: true, mode, wake: wake.status() })
      return
    }
    if (action === '/test' && req.method === 'POST') {
      try {
        const result = await agent.testConnection()
        sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: { code: error.code ?? 'unreachable', message: error.message } })
      }
      return
    }
    if (action === '/restart' && req.method === 'POST') {
      agent.restart()
      sendJson(res, 200, { ok: true })
      return
    }
    if (action === '/pairing' && req.method === 'POST') {
      try {
        const pairing = await agent.createPairing()
        sendJson(res, 200, { ok: true, ...pairing })
      } catch (error) {
        sendJson(res, 400, { error: { code: error.code ?? 'pairing_unavailable', message: error.message } })
      }
      return
    }
    if (action === '/pairing/cancel' && req.method === 'POST') {
      await agent.cancelPairing()
      sendJson(res, 200, { ok: true })
      return
    }
    if (action === '/binding' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const record = verifyBindingRecord(body.record, store.identity)
        if (!Array.isArray(record.scopes) || record.scopes.length === 0) throw new Error('scopes are required')
        store.addBinding({
          ...bindingPayload(record),
          agent_sig: record.agent_sig,
          controller_sig: record.controller_sig,
          ...(typeof body.meta_key === 'string' ? { meta_key: body.meta_key } : {}),
        })
        store.audit('binding-imported', { bindingId: record.binding_id, controller: record.controller_id })
        log.info(`[dsh-puppet] controller paired: ${record.controller_id}`)
        sendJson(res, 200, { ok: true, binding: { binding_id: record.binding_id } })
      } catch (error) {
        sendJson(res, 400, { error: { code: 'invalid_binding', message: error.message } })
      }
      return
    }
    if (action === '/binding/delete' && req.method === 'POST') {
      const body = await readJson(req)
      const removed = store.removeBinding(String(body.binding_id ?? ''))
      if (removed) {
        store.audit('binding-revoked', { bindingId: body.binding_id })
        log.info(`[dsh-puppet] controller pairing revoked: ${body.binding_id}`)
      }
      sendJson(res, 200, { ok: true, removed })
      return
    }
    sendJson(res, 404, { error: { code: 'not_found', message: `unknown setup action: ${action}` } })
  }

  function statePayload(req) {
    const loopback = isLoopback(req)
    return {
      version: PLUGIN_VERSION,
      config: store.publicConfig({ includeToken: loopback }),
      status: agent.status(),
      identity: {
        agentId: store.identity.agentId,
        ed: shortKey(store.identity.ed.pub),
        x: shortKey(store.identity.x.pub),
        publicKeys: { ed: store.identity.ed.pub, x: store.identity.x.pub },
      },
      bindings: store.bindings.map((binding) => ({
        binding_id: binding.binding_id,
        controller_id: binding.controller_id,
        scopes: binding.scopes,
        created_at: binding.created_at,
      })),
      wake: wake.status(),
      pairing: agent.pairing.status(),
      log: log.tail(60),
      setupUrl: `${base}/setup`,
    }
  }

  return disposer
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(origin, host) {
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('request body must be JSON'))
      }
    })
    req.on('error', reject)
  })
}

function shortKey(value) {
  if (typeof value !== 'string') return '—'
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value
}
