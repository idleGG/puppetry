import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
$parentPid = __PARENT__
Add-Type -Namespace Puppet -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
[Puppet.Power]::SetThreadExecutionState([uint32]2147483651) | Out-Null
try {
  while ($true) {
    if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 20
  }
} finally {
  [Puppet.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null
}
`

/**
 * Cross-platform "keep this PC awake" guard.
 *
 * Windows uses a long-running PowerShell process calling
 * SetThreadExecutionState (the same mechanism presentations use). macOS uses
 * caffeinate. Linux uses systemd-inhibit when available. The child is the
 * guard: if it dies, the OS request is released automatically.
 */
export class WakeLock {
  constructor({ dataDir, log }) {
    this.dataDir = dataDir
    this.log = log
    this.child = null
    this.active = false
    this.reason = null
    this.startedAt = null
    this.lastError = null
  }

  get platform() {
    return process.platform
  }

  status() {
    return {
      active: this.active,
      platform: this.platform,
      pid: this.child?.pid ?? null,
      reason: this.reason,
      startedAt: this.startedAt,
      lastError: this.lastError,
    }
  }

  start(reason = 'remote control') {
    if (this.active || this.child) return true
    this.lastError = null
    try {
      if (this.platform === 'win32') this.startWindows()
      else if (this.platform === 'darwin') this.startMac()
      else this.startLinux()
      this.active = true
      this.reason = reason
      this.startedAt = new Date().toISOString()
      this.log?.info?.(`[dsh-puppet] wake lock acquired (${reason})`)
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log?.warn?.(`[dsh-puppet] wake lock failed: ${this.lastError}`)
      return false
    }
  }

  startWindows() {
    mkdirSync(this.dataDir, { recursive: true })
    const scriptPath = join(this.dataDir, 'keep-awake.ps1')
    writeFileSync(scriptPath, WINDOWS_SCRIPT.replace('__PARENT__', String(process.pid)), { encoding: 'utf8' })
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: 'ignore' },
    )
    this.attach(child)
  }

  startMac() {
    // -d display sleep, -i idle sleep, -m disk sleep, -s system sleep (AC), -u user active
    const child = spawn('caffeinate', ['-dimsu'], { stdio: 'ignore' })
    this.attach(child)
  }

  startLinux() {
    const child = spawn(
      'systemd-inhibit',
      [
        '--what=idle:sleep',
        '--who=Puppet',
        '--why=Remote control session active',
        '--mode=block',
        'sleep',
        'infinity',
      ],
      { stdio: 'ignore' },
    )
    this.attach(child)
  }

  attach(child) {
    this.child = child
    child.once('error', (error) => {
      this.active = false
      this.child = null
      this.lastError = error.message
      this.log?.warn?.(`[dsh-puppet] wake lock process error: ${error.message}`)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.active = false
        this.child = null
        if (this.reason) {
          this.log?.info?.(
            `[dsh-puppet] wake lock released (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          )
        }
      }
    })
  }

  stop() {
    const child = this.child
    this.child = null
    this.active = false
    this.reason = null
    this.startedAt = null
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // Best effort: the OS releases the request when the process exits.
      }
    }
    if (child) this.log?.info?.('[dsh-puppet] wake lock stopped')
  }
}

export function wakeSupported() {
  return ['win32', 'darwin', 'linux'].includes(process.platform)
}

export function wakeScriptPath(dataDir) {
  const path = join(dataDir, 'keep-awake.ps1')
  return { path, exists: existsSync(path) }
}
