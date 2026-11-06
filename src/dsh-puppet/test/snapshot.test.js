import test from 'node:test'
import assert from 'node:assert/strict'
import { SnapshotBuffer } from '../src/snapshot.js'

test('snapshot buffer merges stream deltas and durable boundaries', () => {
  const buffer = new SnapshotBuffer()
  const session = { id: 'ses_1' }
  buffer.onSessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
  buffer.onAssistantStream({
    agent: { session },
    frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'hello' } },
  })
  buffer.onAssistantStream({
    agent: { session },
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'think' } },
  })
  buffer.onSessionEvent(session, {
    type: 'tool/call',
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
  })
  buffer.onSessionEvent(session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } },
  })
  buffer.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const snapshot = buffer.snapshot('ses_1', 0)
  assert.equal(snapshot.turn_id, '1')
  assert.equal(snapshot.status, 'idle')
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ['turn.start', 'assistant.delta', 'assistant.reasoning', 'tool.call', 'tool.result', 'turn.end'],
  )
  assert.equal(buffer.runningSessionIds().length, 0)
})

test('snapshot applies after_seq and reports gaps', () => {
  const buffer = new SnapshotBuffer()
  for (let i = 0; i < 10; i += 1) {
    buffer.onSessionEvent({ id: 'ses_2' }, { type: 'turn/start', data: { turn: i + 1 } })
  }
  const page = buffer.snapshot('ses_2', 7, 2)
  assert.deepEqual(page.events.map((event) => event.seq), [8, 9])
  assert.equal(page.next_seq, 9)
  assert.equal(page.truncated, false)
})
