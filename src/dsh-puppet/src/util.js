import { createHash, randomBytes, randomUUID } from 'node:crypto'

export const PROTOCOL_VERSION = '1.0'
export const PLUGIN_VERSION = '0.3.0'
export const SUITE = 'X25519-HKDF-SHA256-CHACHA20POLY1305'
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Lower(buffer) {
  return base32(buffer).toLowerCase()
}

export function b64u(buffer) {
  return Buffer.from(buffer).toString('base64url')
}

export function unb64u(text) {
  return Buffer.from(String(text), 'base64url')
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest()
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function randomToken(bytes = 16) {
  return randomBytes(bytes).toString('base64url')
}

export function uuid() {
  return randomUUID()
}

export function nowMs() {
  return Date.now()
}

export function unixSeconds() {
  return Math.floor(Date.now() / 1000)
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Deterministic JSON for signing/AAD: sorted keys, no whitespace. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`
}
