import { openAuth, sealAuth } from './crypto/hpke.js'
import { controllerIdFromPublic, identityKeys, keyId, signBytes, verifyBytes } from './keys.js'
import { SUITE, b64u, randomToken, sha256Hex, stableStringify, unixSeconds, unb64u, uuid } from './util.js'

export function authHeader({ method, path, body, identity, deviceId }) {
  const ts = String(unixSeconds())
  const nonce = randomToken(16)
  const hash = sha256Hex(body ?? Buffer.alloc(0))
  const message = `Puppetry1\n${method}\n${path}\n${hash}\n${ts}\n${nonce}`
  const signature = signBytes(Buffer.from(message, 'utf8'), identity)
  const device = deviceId ?? ''
  return `Puppetry1 device="${device}", ts="${ts}", nonce="${nonce}", sig="${b64u(signature)}"`
}

export function verifyAuthHeader({ header, method, path, body, edPub }) {
  const match = /^Puppetry1\s+(.+)$/u.exec(String(header ?? ''))
  if (!match) return false
  const fields = {}
  for (const part of match[1].split(',')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim().replace(/^"|"$/gu, '')
    fields[key] = value
  }
  if (!fields.ts || !fields.nonce || !fields.sig) return false
  if (Math.abs(unixSeconds() - Number(fields.ts)) > 300) return false
  const hash = sha256Hex(body ?? Buffer.alloc(0))
  const message = `Puppetry1\n${method}\n${path}\n${hash}\n${fields.ts}\n${fields.nonce}`
  return verifyBytes(Buffer.from(message, 'utf8'), unb64u(fields.sig), edPub)
}

export function envelopeHeader(envelope) {
  return {
    v: envelope.v,
    suite: envelope.suite,
    kind: envelope.kind,
    bid: envelope.bid,
    sid: envelope.sid,
    rid: envelope.rid,
    kid: envelope.kid,
    ctr: envelope.ctr,
    ts: envelope.ts,
    exp: envelope.exp,
    mid: envelope.mid,
    ...(envelope.ref === undefined ? {} : { ref: envelope.ref }),
  }
}

export function openCommandEnvelope({ envelope, identity, binding, store }) {
  if (envelope?.v !== 1) throw new Error('unsupported envelope version')
  if (envelope.suite !== SUITE) throw new Error('unsupported envelope suite')
  if (envelope.kind !== 'cmd') throw new Error('envelope is not a command')
  if (envelope.rid !== identity.agentId) throw new Error('envelope recipient mismatch')
  if (envelope.bid !== binding.binding_id) throw new Error('envelope binding mismatch')
  if (envelope.sid !== binding.controller_id) throw new Error('envelope sender mismatch')
  if (!Number.isInteger(envelope.ctr) || envelope.ctr < 1) throw new Error('invalid envelope counter')
  const now = Date.now()
  if (Number(envelope.exp) < now - 300000) throw new Error('command envelope expired')
  if (Number(envelope.ts) > now + 300000) throw new Error('command envelope timestamp is in the future')

  if (store.seenMessage(envelope.mid)) {
    return { duplicate: true, payload: null }
  }

  const info = Buffer.from(`puppetry1/${envelope.kind}/${envelope.bid}`, 'utf8')
  const aad = Buffer.from(stableStringify(envelopeHeader(envelope)), 'utf8')
  const keys = identityKeys(identity)
  const plaintext = openAuth({
    recipientPriv: keys.x.priv,
    senderPub: unb64u(binding.controller_x),
    enc: unb64u(envelope.enc),
    info,
    aad,
    ciphertext: unb64u(envelope.ct),
  })
  if (!store.acceptCounter(envelope.bid, envelope.kind, envelope.ctr)) {
    throw new Error('command counter replayed or out of order')
  }
  return { duplicate: false, payload: JSON.parse(plaintext.toString('utf8')) }
}

export function sealResultEnvelope({ identity, binding, command, payload, store }) {
  const header = {
    v: 1,
    suite: SUITE,
    kind: 'res',
    bid: binding.binding_id,
    sid: identity.agentId,
    rid: binding.controller_id,
    kid: keyId(unb64u(identity.ed.pub)),
    ctr: store.nextCounter(binding.binding_id, 'res'),
    ts: Date.now(),
    exp: Date.now() + 60 * 60 * 1000,
    mid: `res_${uuid()}`,
    ref: command.mid,
  }
  const info = Buffer.from(`puppetry1/res/${binding.binding_id}`, 'utf8')
  const aad = Buffer.from(stableStringify(header), 'utf8')
  const keys = identityKeys(identity)
  const sealed = sealAuth({
    recipientPub: unb64u(binding.controller_x),
    senderPriv: keys.x.priv,
    info,
    aad,
    plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
  })
  return {
    ...header,
    enc: b64u(sealed.enc),
    ct: b64u(sealed.ct),
  }
}

