import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'

test('store creates identity/config and persists edits', () => {
  const root = mkdtempSync(join(tmpdir(), 'puppet-store-'))
  try {
    const first = new Store(root).load()
    assert.match(first.identity.agentId, /^ag_/u)
    assert.equal(first.config.relayUrl, '')
    assert.ok(first.config.setupToken.length > 10)

    first.saveConfig({ relayUrl: 'http://127.0.0.1:8787/', heartbeatMs: 5000, keepAwake: 'always' })
    assert.equal(first.config.relayUrl, 'http://127.0.0.1:8787')
    assert.equal(first.config.heartbeatMs, 15000)
    assert.equal(first.config.keepAwake, 'always')

    const second = new Store(root).load()
    assert.equal(second.identity.agentId, first.identity.agentId)
    assert.equal(second.config.relayUrl, 'http://127.0.0.1:8787')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('store rejects bad relay URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'puppet-store-'))
  try {
    const store = new Store(root).load()
    assert.throws(() => store.saveConfig({ relayUrl: 'ftp://example.com' }), /http/u)
    assert.throws(() => store.saveConfig({ relayUrl: 'https://user:pass@example.com' }), /credentials/u)
    assert.throws(() => store.saveConfig({ keepAwake: 'sometimes' }), /keepAwake/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
