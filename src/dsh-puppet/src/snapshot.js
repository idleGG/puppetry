/**
 * Per-session ring buffer for the Lite streaming fallback.
 *
 * DSH emits two useful live sources:
 *  - `agent/assistant-stream` for token deltas (text/reasoning)
 *  - `session/event` for durable turn/tool/message boundaries
 *
 * The buffer keeps a short, bounded tail so a controller can ask for
 * `session.snapshot` over the mailbox without a tunnel. Full Relay uses the
 * real subscription instead; this is deliberately a degraded path.
 */
export class SnapshotBuffer {
  constructor({ log } = {}) {
    this.log = log
    this.sessions = new Map()
    this.disposers = []
    this.maxEvents = 512
    this.maxBytes = 256 * 1024
    this.ttlMs = 10 * 60 * 1000
  }

  attach(ctx) {
    const onStream = (payload) => {
      try {
        this.onAssistantStream(payload)
      } catch (error) {
        this.log?.warn?.(`[dsh-puppet] snapshot stream handler failed: ${error.message}`)
      }
    }
    const onEvent = (session, event) => {
      try {
        this.onSessionEvent(session, event)
      } catch (error) {
        this.log?.warn?.(`[dsh-puppet] snapshot event handler failed: ${error.message}`)
      }
    }
    this.disposers.push(ctx.on('agent/assistant-stream', onStream, { global: true }))
    this.disposers.push(ctx.on('session/event', onEvent, { global: true }))
    const timer = setInterval(() => this.gc(), 60_000)
    timer.unref?.()
    this.disposers.push(() => clearInterval(timer))
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // Best effort.
      }
    }
    this.sessions.clear()
  }

  bucket(sessionId) {
    let bucket = this.sessions.get(sessionId)
    if (!bucket) {
      bucket = {
        sessionId,
        seq: 0,
        turnId: null,
        status: 'idle',
        events: [],
        bytes: 0,
        updatedAt: Date.now(),
      }
      this.sessions.set(sessionId, bucket)
    }
    return bucket
  }

  push(sessionId, type, data) {
    const bucket = this.bucket(sessionId)
    const event = { seq: bucket.seq + 1, type, data, at: Date.now() }
    bucket.seq += 1
    bucket.events.push(event)
    bucket.bytes += JSON.stringify(event).length
    bucket.updatedAt = Date.now()
    while (bucket.events.length > this.maxEvents || bucket.bytes > this.maxBytes) {
      const removed = bucket.events.shift()
      if (!removed) break
      bucket.bytes -= JSON.stringify(removed).length
    }
    return event
  }

  onAssistantStream({ agent, frame } = {}) {
    const sessionId = agent?.session?.id
    if (!sessionId || !frame) return
    const bucket = this.bucket(sessionId)
    if (frame.type === 'start') {
      bucket.turnId = String(frame.turn ?? bucket.turnId ?? '')
      bucket.status = 'running'
      return
    }
    if (frame.type === 'chunk') {
      const chunk = frame.chunk ?? {}
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        this.push(sessionId, 'assistant.delta', { text: chunk.text, turn_id: bucket.turnId })
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        this.push(sessionId, 'assistant.reasoning', { text: chunk.text, turn_id: bucket.turnId })
      }
    }
  }

  onSessionEvent(session, event) {
    const sessionId = session?.id
    if (!sessionId || !event) return
    const bucket = this.bucket(sessionId)
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start': {
        bucket.turnId = String(data.turn ?? '')
        bucket.status = 'running'
        this.push(sessionId, 'turn.start', { turn_id: bucket.turnId })
        break
      }
      case 'tool/call': {
        this.push(sessionId, 'tool.call', {
          turn_id: String(data.turn ?? ''),
          call_id: String(data.callId ?? ''),
          name: String(data.name ?? ''),
          arguments: preview(data.arguments, 2048),
        })
        break
      }
      case 'tool/result': {
        this.push(sessionId, 'tool.result', {
          turn_id: String(data.turn ?? ''),
          call_id: String(data.message?.source?.callId ?? data.message?.toolCallId ?? ''),
          status: data.error || data.message?.isError ? 'error' : 'ok',
          output: preview(contentText(data.message?.content), 2048),
          error: data.error?.reason ? String(data.error.reason) : undefined,
        })
        break
      }
      case 'turn/end': {
        const reason = data.reason?.kind ?? 'completed'
        bucket.status = reason === 'completed' ? 'idle' : 'error'
        this.push(sessionId, 'turn.end', {
          turn_id: String(data.turn ?? ''),
          status: bucket.status,
          reason: String(reason),
        })
        break
      }
      case 'assistant/message': {
        // Deltas already cover the live view. A final message is still useful
        // when a provider does not stream, so add it only when the turn has no
        // text delta yet.
        const text = contentText(data.message?.content)
        if (text && !bucket.events.some((item) => item.type === 'assistant.delta' && item.data.turn_id === String(data.turn))) {
          this.push(sessionId, 'assistant.delta', { text, turn_id: String(data.turn ?? '') })
        }
        break
      }
      default:
        break
    }
  }

  snapshot(sessionId, afterSeq = 0, limit = 200) {
    const bucket = this.sessions.get(sessionId)
    if (!bucket) return { turn_id: null, status: 'idle', events: [], next_seq: afterSeq, truncated: false }
    const events = bucket.events.filter((event) => event.seq > Number(afterSeq)).slice(0, limit)
    const nextSeq = events.at(-1)?.seq ?? Number(afterSeq)
    return {
      turn_id: bucket.turnId,
      status: bucket.status,
      events,
      next_seq: nextSeq,
      truncated: bucket.events.length > 0 && bucket.events[0].seq > Number(afterSeq) + 1,
    }
  }

  runningSessionIds() {
    const now = Date.now()
    return [...this.sessions.values()]
      .filter((bucket) => bucket.status === 'running' && now - bucket.updatedAt < 10 * 60 * 1000)
      .map((bucket) => bucket.sessionId)
  }

  gc() {
    const cutoff = Date.now() - this.ttlMs
    for (const [sessionId, bucket] of this.sessions) {
      if (bucket.updatedAt < cutoff && bucket.status !== 'running') this.sessions.delete(sessionId)
    }
  }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function preview(value, max) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}
