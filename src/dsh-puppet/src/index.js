import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { DshAdapter } from './adapter.js'
import { ControlLog } from './log.js'
import { RemoteAgent } from './remote-agent.js'
import { SnapshotBuffer } from './snapshot.js'
import { Store } from './store.js'
import { WakeLock } from './wake.js'
import { registerRoutes } from './web.js'
import { PLUGIN_VERSION } from './util.js'

export const name = 'dsh-puppet'
export const inject = ['webServer', 'sessionController']

/**
 * DSH host plugin entry.
 *
 * Loads (or creates) the agent identity/config, starts the heartbeat loop, adds
 * the local setup page, and keeps the machine awake according to policy.
 */
export function apply(ctx, config = {}) {
  const store = new Store(config.root)
  const hadConfig = existsSync(store.configPath)
  store.load()
  const log = new ControlLog({ logger: ctx.logger })
  const snapshot = new SnapshotBuffer({ log })
  const adapter = new DshAdapter(ctx, store, log)
  const wake = new WakeLock({ dataDir: store.root, log })
  const agent = new RemoteAgent({ ctx, store, adapter, snapshot, wake, log })

  snapshot.attach(ctx)

  let wakeTimer = null
  let autoOpenTimer = null
  let disposed = false

  function applyWakeMode(mode = store.config.keepAwake) {
    if (wakeTimer) {
      clearInterval(wakeTimer)
      wakeTimer = null
    }
    wake.stop()
    if (!store.config.enabled || mode === 'off') {
      return
    }
    if (mode === 'always') {
      wake.start('always')
      return
    }
    if (mode !== 'task') {
      wake.stop()
      return
    }
    let idleTicks = 0
    const evaluate = async () => {
      if (disposed) return
      if (!store.config.enabled) {
        wake.stop()
        return
      }
      let running = snapshot.runningSessionIds().length > 0
      if (!running) {
        try {
          running = (await adapter.listSessions()).some((session) => session.running)
        } catch {
          running = false
        }
      }
      if (running) {
        idleTicks = 0
        wake.start('task')
      } else {
        idleTicks += 1
        if (idleTicks >= 3) wake.stop()
      }
    }
    evaluate().catch(() => {})
    wakeTimer = setInterval(() => evaluate().catch(() => {}), 5000)
    wakeTimer.unref?.()
  }

  function setupUrl() {
    try {
      const origin = ctx.webServer.getOrigin()
      const url = new URL('/puppet/setup', origin)
      const host = url.hostname
      const loopback = host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost'
      if (!loopback) url.searchParams.set('token', store.config.setupToken)
      return url.toString()
    } catch {
      const port = ctx.webServer.port
      return port ? `http://127.0.0.1:${port}/puppet/setup` : '/puppet/setup'
    }
  }

  function statusText() {
    const status = agent.status()
    return [
      `state: ${status.state}`,
      `relay: ${status.relayUrl || '(not set)'}`,
      `agent: ${status.agentId}`,
      `pairings: ${status.bindings}`,
      `wake: ${status.wake.active ? 'held' : 'released'} (${store.config.keepAwake})`,
      `last error: ${status.lastError ?? 'none'}`,
    ].join('\n')
  }

  ctx.effect(
    () =>
      registerRoutes({
        ctx,
        store,
        agent,
        wake,
        log,
        applyWakeMode,
      }),
    'dsh-puppet: setup routes',
  )

  let commands
  try {
    commands = ctx.get?.('commands')
  } catch {
    commands = undefined
  }
  if (commands?.register) {
    ctx.effect(
      () =>
        commands.register({
          name: 'puppet-settings',
          description: 'Open the Puppet setup page (relay URL, wake lock, pairings)',
          input: { hint: '[status]' },
          handler: async ({ rawInput } = {}) => {
            if (String(rawInput ?? '').trim() === 'status') {
              return { kind: 'success', text: statusText() }
            }
            const url = setupUrl()
            openBrowser(url, log)
            return { kind: 'success', text: `Opened Puppet settings:\n${url}` }
          },
        }),
      'dsh-puppet: /puppet-settings command',
    )
    ctx.effect(
      () =>
        commands.register({
          name: 'puppet-wake',
          description: 'Set the keep-awake mode: on, off, or task',
          input: { hint: '[on|off|task]' },
          handler: async ({ rawInput } = {}) => {
            const arg = String(rawInput ?? '').trim().toLowerCase()
            const mode = arg === 'on' || arg === 'always' ? 'always' : arg === 'off' ? 'off' : 'task'
            store.saveConfig({ keepAwake: mode })
            applyWakeMode(mode)
            return {
              kind: 'success',
              text: `keep-awake: ${mode} (${wake.status().active ? 'held' : 'released'})`,
            }
          },
        }),
      'dsh-puppet: /puppet-wake command',
    )
    log.info('[dsh-puppet] /puppet-settings and /puppet-wake commands registered')
  } else {
    log.warn('[dsh-puppet] commands service is unavailable; /puppet-settings will not be registered')
  }

  applyWakeMode(store.config.keepAwake)
  agent.start()

  if (store.config.autoOpenSetup && !store.config.relayUrl) {
    autoOpenTimer = setTimeout(() => {
      if (disposed) return
      if (store.config.relayUrl) return
      const url = setupUrl()
      log.warn(`[dsh-puppet] no relay URL configured; opening setup page: ${url}`)
      openBrowser(url, log)
    }, 1800)
    autoOpenTimer.unref?.()
  }

  if (!hadConfig) {
    log.info(`[dsh-puppet] first run; config created at ${store.configPath}`)
  }
  log.info(`[dsh-puppet] v${PLUGIN_VERSION} loaded; state=${agent.status().state}`)
  if (!store.config.relayUrl) {
    log.warn(`[dsh-puppet] set the relay URL in ${setupUrl()}`)
  }

  ctx.effect(
    () => () => {
      disposed = true
      if (wakeTimer) clearInterval(wakeTimer)
      if (autoOpenTimer) clearTimeout(autoOpenTimer)
      agent.stop()
      wake.stop()
      snapshot.dispose()
      log.info('[dsh-puppet] stopped')
    },
    'dsh-puppet: lifecycle',
  )
}

function openBrowser(url, log) {
  if (process.env.PUPPET_NO_OPEN === '1') return false
  try {
    const platform = process.platform
    const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch (error) {
    log.warn(`[dsh-puppet] could not open browser: ${error.message}`)
    return false
  }
}
