import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controllerIdFromPublic, generateIdentity, verifyBytes } from '../src/keys.js'
import { PairingManager } from '../src/pairing.js'
import { Store } from '../src/store.js'
import { bindingPayload, signBindingPayload } from '../src/protocol.js'
import { openAuth, sealBase } from '../src/crypto/hpke.js'
import { b64u, randomToken, sha256, stableStringify, unb64u } from '../src/util.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'puppet-pairing-'))
  const store = new Store(root).load()
  store.saveConfig({ relayUrl: 'http://127.0.0.1:8787' })
  const calls = []
  const agent = {
    agentId: store.identity.agentId,
    request: async (method, path, body) => {
      calls.push({ method, path, body })
      return {}
    },
  }
  const log = { info() {}, warn() {} }
  const pairing = new PairingManager({ store, agent, log })
  return { root, store, agent, pairing, calls }
}

function buildInvitation({ created, controller, scopes, proofOverride }) {
  const uri = new URL(created.uri)
  const offer = JSON.parse(unb64u(uri.searchParams.get('t')).toString('utf8'))
  const pid = offer.pid
  const psk = offer.psk
  const agentId = offer.agent_id
  const agentEd = offer.agent_ed
  const agentX = offer.agent_x
  const controllerId = controllerIdFromPublic(Buffer.from(controller.ed.pub, 'base64url'))
  const binding = {
    v: 1,
    binding_id: `bd_${randomToken(12)}`,
    agent_id: agentId,
    agent_ed: agentEd,
    agent_x: agentX,
    controller_id: controllerId,
    controller_ed: controller.ed.pub,
    controller_x: controller.x.pub,
    scopes,
    created_at: Date.now(),
    expires_at: null,
  }
  binding.controller_sig = signBindingPayload(binding, controller)
  const ts = Date.now()
  const nonce = randomToken(16)
  const proof =
    proofOverride ??
    b64u(
      createHmac('sha256', unb64u(psk))
        .update(
          Buffer.from(
            `puppetry1-pair\n${pid}\n${binding.controller_ed}\n${binding.controller_x}\n${ts}\n${nonce}`,
            'utf8',
          ),
        )
        .digest(),
    )
  const invitation = {
    v: 1,
    type: 'bind.request',
    pairing_id: pid,
    binding_id: binding.binding_id,
    agent_id: agentId,
    controller_id: controllerId,
    controller_ed: binding.controller_ed,
    controller_x: binding.controller_x,
    scopes,
    created_at: binding.created_at,
    expires_at: null,
    ts,
    nonce,
    proof,
    controller_sig: binding.controller_sig,
    exp: Date.now() + 5 * 60 * 1000,
  }
  const info = Buffer.from(`puppetry1/pair-request/${pid}`, 'utf8')
  const aad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.request', pid }), 'utf8'))
  const sealed = sealBase({
    recipientPub: unb64u(agentX),
    info,
    aad,
    plaintext: Buffer.from(stableStringify(invitation), 'utf8'),
  })
  return {
    pid,
    psk,
    agentId,
    agentX,
    agentEd,
    controllerId,
    binding,
    envelope: { enc: b64u(sealed.enc), ct: b64u(sealed.ct) },
  }
}

test('QR invitation binds the controller and seals the result', async () => {
  const { root, store, pairing, calls } = fixture()
  try {
    const created = await pairing.create()
    assert.match(created.uri, /^puppetry:\/\/pair\?/u)
    assert.match(created.svg, /<svg/u)
    const controller = generateIdentity()
    const invite = buildInvitation({
      created,
      controller,
      scopes: ['presence', 'session.list', 'session.read', 'session.prompt'],
    })
    await pairing.handleInvitations([
      { pairing_id: invite.pid, envelope: invite.envelope, exp: Date.now() + 60_000 },
    ])
    assert.equal(store.bindings.length, 1)
    assert.equal(store.bindings[0].controller_id, invite.controllerId)
    assert.ok(store.bindings[0].meta_key)
    assert.deepEqual(store.bindings[0].scopes, ['presence', 'session.list', 'session.read', 'session.prompt'])

    const resultCall = calls.find((call) => call.path.endsWith('/result'))
    assert.ok(resultCall)
    assert.equal(resultCall.body.state, 'bound')
    assert.ok(resultCall.body.envelope.enc)
    assert.ok(resultCall.body.envelope.ct)

    const info = Buffer.from(`puppetry1/pair-result/${invite.pid}`, 'utf8')
    const aad = sha256(Buffer.from(stableStringify({ v: 1, type: 'bind.result', pid: invite.pid }), 'utf8'))
    const opened = openAuth({
      recipientPriv: unb64u(controller.x.priv),
      senderPub: unb64u(invite.agentX),
      enc: unb64u(resultCall.body.envelope.enc),
      info,
      aad,
      ciphertext: unb64u(resultCall.body.envelope.ct),
    })
    const result = JSON.parse(opened.toString('utf8'))
    const { result_sig: sig, ...signed } = result
    assert.ok(
      verifyBytes(Buffer.from(stableStringify(signed)), unb64u(sig), unb64u(invite.agentEd)),
    )
    assert.equal(result.binding_id, store.bindings[0].binding_id)
    assert.equal(result.meta_key, store.bindings[0].meta_key)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('copy token and QR carry the same canonical pairing offer', async () => {
  const { root, pairing } = fixture()
  try {
    const created = await pairing.create()

    // Copy token: puppetry1:pair:<base64url canonical JSON>
    assert.match(created.token, /^puppetry1:pair:/u)
    const payload = created.token.slice('puppetry1:pair:'.length)
    const decoded = JSON.parse(unb64u(payload).toString('utf8'))
    assert.equal(decoded.v, 1)
    assert.equal(decoded.pid, created.pairing_id)
    assert.equal(decoded.relay, 'http://127.0.0.1:8787')
    assert.ok(decoded.psk)
    assert.ok(decoded.agent_id)
    assert.ok(decoded.agent_ed)
    assert.ok(decoded.agent_x)
    assert.ok(Number(decoded.exp) > Date.now())

    // QR URI wraps the exact same payload.
    const uri = new URL(created.uri)
    assert.equal(uri.protocol, 'puppetry:')
    assert.equal(uri.searchParams.get('t'), payload)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a wrong PSK proof is rejected without creating a binding', async () => {
  const { root, store, pairing, calls } = fixture()
  try {
    const created = await pairing.create()
    const controller = generateIdentity()
    const invite = buildInvitation({
      created,
      controller,
      scopes: ['presence', 'session.read'],
      proofOverride: b64u(Buffer.alloc(32, 7)),
    })
    await pairing.handleInvitations([{ pairing_id: invite.pid, envelope: invite.envelope }])
    assert.equal(store.bindings.length, 0)
    const resultCall = calls.find((call) => call.path.endsWith('/result'))
    assert.equal(resultCall.body.state, 'rejected')
    assert.match(resultCall.body.reason, /bad_proof/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
