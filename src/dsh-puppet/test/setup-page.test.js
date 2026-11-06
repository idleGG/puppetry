import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSetupPage } from '../src/setup-page.js'

test('setup page contains the required controls', () => {
  const html = renderSetupPage({ version: '0.2.2' })
  for (const needle of [
    'Relay / API base URL',
    'Keep this PC awake',
    'Test connection',
    '/puppet-settings',
    'id="wakeModes"',
    'data-i18n="connection.relay"',
    'data-lang="zh"',
    '保持本机唤醒',
    'data-i18n="pair.title"',
    '生成 token',
    'id="pairStart"',
    'id="pairCancel"',
    'id="pairStatus"',
    'id="pairToken"',
    'id="copyToken"',
  ]) {
    assert.ok(html.includes(needle), `missing ${needle}`)
  }
  assert.ok(!html.includes('${'), 'template placeholders must be resolved')
})
