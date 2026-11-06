import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { generateIdentity } from './keys.js'
import { randomToken } from './util.js'

export const CONFIG_VERSION = 1

export function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function defaultRoot() {
  const override = process.env.DSH_PUPPET_HOME?.trim()
  if (override) return override
  const home = dshHome()
  return join(home, 'puppet')
}

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    relayUrl: '',
    agentName: hostname(),
    enabled: true,
    heartbeatMs: 30000,
    keepAwake: 'task',
    autoOpenSetup: true,
    allowInsecureHttp: true,
    setupToken: randomToken(24),
    allowedRoots: [],
    allowRemoteCreate: true,
    allowRemoteProjectCreate: false,
  }
}

export function normalizeRelayUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\/+$/u, '')
  if (trimmed === '') return ''
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('relay URL is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('relay URL must use http:// or https://')
  }
  if (url.username || url.password) throw new Error('relay URL must not contain credentials')
  if (url.pathname !== '/' && url.pathname !== '') {
    // A base path is allowed (shared hosting subdirectory), but query/hash are not.
  }
  if (url.search || url.hash) throw new Error('relay URL must not contain query or fragment')
  return url.toString().replace(/\/+$/u, '')
}

export function validateConfigPatch(patch, current) {
  const next = { ...current }
  if (patch.relayUrl !== undefined) next.relayUrl = normalizeRelayUrl(patch.relayUrl)
  if (patch.agentName !== undefined) {
    const name = String(patch.agentName).trim()
    if (name.length === 0) throw new Error('agent name must not be empty')
    if (name.length > 80) throw new Error('agent name is too long (max 80)')
    next.agentName = name
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled)
  if (patch.heartbeatMs !== undefined) {
    const ms = Number(patch.heartbeatMs)
    if (!Number.isFinite(ms)) throw new Error('heartbeat interval must be a number')
    next.heartbeatMs = Math.min(120000, Math.max(15000, Math.round(ms)))
  }
  if (patch.keepAwake !== undefined) {
    if (!['off', 'task', 'always'].includes(patch.keepAwake)) {
      throw new Error('keepAwake must be off, task, or always')
    }
    next.keepAwake = patch.keepAwake
  }
  if (patch.autoOpenSetup !== undefined) next.autoOpenSetup = Boolean(patch.autoOpenSetup)
  if (patch.allowInsecureHttp !== undefined) next.allowInsecureHttp = Boolean(patch.allowInsecureHttp)
  if (patch.allowRemoteCreate !== undefined) next.allowRemoteCreate = Boolean(patch.allowRemoteCreate)
  if (patch.allowRemoteProjectCreate !== undefined) {
    next.allowRemoteProjectCreate = Boolean(patch.allowRemoteProjectCreate)
  }
  if (patch.allowedRoots !== undefined) {
    if (!Array.isArray(patch.allowedRoots)) throw new Error('allowedRoots must be an array')
    next.allowedRoots = patch.allowedRoots
      .map((value) => String(value).trim())
      .filter(Boolean)
      .slice(0, 20)
  }
  return next
}

function atomicWriteJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  renameSync(temp, path)
  try {
    chmodSync(path, mode)
  } catch {
    // Windows only toggles the read-only bit; key material still lives under the user profile.
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export class Store {
  constructor(root = defaultRoot()) {
    this.root = root
    this.configPath = join(root, 'config.json')
    this.identityPath = join(root, 'identity.json')
    this.bindingsPath = join(root, 'bindings.json')
    this.statePath = join(root, 'state.json')
    this.auditPath = join(root, 'audit.log')
    this.config = defaultConfig()
    this.identity = null
    this.bindings = []
    this.state = { version: 1, digest: { epoch: 1, rev: 0, hash: '', count: 0 }, counters: {}, seen: {}, metaKey: null, metaEpoch: 0 }
  }

  load() {
    mkdirSync(this.root, { recursive: true })
    const loadedConfig = readJson(this.configPath, null)
    if (loadedConfig) {
      this.config = { ...defaultConfig(), ...loadedConfig }
      if (!this.config.setupToken) this.config.setupToken = randomToken(24)
    }
    const identityExists = existsSync(this.identityPath)
    this.identity = readJson(this.identityPath, null)
    if (identityExists && this.identity === null) {
      throw new Error('identity file is unreadable: ' + this.identityPath)
    }
    if (this.identity === null) this.identity = generateIdentity()
    const loadedBindings = readJson(this.bindingsPath, null)
    this.bindings = Array.isArray(loadedBindings?.bindings) ? loadedBindings.bindings : []
    const loadedState = readJson(this.statePath, null)
    if (loadedState) this.state = { ...this.state, ...loadedState }
    this.saveAll()
    return this
  }

  saveAll() {
    atomicWriteJson(this.configPath, this.config)
    atomicWriteJson(this.identityPath, this.identity)
    atomicWriteJson(this.bindingsPath, { version: 1, bindings: this.bindings })
    atomicWriteJson(this.statePath, this.state)
  }

  saveConfig(patch) {
    const next = validateConfigPatch(patch, this.config)
    this.config = next
    atomicWriteJson(this.configPath, this.config)
    return this.config
  }

  saveIdentity() {
    atomicWriteJson(this.identityPath, this.identity)
  }

  saveState() {
    atomicWriteJson(this.statePath, this.state)
  }

  addBinding(record) {
    const existing = this.bindings.find((item) => item.binding_id === record.binding_id)
    if (existing) throw new Error('binding already exists')
    this.bindings.push(record)
    atomicWriteJson(this.bindingsPath, { version: 1, bindings: this.bindings })
  }

  removeBinding(bindingId) {
    const before = this.bindings.length
    this.bindings = this.bindings.filter((item) => item.binding_id !== bindingId)
    if (before !== this.bindings.length) {
      atomicWriteJson(this.bindingsPath, { version: 1, bindings: this.bindings })
      return true
    }
    return false
  }

  bindingById(bindingId) {
    return this.bindings.find((item) => item.binding_id === bindingId)
  }

  /**
   * Agent-level metadata key (mk, §5.4). One key per agent (per epoch) is shared
   * by every binding so that the sealed session digest is decryptable by all
   * controllers, not just the first one. Rotate on revocation (future work).
   */
  ensureMetaKey() {
    if (!this.state.metaKey) {
      this.state.metaKey = randomToken(32)
      this.state.metaEpoch = 1
      this.saveState()
    }
    return this.state.metaKey
  }

  metaKey() {
    return this.state.metaKey ?? null
  }

  metaEpoch() {
    return this.state.metaEpoch ?? 1
  }

  bindingForController(controllerId) {
    return this.bindings.find((item) => item.controller_id === controllerId)
  }

  nextCounter(bindingId, kind) {
    const key = `${bindingId}:${kind}`
    const next = (this.state.counters[key] ?? 0) + 1
    this.state.counters[key] = next
    this.saveState()
    return next
  }

  acceptCounter(bindingId, kind, counter) {
    const key = `${bindingId}:${kind}`
    const last = this.state.counters[key] ?? 0
    if (counter <= last) return false
    this.state.counters[key] = counter
    this.saveState()
    return true
  }

  seenMessage(mid) {
    return this.state.seen?.[mid] !== undefined
  }

  rememberMessage(mid, value) {
    if (!this.state.seen || typeof this.state.seen !== 'object') this.state.seen = {}
    this.state.seen[mid] = { at: Date.now(), ...value }
    const entries = Object.entries(this.state.seen)
    if (entries.length > 500) {
      entries.sort((a, b) => a[1].at - b[1].at)
      for (const [key] of entries.slice(0, entries.length - 500)) delete this.state.seen[key]
    }
    this.saveState()
  }

  audit(event, detail = {}) {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail })
      writeFileSync(this.auditPath, `${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 })
    } catch {
      // Auditing must never break the control loop.
    }
  }

  publicConfig({ includeToken = false } = {}) {
    const { setupToken, ...rest } = this.config
    return includeToken ? { ...rest, setupToken } : rest
  }
}