export function bindingPayload(record) {
  return {
    v: record.v ?? 1,
    binding_id: record.binding_id,
    agent_id: record.agent_id,
    agent_ed: record.agent_ed,
    agent_x: record.agent_x,
    controller_id: record.controller_id,
    controller_ed: record.controller_ed,
    controller_x: record.controller_x,
    scopes: record.scopes,
    created_at: record.created_at,
    expires_at: record.expires_at ?? null,
  }
}

export function signBindingPayload(record, identity) {
  return b64u(signBytes(Buffer.from(stableStringify(bindingPayload(record)), 'utf8'), identity))
}

export function verifyBindingRecord(record, identity) {
  if (!record || typeof record !== 'object') throw new Error('binding must be an object')
  if (record.agent_id !== identity.agentId) throw new Error('binding agent_id does not match this agent')
  if (!record.binding_id || typeof record.binding_id !== 'string') throw new Error('binding_id is required')
  if (!record.controller_id || !record.controller_ed || !record.controller_x) {
    throw new Error('controller identity is required')
  }
  const controllerEd = unb64u(record.controller_ed)
  if (controllerEd.length !== 32) throw new Error('controller_ed must be 32 bytes')
  if (unb64u(record.controller_x).length !== 32) throw new Error('controller_x must be 32 bytes')
  if (controllerIdFromPublic(controllerEd) !== record.controller_id) {
    throw new Error('controller_id does not match controller_ed')
  }
  if (!Array.isArray(record.scopes) || record.scopes.length === 0) throw new Error('scopes are required')
  const payload = Buffer.from(stableStringify(bindingPayload(record)), 'utf8')
  if (!record.controller_sig || !verifyBytes(payload, unb64u(record.controller_sig), controllerEd)) {
    throw new Error('controller signature is invalid')
  }
  if (record.agent_sig) {
    const agentEd = unb64u(identity.ed.pub)
    if (!verifyBytes(payload, unb64u(record.agent_sig), agentEd)) {
      throw new Error('agent signature is invalid')
    }
  } else {
    record.agent_sig = signBindingPayload(record, identity)
  }
  return record
}

/**
 * Controller-side helper used by tests and by a future controller SDK: seal one
 * command to an agent's X25519 key. The agent opens it with openCommandEnvelope.
 */
export function sealCommandEnvelope({
  controllerIdentity,
  agentId,
  agentX,
  binding,
  payload,
  ctr = 1,
  ttlMs = 10 * 60 * 1000,
}) {
  const header = {
    v: 1,
    suite: SUITE,
    kind: 'cmd',
    bid: binding.binding_id,
    sid: controllerIdentity.controllerId ?? controllerIdFromPublic(unb64u(controllerIdentity.ed.pub)),
    rid: agentId,
    kid: keyId(unb64u(controllerIdentity.ed.pub)),
    ctr,
    ts: Date.now(),
    exp: Date.now() + ttlMs,
    mid: `cmd_${uuid()}`,
  }
  const info = Buffer.from(`puppetry1/cmd/${binding.binding_id}`, 'utf8')
  const aad = Buffer.from(stableStringify(header), 'utf8')
  const keys = identityKeys(controllerIdentity)
  const sealed = sealAuth({
    recipientPub: unb64u(agentX),
    senderPriv: keys.x.priv,
    info,
    aad,
    plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
  })
  return { ...header, enc: b64u(sealed.enc), ct: b64u(sealed.ct) }
}

/** Controller-side helper: open one result sealed by the agent. */
export function openResultEnvelope({ envelope, controllerIdentity, agentX, binding }) {
  if (envelope?.kind !== 'res') throw new Error('envelope is not a result')
  if (envelope.bid !== binding.binding_id) throw new Error('result binding mismatch')
  if (envelope.rid !== (controllerIdentity.controllerId ?? controllerIdFromPublic(unb64u(controllerIdentity.ed.pub)))) {
    throw new Error('result recipient mismatch')
  }
  const info = Buffer.from(`puppetry1/res/${binding.binding_id}`, 'utf8')
  const aad = Buffer.from(stableStringify(envelopeHeader(envelope)), 'utf8')
  const keys = identityKeys(controllerIdentity)
  const plaintext = openAuth({
    recipientPriv: keys.x.priv,
    senderPub: unb64u(agentX),
    enc: unb64u(envelope.enc),
    info,
    aad,
    ciphertext: unb64u(envelope.ct),
  })
  return JSON.parse(plaintext.toString('utf8'))
}