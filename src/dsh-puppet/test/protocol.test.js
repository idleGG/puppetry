import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { controllerIdFromPublic, generateIdentity } from '../src/keys.js'
import {
  openCommandEnvelope,
  openResultEnvelope,
  sealCommandEnvelope,
  sealResultEnvelope,
  signBindingPayload,
  verifyBindingRecord,
} from '../src/protocol.js'
import { Store } from '../src/store.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'puppet-protocol-'))
  const store = new Store(root).load()
  const agent = store.identity
  const controller = generateIdentity()
  const controllerId = controllerIdFromPublic(Buffer.from(controller.ed.pub, 'base64url'))
  const binding = {
    v: 1,
    binding_id: `bd_${Date.now().toString(36)}`,
    agent_id: agent.agentId,
    agent_ed: agent.ed.pub,
    agent_x: agent.x.pub,
    controller_id: controllerId,
    controller_ed: controller.ed.pub,
    controller_x: controller.x.pub,
    scopes: ['session.prompt', 'session.read'],
    created_at: Date.now(),
  }
  binding.controller_sig = signBindingPayload(binding, controller)
  verifyBindingRecord(binding, agent)
  return { root, store, agent, controller, binding }
}

test('binding signatures and command/result envelopes round-trip', () => {
  const { root, store, agent, controller, binding } = fixture()
  try {
    const command = sealCommandEnvelope({
      controllerIdentity: controller,
      agentId: agent.agentId,
      agentX: agent.x.pub,
      binding,
      payload: { type: 'agent.ping', nonce: 'n1' },
    })
    const opened = openCommandEnvelope({ envelope: command, identity: agent, binding, store })
    assert.equal(opened.duplicate, false)
    assert.equal(opened.payload.type, 'agent.ping')
    store.rememberMessage(command.mid, { commandId: command.mid })

    const duplicate = openCommandEnvelope({ envelope: command, identity: agent, binding, store })
    assert.equal(duplicate.duplicate, true)

    const result = sealResultEnvelope({
      identity: agent,
      binding,
      command,
      payload: { ok: true, data: { pong: 1 } },
      store,
    })
    const openedResult = openResultEnvelope({
      envelope: result,
      controllerIdentity: controller,
      agentX: agent.x.pub,
      binding,
    })
    assert.deepEqual(openedResult, { ok: true, data: { pong: 1 } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a tampered command is rejected', () => {
  const { root, store, agent, controller, binding } = fixture()
  try {
    const command = sealCommandEnvelope({
      controllerIdentity: controller,
      agentId: agent.agentId,
      agentX: agent.x.pub,
      binding,
      payload: { type: 'agent.ping' },
    })
    command.ct = `${command.ct.slice(0, -4)}AAAA`
    assert.throws(() => openCommandEnvelope({ envelope: command, identity: agent, binding, store }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a binding with a mismatched controller id is rejected', () => {
  const { root, agent, controller } = fixture()
  try {
    const binding = {
      v: 1,
      binding_id: 'bd_bad',
      agent_id: agent.agentId,
      agent_ed: agent.ed.pub,
      agent_x: agent.x.pub,
      controller_id: 'ct_wrong',
      controller_ed: controller.ed.pub,
      controller_x: controller.x.pub,
      scopes: ['session.read'],
      created_at: Date.now(),
      controller_sig: 'AAAA',
    }
    assert.throws(() => verifyBindingRecord(binding, agent), /controller_id/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
