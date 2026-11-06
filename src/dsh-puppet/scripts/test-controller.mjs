import fs from 'node:fs'
import { generateIdentity, controllerIdFromPublic } from '../src/keys.js'
import {
  openResultEnvelope,
  sealCommandEnvelope,
  signBindingPayload,
} from '../src/protocol.js'

const setupBase = process.env.SETUP_BASE ?? 'http://127.0.0.1:3000'
const mockBase = process.env.MOCK_BASE ?? 'http://127.0.0.1:8787'
const OUT = process.env.OUT ?? '_controller-result.txt'

function write(value) {
  fs.writeFileSync(OUT, typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function request(url, options = {}) {
  let response
  try {
    response = await fetch(url, options)
  } catch (error) {
    throw new Error(url + ': ' + error.message + (error.cause ? ' / ' + error.cause.message : ''))
  }
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  if (!response.ok) throw new Error(`${url} -> ${response.status}: ${text}`)
  return body
}

try {
  write('started')
  const state = await request(`${setupBase}/puppet/api/state`)
  const agentId = state.status.agentId
  const agentX = state.identity.publicKeys.x
  const agentEd = state.identity.publicKeys.ed
  const controller = generateIdentity()
  controller.controllerId = controllerIdFromPublic(Buffer.from(controller.ed.pub, 'base64url'))
  const binding = {
    v: 1,
    binding_id: `bd_${Date.now().toString(36)}`,
    agent_id: agentId,
    agent_ed: agentEd,
    agent_x: agentX,
    controller_id: controller.controllerId,
    controller_ed: controller.ed.pub,
    controller_x: controller.x.pub,
    scopes: ['presence', 'session.list', 'session.read', 'session.prompt', 'env.read', 'approval.respond'],
    created_at: Date.now(),
  }
  binding.controller_sig = signBindingPayload(binding, controller)

  await request(`${setupBase}/puppet/api/binding`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-puppet-setup': '1' },
    body: JSON.stringify({ record: binding }),
  })

  const command = sealCommandEnvelope({
    controllerIdentity: controller,
    agentId,
    agentX,
    binding,
    payload:
      (process.env.TEST_TYPE ?? 'agent.ping') === 'env.info'
        ? { type: 'env.info' }
        : (process.env.TEST_TYPE ?? 'agent.ping') === 'session.create'
          ? {
              type: 'session.create',
              cwd: process.env.TEST_CWD ?? 'D:/Users/lfgsu/Documents/deepseek-harness/default-workspace',
              title: 'Remote control test',
            }
          : (process.env.TEST_TYPE ?? 'agent.ping') === 'session.prompt'
            ? {
                type: 'session.prompt',
                session_id: process.env.TEST_SESSION,
                text: process.env.TEST_TEXT ?? 'Reply with exactly: remote-ok',
              }
            : (process.env.TEST_TYPE ?? 'agent.ping') === 'session.snapshot'
              ? {
                  type: 'session.snapshot',
                  session_id: process.env.TEST_SESSION,
                  after_seq: Number(process.env.TEST_AFTER ?? 0),
                }
              : { type: 'agent.ping', nonce: 'integration-1' },
    ctr: 1,
  })
  const commandId = command.mid
  write(`queued ${commandId} ${binding.binding_id}`)
  await request(`${mockBase}/debug/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: commandId, binding_id: binding.binding_id, envelope: command }),
  })

  let result = null
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const debug = await request(`${mockBase}/debug/state`)
    if (debug.results[commandId]) {
      result = debug.results[commandId]
      break
    }
  }
  if (!result) throw new Error('no result within 30s')
  const resultEnvelope = typeof result.envelope === 'string'
    ? JSON.parse(Buffer.from(result.envelope, 'base64url').toString('utf8'))
    : result.envelope
  const opened = openResultEnvelope({
    envelope: resultEnvelope,
    controllerIdentity: controller,
    agentX,
    binding,
  })
  write({
    ok: true,
    commandId,
    bindingId: binding.binding_id,
    controllerId: controller.controllerId,
    resultState: result.state,
    payload: opened,
    heartbeatSeen: Boolean((await request(`${mockBase}/debug/state`)).lastHb),
  })
} catch (error) {
  write(`ERR ${error.stack}`)
  process.exitCode = 1
}
