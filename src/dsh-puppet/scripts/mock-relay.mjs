import http from 'node:http'
import fs from 'node:fs'
import { agentIdFromPublic } from '../src/keys.js'

const PORT = Number(process.env.MOCK_PORT ?? 8787)
const LOG = process.env.MOCK_LOG ?? '_mock-relay.log'
const state = {
  lastHb: null,
  digest: null,
  commands: [],
  results: new Map(),
  enrollments: [],
  pairings: new Map(),
}

function log(line) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      json(res, 200, { ok: true, service: 'mock-relay' })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/devices/enroll') {
      const payload = await body(req)
      const deviceId = agentIdFromPublic(Buffer.from(payload.ed25519_pub, 'base64url'))
      state.enrollments.push({ deviceId, at: Date.now(), name: payload.name })
      log(`enroll ${deviceId} ${payload.name}`)
      json(res, 201, { device_id: deviceId })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/agent/hb') {
      const payload = await body(req)
      state.lastHb = { ...payload, auth: req.headers.authorization, at: Date.now() }
      const commands = state.commands.splice(0)
      const pairings = [...state.pairings.values()]
        .filter((p) => p.agent_id === payload.agent_id && p.state === 'invited' && p.exp > Date.now())
        .map((p) => ({ pairing_id: p.pairing_id, envelope: p.invitation, exp: p.exp }))
      log(`hb ${payload.agent_id} seq=${payload.seq} commands=${commands.length} pairings=${pairings.length}`)
      json(res, 200, { v: 1, server_time: Date.now(), next_hb_ms: 30000, commands, pairings })
      return
    }
    if (req.method === 'PUT' && /^\/v1\/agents\/[^/]+\/digest$/u.test(url.pathname)) {
      state.digest = await body(req)
      log(`digest ${url.pathname} rev=${state.digest.rev} count=${state.digest.count}`)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && /^\/v1\/commands\/[^/]+\/result$/u.test(url.pathname)) {
      const commandId = decodeURIComponent(url.pathname.split('/')[3])
      const payload = await body(req)
      state.results.set(commandId, payload)
      log(`result ${commandId} state=${payload.state}`)
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/pairings') {
      const payload = await body(req)
      state.pairings.set(payload.pairing_id, { ...payload, state: 'waiting', created_at: Date.now() })
      log('pairing created ' + payload.pairing_id + ' agent=' + payload.agent_id)
      json(res, 201, { pairing_id: payload.pairing_id, exp: payload.exp, state: 'waiting' })
      return
    }
    const pairingMatch = /^\/v1\/pairings\/([^/]+)(\/invitation|\/result|\/cancel)?$/u.exec(url.pathname)
    if (pairingMatch) {
      const pairingId = decodeURIComponent(pairingMatch[1])
      const action = pairingMatch[2] ?? ''
      const pairing = state.pairings.get(pairingId)
      if (!pairing) {
        json(res, 404, { error: { code: 'pairing_not_found' } })
        return
      }
      if (req.method === 'GET' && action === '') {
        const commit = req.headers['x-puppetry-pairing-commit'] ?? url.searchParams.get('commit')
        if (commit && commit !== pairing.psk_commit) {
          json(res, 403, { error: { code: 'bad_pairing_commit' } })
          return
        }
        json(res, 200, {
          pairing_id: pairing.pairing_id,
          state: pairing.state,
          exp: pairing.exp,
          ...(pairing.result ? { result: pairing.result } : {}),
        })
        return
      }
      if (req.method === 'POST' && action === '/invitation') {
        const payload = await body(req)
        if (pairing.state !== 'waiting') {
          json(res, 409, { error: { code: 'pairing_not_waiting' } })
          return
        }
        if (pairing.exp <= Date.now()) {
          pairing.state = 'expired'
          json(res, 410, { error: { code: 'pairing_expired' } })
          return
        }
        if (!payload.psk_commit || payload.psk_commit !== pairing.psk_commit) {
          json(res, 403, { error: { code: 'bad_pairing_commit' } })
          return
        }
        pairing.invitation = payload.envelope
        pairing.state = 'invited'
        log('pairing invited ' + pairingId)
        json(res, 200, { ok: true, state: pairing.state })
        return
      }
      if (req.method === 'POST' && action === '/result') {
        const payload = await body(req)
        pairing.result = payload
        pairing.state = payload.state === 'bound' ? 'bound' : 'rejected'
        log('pairing result ' + pairingId + ' state=' + payload.state)
        json(res, 200, { ok: true, state: pairing.state })
        return
      }
      if (req.method === 'POST' && action === '/cancel') {
        pairing.state = 'cancelled'
        json(res, 200, { ok: true })
        return
      }
      json(res, 405, { error: { code: 'method_not_allowed' } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/debug/command') {
      const payload = await body(req)
      state.commands.push(payload)
      log(`queued ${payload.id}`)
      json(res, 200, { ok: true, queued: payload.id })
      return
    }
    if (req.method === 'GET' && url.pathname === '/debug/state') {
      json(res, 200, {
        enrollments: state.enrollments,
        lastHb: state.lastHb,
        digest: state.digest,
        results: Object.fromEntries(state.results),
        queued: state.commands,
        pairings: Object.fromEntries(state.pairings),
      })
      return
    }
    json(res, 404, { error: { code: 'not_found' } })
  } catch (error) {
    log(`error ${error.stack}`)
    json(res, 500, { error: { code: 'internal', message: error.message } })
  }
})

server.listen(PORT, '127.0.0.1', () => log(`listening on http://127.0.0.1:${PORT}`))
