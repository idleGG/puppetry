/**
 * Small in-memory log ring for the setup page plus a bridge to ctx.logger.
 * Never write payloads or keys here: only lifecycle, counts, and error text.
 */
export class ControlLog {
  constructor({ logger, limit = 120 } = {}) {
    this.logger = logger
    this.entries = []
    this.limit = limit
  }

  add(level, message) {
    const entry = { at: new Date().toISOString(), level, message: String(message) }
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.shift()
    const target = this.logger?.[level]
    if (typeof target === 'function') target.call(this.logger, message)
    else if (level === 'error') console.error(message)
    else if (level === 'warn') console.warn(message)
  }

  info(message) {
    this.add('info', message)
  }

  warn(message) {
    this.add('warn', message)
  }

  error(message) {
    this.add('error', message)
  }

  tail(count = 40) {
    return this.entries.slice(-count)
  }
}
