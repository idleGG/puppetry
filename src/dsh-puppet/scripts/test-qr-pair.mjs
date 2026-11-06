import fs from 'node:fs'
import { createHmac } from 'node:crypto'
import {
  controllerIdFromPublic,
  generateIdentity,
  verifyBytes,
} from '../src/keys.js'
import { openResultEnvelope, sealCommandEnvelope, signBindingPayload } from '../src/protocol.js'
import { openAuth, sealBase } from '../src/crypto/hpke.js'
import { b64u, randomToken, sha256, stableStringify, unb64u } from '../src/util.js'

const setupBase = process.env.SETUP_BASE ?? 'http://127.0.0.1:3000'
const mockBase = process.env.MOCK_BASE ?? 'http://127.0.0.1:8787'
const OUT = process.env.OUT ?? '_qr-pair-result.txt'

function write(value) {
  fs.writeFileSync(OUT, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function request(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { raw: text }
  }
  if (!response.ok) throw new Error(`${url} -> ${response.status}: ${text}`)
  return body
}

try {
  write('creating pairing window')
  const created = await request(`${setupBase}/puppet/api/pairing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-puppet-setup': '1' },
    body: '{}',
  })
  const uri = new URL(created.uri)
  const payload = uri.searchParams.get('t')
  if (!payload) throw new Error('QR URI is missing t token')
  const offer = JSON.parse(unb64u(payload).toString('utf8'))
  const pskill = offer.psk
  const pid = offer.pid
  const aid = offer.agent_id
  const aed = offer.agent_ed
  const ax = offer.agent_x
  if (!pskill || !pid || !aid || !aed || !ax) throw new Error('QR offer is missing fields')

  const controller = generateIdentity()
  const controllerId = controllerIdFromPublic(Buffer.from(controller.ed.pub, 'base64url'))
  const binding = {
    v: 1,
    binding_id: `bd_${randomToken(12)}`,
    agent_id: aid,
    agent_ed: aed,
    agent_x: ax,
    controller_id: controllerId,
    controller_ed: controller.ed.pub,
    controller_x: controller.x.pub,
    scopes: ['presence', 'session.list', 'session.read', 'session.prompt', 'env.read'],
    created_at: Date.now(),
    expires_at: null,
  }
  binding.controller_sig = signBindingPayload(binding, controller)

  const ts = Date.now()
  const nonce = randomToken(16)
  const proof = createHmac('sha256', unb64u(pskill))
    .update(Buffer.from(`puppetry1-pair\n${pid}\n${binding.controller_ed}\n${binding.controller_x}\n${ts}\n${nonce}`, 'utf8'))
    .digest()
  const invitation = {
    v: 1,
    type: 'bind.request',
    pairing_id: pid,
    binding_id: binding.binding_id,
    agent_id: aid,
    controller_id: controllerId,
    controller_ed: binding.controller_ed,
    controller_x: binding.controller_x,
    scopes: binding.scopes,
    created_at: binding.created_at,
    expires_at: null,
    ts,
    nonce,
    proof: b64u(proof),
    controller_sig: binding.controller_sig,
    exp: Date.now() + 5 * 60 * 1000,
  }
  const info = Buffer.from(`puppetry1/pair-request/${pid}`, 'utf8')
  const aad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.request', pid }), 'utf8'))
  const sealed = sealBase({
    recipientPub: unb64u(ax),
    info,
    aad,
    plaintext: Buffer.from(stableStringify(invitation), 'utf8'),
  })
  const commit = b64u(sha256(unb64u(pskill)))
  await request(`${mockBase}/v1/pairings/${encodeURIComponent(pid)}/invitation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      psk_commit: commit,
      envelope: { enc: b64u(sealed.enc), ct: b64u(sealed.ct) },
    }),
  })
  write('invitation submitted: ' + pid)

  let pairing = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    pairing = await request(`${mockBase}/v1/pairings/${encodeURIComponent(pid)}`, {
      headers: { 'x-puppetry-pairing-commit': commit },
    })
    if (pairing.state === 'bound' || pairing.state === 'rejected') break
  }
  if (!pairing || pairing.state !== 'bound') {
    throw new Error(`pairing did not bind: ${JSON.stringify(pairing)}`)
  }

  const resultInfo = Buffer.from(`puppetry1/pair-result/${pid}`, 'utf8')
  const resultAad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.result', pid }), 'utf8'))
  const opened = openAuth({
    recipientPriv: unb64u(controller.x.priv),
    senderPub: unb64u(ax),
    enc: unb64u(pairing.result.envelope.enc),
    info: resultInfo,
    aad: resultAad,
    ciphertext: unb64u(pairing.result.envelope.ct),
  })
  const result = JSON.parse(opened.toString('utf8'))
  const { result_sig: resultSig, ...signed } = result
  const verified = verifyBytes(Buffer.from(stableStringify(signed)), unb64u(resultSig), unb64u(aed))
  if (!verified) throw new Error('agent result signature is invalid')

  const command = sealCommandEnvelope({
    controllerIdentity: controller,
    agentId: aid,
    agentX: ax,
    binding: { binding_id: result.binding_id },
    payload: { type: 'agent.ping', nonce: 'qr-pair-test' },
    ctr: 1,
  })
  await request(`${mockBase}/debug/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: command.mid, binding_id: result.binding_id, envelope: command }),
  })
  let commandResult = null
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const debug = await request(`${mockBase}/debug/state`)
    if (debug.results[command.mid]) {
      commandResult = debug.results[command.mid]
      break
    }
  }
  if (!commandResult) throw new Error('agent.ping result did not arrive')
  const openedResult = openResultEnvelope({
    envelope:
      typeof commandResult.envelope === 'string'
        ? JSON.parse(Buffer.from(commandResult.envelope, 'base64url').toString('utf8'))
        : commandResult.envelope,
    controllerIdentity: controller,
    agentX: ax,
    binding: { binding_id: result.binding_id },
  })
  write({
    ok: true,
    pairing_id: pid,
    binding_id: result.binding_id,
    controller_id: controllerId,
    scopes: result.scopes,
    meta_key_present: typeof result.meta_key === 'string' && result.meta_key.length > 10,
    result_signature: verified,
    command_result: openedResult,
  })
} catch (error) {
  write(`ERR ${error.stack}`)
  process.exitCode = 1
}
