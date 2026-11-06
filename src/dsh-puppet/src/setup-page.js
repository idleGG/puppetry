/**
 * Self-contained local setup page. Served by the host plugin on the DSH web
 * server, so it works in the desktop app and in `dsh web` without adding a
 * client-side bundle.
 *
 * The page ships both English and Simplified Chinese dictionaries. It follows
 * the browser language on first visit, remembers an explicit choice in
 * localStorage, and swaps every static/dynamic label in place.
 */

const MESSAGES = {
  en: {
    title: 'Puppet',
    'header.subtitle': 'DSH remote control agent',
    'header.runtime': 'runs inside this DeepSeek Harness',
    'lang.label': 'Language',
    'state.loading': 'loading',
    'state.unreachable': 'unreachable',
    'state.online': 'online',
    'state.connecting': 'connecting',
    'state.unconfigured': 'unconfigured',
    'state.error': 'error',
    'state.disabled': 'disabled',
    'state.stopped': 'stopped',
    'state.unknown': 'unknown',
    'banner.unconfigured': 'This agent is not connected yet. Set your relay / API base URL below, then save.',
    'pair.title': 'Pair a controller',
    'pair.hint': 'choose a pairing method',
    'pair.method.qr': 'Scan QR code',
    'pair.method.token': 'Copy token',
    'pair.empty': 'No pairing code shown.',
    'pair.show': 'Generate token',
    'pair.cancel': 'Cancel',
    'pair.copy': 'Copy link',
    'pair.link': 'Pairing link (contains a one-time secret)',
    'pair.step1': 'Click Generate token, then scan the code with the Puppeteer App or copy the token.',
    'pair.step2': 'The controller sends its identity back in the next heartbeat, encrypted end to end.',
    'pair.step3': 'The code expires in 5 minutes and can be used once.',
    'pair.expires': 'Expires in {seconds}s',
    'pair.bound': 'Controller paired',
    'pair.failed': 'Could not create a pairing code',
    'pair.copied': 'Pairing link copied',
    'pair.tokenHint': 'Copy this token into the Puppeteer App. It is the QR code content in text form.',
    'pair.tokenShow': 'Generate token',
    'pair.tokenLabel': 'Pairing token (base64url JSON)',
    'pair.tokenCopy': 'Copy token',
    'pair.tokenCopied': 'Pairing token copied',
    'connection.title': 'Connection',
    'connection.hint': 'where this PC reports to',
    'connection.relay': 'Relay / API base URL',
    'connection.relayPlaceholder': 'https://example.com/thread  or  http://192.168.1.10:8787',
    'connection.relayHelp': 'The Lite server is plain HTTP + PHP/MySQL; the full relay is a WSS service. Both use <code>/v1/...</code> under this base.',
    'connection.name': "This computer's name",
    'connection.heartbeat': 'Heartbeat interval',
    'connection.seconds15': '15 seconds',
    'connection.seconds30': '30 seconds',
    'connection.seconds60': '60 seconds',
    'connection.minutes2': '2 minutes',
    'connection.control': 'Control',
    'connection.enabled': 'Enabled',
    'connection.disabled': 'Disabled',
    'connection.save': 'Save & reconnect',
    'connection.test': 'Test connection',
    'connection.restart': 'Restart loop',
    'wake.title': 'Keep this PC awake',
    'wake.off': 'Off',
    'wake.task': 'While a task runs',
    'wake.always': 'Always',
    'wake.lock': 'Wake lock',
    'wake.mechanism': 'Mechanism',
    'wake.since': 'Since',
    'wake.held': 'held',
    'wake.released': 'released',
    'wake.help': 'Windows uses SetThreadExecutionState, macOS uses caffeinate, Linux uses systemd-inhibit. The lock is released when the plugin stops or the helper exits.',
    'platform.win32': 'Windows',
    'platform.darwin': 'macOS',
    'platform.linux': 'Linux',
    'identity.title': 'Identity & pairings',
    'identity.agentId': 'Agent ID',
    'identity.localId': 'Local ID',
    'identity.ed': 'Ed25519',
    'identity.x': 'X25519',
    'identity.controllers': 'Paired controllers',
    'identity.peers': 'E2EE peers',
    'identity.empty': 'No controller paired yet.',
    'identity.import': 'Import a pairing record (JSON)',
    'identity.importButton': 'Import pairing',
    'identity.revoke': 'Revoke',
    'identity.revokeConfirm': 'Revoke this pairing? The controller will have to pair again.',
    'identity.revoked': 'Pairing revoked',
    'identity.imported': 'Pairing imported',
    'identity.importFailed': 'Import failed',
    'runtime.title': 'Runtime',
    'runtime.state': 'State',
    'runtime.lastHb': 'Last heartbeat',
    'runtime.nextHb': 'Next heartbeat',
    'runtime.hbCount': 'Heartbeats',
    'runtime.cmdCount': 'Commands executed',
    'runtime.sessions': 'Sessions',
    'runtime.lastError': 'Last error',
    'runtime.diagnostics': 'Diagnostics',
    'runtime.noEvents': 'No events yet.',
    'command.title': 'Command entry',
    'command.help': 'Open this page any time from DSH with <code>/puppet-settings</code>, or bookmark the URL. The same command is available in every session.',
    'command.setupUrl': 'Setup URL',
    'toast.saved': 'Saved; reconnecting',
    'toast.reachable': 'Reachable; server time {time}',
    'toast.testFailed': 'Test failed',
    'toast.restarted': 'Loop restarted',
    'toast.wakeMode': 'Wake mode: {mode}',
    'toast.bindingImported': 'Pairing imported',
    'toast.bindingRevoked': 'Pairing revoked',
    'common.unknown': 'unknown',
    'common.time': '—',
    'confirm.ok': 'OK',
  },
  zh: {
    title: 'Puppet',
    'header.subtitle': 'DSH 受控端',
    'header.runtime': '运行在本地 DeepSeek Harness 内',
    'lang.label': '语言',
    'state.loading': '加载中',
    'state.unreachable': '无法连接',
    'state.online': '在线',
    'state.connecting': '连接中',
    'state.unconfigured': '未配置',
    'state.error': '错误',
    'state.disabled': '已禁用',
    'state.stopped': '已停止',
    'state.unknown': '未知',
    'banner.unconfigured': '该受控端尚未连接。请在下方填写中继 / API 基地址并保存。',
    'pair.title': '配对控制端',
    'pair.hint': '选择配对方式',
    'pair.method.qr': '扫码配对',
    'pair.method.token': '拷贝 token',
    'pair.empty': '尚未生成配对码。',
    'pair.show': '生成 token',
    'pair.cancel': '取消',
    'pair.copy': '复制链接',
    'pair.link': '配对链接（含一次性密钥）',
    'pair.step1': '点击“生成 token”，用 Puppeteer App 扫码或复制 token。',
    'pair.step2': '控制端身份会在下一次心跳中以端到端加密形式回传。',
    'pair.step3': '二维码 5 分钟内有效，仅可使用一次。',
    'pair.expires': '{seconds} 秒后过期',
    'pair.bound': '控制端已配对',
    'pair.failed': '生成配对码失败',
    'pair.copied': '配对链接已复制',
    'pair.tokenHint': '把该 token 复制进 Puppeteer App。它就是二维码内容的文本形式。',
    'pair.tokenShow': '生成 token',
    'pair.tokenLabel': '配对 token（base64url JSON）',
    'pair.tokenCopy': '复制 token',
    'pair.tokenCopied': '配对 token 已复制',
    'connection.title': '连接',
    'connection.hint': '本机向哪里上报',
    'connection.relay': '中继 / API 基地址',
    'connection.relayPlaceholder': 'https://example.com/thread  或  http://192.168.1.10:8787',
    'connection.relayHelp': 'Lite 服务端是纯 HTTP + PHP/MySQL；完整中继是 WSS 服务。两者都在该地址下使用 <code>/v1/...</code>。',
    'connection.name': '本机名称',
    'connection.heartbeat': '心跳间隔',
    'connection.seconds15': '15 秒',
    'connection.seconds30': '30 秒',
    'connection.seconds60': '60 秒',
    'connection.minutes2': '2 分钟',
    'connection.control': '控制',
    'connection.enabled': '启用',
    'connection.disabled': '禁用',
    'connection.save': '保存并重连',
    'connection.test': '测试连接',
    'connection.restart': '重启心跳',
    'wake.title': '保持本机唤醒',
    'wake.off': '关闭',
    'wake.task': '有任务运行时',
    'wake.always': '始终',
    'wake.lock': '唤醒锁',
    'wake.mechanism': '机制',
    'wake.since': '开始于',
    'wake.held': '已持有',
    'wake.released': '未持有',
    'wake.help': 'Windows 使用 SetThreadExecutionState，macOS 使用 caffeinate，Linux 使用 systemd-inhibit。插件停止或助手进程退出时锁会自动释放。',
    'platform.win32': 'Windows',
    'platform.darwin': 'macOS',
    'platform.linux': 'Linux',
    'identity.title': '身份与配对',
    'identity.agentId': 'Agent ID',
    'identity.localId': '本地 ID',
    'identity.ed': 'Ed25519',
    'identity.x': 'X25519',
    'identity.controllers': '已配对控制端',
    'identity.peers': '端到端加密对端',
    'identity.empty': '尚未配对任何控制端。',
    'identity.import': '导入配对记录（JSON）',
    'identity.importButton': '导入配对',
    'identity.revoke': '撤销',
    'identity.revokeConfirm': '撤销该配对？控制端需要重新配对。',
    'identity.revoked': '配对已撤销',
    'identity.imported': '配对已导入',
    'identity.importFailed': '导入失败',
    'runtime.title': '运行状态',
    'runtime.state': '状态',
    'runtime.lastHb': '上次心跳',
    'runtime.nextHb': '下次心跳',
    'runtime.hbCount': '心跳次数',
    'runtime.cmdCount': '已执行指令',
    'runtime.sessions': '会话数',
    'runtime.lastError': '最近错误',
    'runtime.diagnostics': '诊断日志',
    'runtime.noEvents': '暂无事件。',
    'command.title': '命令入口',
    'command.help': '在 DSH 任意会话输入 <code>/puppet-settings</code> 即可随时打开本页，也可以直接收藏地址。所有会话都可用。',
    'command.setupUrl': '设置页地址',
    'toast.saved': '已保存，正在重连',
    'toast.reachable': '连接成功；服务端时间 {time}',
    'toast.testFailed': '测试失败',
    'toast.restarted': '心跳已重启',
    'toast.wakeMode': '唤醒模式：{mode}',
    'toast.bindingImported': '配对已导入',
    'toast.bindingRevoked': '配对已撤销',
    'common.unknown': '未知',
    'common.time': '—',
    'confirm.ok': '确定',
  },
}

export function renderSetupPage({ version, basePath = '/puppet' }) {
  const en = MESSAGES.en
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${en.title}</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0b0e14;
    --panel: #121722;
    --panel-2: #171e2b;
    --line: #263042;
    --text: #e8edf7;
    --muted: #8e9bb3;
    --accent: #7aa2ff;
    --good: #45d19a;
    --warn: #f0b35b;
    --bad: #ff6b7a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: radial-gradient(1200px 600px at 10% -10%, #17233c 0%, var(--bg) 55%);
    color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  .logo { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(135deg, #3f6fff, #7aa2ff); color: #fff; font-weight: 700; }
  h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
  .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .header-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .pill { padding: 6px 10px; border: 1px solid var(--line); border-radius: 999px;
    color: var(--muted); font-size: 12px; white-space: nowrap; }
  .pill.online { color: var(--good); border-color: #245c48; background: #0f2a21; }
  .pill.error { color: var(--bad); border-color: #5c2430; background: #2a0f14; }
  .lang { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
  .lang button { border: 0; border-radius: 0; background: transparent; color: var(--muted);
    padding: 5px 9px; font-size: 12px; }
  .lang button.active { background: #24324c; color: var(--text); }
  .banner { margin: 0 0 18px; padding: 12px 14px; border-radius: 10px; border: 1px solid #5c4a24;
    background: #2a2110; color: #ffd9a0; font-size: 13px; }
  .grid { display: grid; grid-template-columns: 1.25fr .75fr; gap: 16px; }
  @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } }
  .card { background: linear-gradient(180deg, var(--panel-2), var(--panel)); border: 1px solid var(--line);
    border-radius: 14px; padding: 18px; }
  .card h2 { font-size: 14px; margin: 0 0 14px; color: #c9d4e8; font-weight: 600; }
  .card h2 .hint { color: var(--muted); font-weight: 400; margin-left: 6px; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 6px; }
  input, select, textarea { width: 100%; background: #0d1220; color: var(--text); border: 1px solid var(--line);
    border-radius: 9px; padding: 9px 10px; font: inherit; outline: none; }
  input:focus, select:focus, textarea:focus { border-color: #3e5b9a; box-shadow: 0 0 0 3px #1b2b4d; }
  textarea { min-height: 92px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 12px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .row > * { flex: 0 0 auto; }
  button { border: 1px solid var(--line); background: #1a2333; color: var(--text); padding: 9px 13px;
    border-radius: 9px; font: inherit; cursor: pointer; }
  button:hover { border-color: #3e5b9a; }
  button.primary { background: linear-gradient(135deg, #315cff, #5a82ff); border-color: #4f74ff; color: #fff; }
  button.danger { color: var(--bad); border-color: #5c2430; background: #2a0f14; }
  button.ghost { background: transparent; }
  .actions { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
  .status { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin-top: 6px; }
  .kv { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dashed #222b3c;
    padding: 7px 0; font-size: 12px; }
  .kv span:first-child { color: var(--muted); }
  .kv span:last-child { text-align: right; word-break: break-all; }
  .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  .seg button { border: 0; border-radius: 0; padding: 8px 11px; background: transparent; color: var(--muted); }
  .seg button.active { background: #24324c; color: var(--text); }
  .pair-grid { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 760px) { .pair-grid { grid-template-columns: 1fr; } }
  .qr-box { background: #fff; border-radius: 12px; padding: 12px; min-height: 260px;
    display: grid; place-items: center; color: #111; }
  .qr-box svg { width: 100%; height: auto; max-width: 280px; display: block; }
  .qr-box .empty { color: #666; }
  .pair-steps { display: flex; flex-direction: column; gap: 6px; }
  .pair-steps .sub { margin: 0; }
  .toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(20px);
    opacity: 0; pointer-events: none; transition: .18s ease; background: #1c2638; border: 1px solid #3a4b6b;
    color: var(--text); padding: 10px 16px; border-radius: 10px; font-size: 13px; max-width: 80vw; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.bad { border-color: #6b2a35; color: #ffc2c9; }
  .log { max-height: 220px; overflow: auto; background: #0a0f19; border: 1px solid #1d2637; border-radius: 10px;
    padding: 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.7; }
  .log .warn { color: var(--warn); } .log .error { color: var(--bad); } .log .info { color: #a9b8d4; }
  .bindings { display: flex; flex-direction: column; gap: 8px; }
  .binding { display: flex; gap: 10px; align-items: center; border: 1px solid #222b3c; border-radius: 9px;
    padding: 9px 10px; background: #0d1220; }
  .binding .meta { min-width: 0; flex: 1; }
  .binding .id { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: #c9d4e8; }
  .binding .scopes { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
  code { background: #0d1220; border: 1px solid #222b3c; border-radius: 5px; padding: 1px 5px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">RC</div>
    <div>
      <h1 data-i18n="title">${en.title}</h1>
      <div class="sub"><span data-i18n="header.subtitle">${en['header.subtitle']}</span> · v${version} · <span data-i18n="header.runtime">${en['header.runtime']}</span></div>
    </div>
    <div class="header-right">
      <div id="langSwitch" class="lang" role="group" aria-label="${en['lang.label']}">
        <button type="button" data-lang="zh">中文</button>
        <button type="button" data-lang="en">EN</button>
      </div>
      <div id="pill" class="pill" data-i18n="state.loading">${en['state.loading']}</div>
    </div>
  </header>

  <div id="banner" class="banner" hidden data-i18n="banner.unconfigured">
    ${en['banner.unconfigured']}
  </div>

  <div class="card" style="margin-bottom:16px">
    <h2><span data-i18n="pair.title">${en['pair.title']}</span> <span class="hint" data-i18n="pair.hint">${en['pair.hint']}</span></h2>
    <div class="pair-grid">
      <div id="qrBox" class="qr-box"><div class="empty" data-i18n="pair.empty">${en['pair.empty']}</div></div>
      <div>
        <div class="pair-steps">
          <div class="sub" data-i18n="pair.step1">${en['pair.step1']}</div>
          <div class="sub" data-i18n="pair.step2">${en['pair.step2']}</div>
          <div class="sub" data-i18n="pair.step3">${en['pair.step3']}</div>
        </div>
        <div class="actions">
          <button class="primary" id="pairStart" data-i18n="pair.show">${en['pair.show']}</button>
          <button class="ghost" id="pairCancel" data-i18n="pair.cancel">${en['pair.cancel']}</button>
        </div>
        <div id="pairStatus" class="sub"></div>
        <label for="pairToken" data-i18n="pair.tokenLabel">${en['pair.tokenLabel']}</label>
        <textarea id="pairToken" readonly spellcheck="false"></textarea>
        <div class="actions">
          <button id="copyToken" data-i18n="pair.tokenCopy">${en['pair.tokenCopy']}</button>
        </div>
      </div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2><span data-i18n="connection.title">${en['connection.title']}</span> <span class="hint" data-i18n="connection.hint">${en['connection.hint']}</span></h2>
      <label for="relayUrl" data-i18n="connection.relay">${en['connection.relay']}</label>
      <input id="relayUrl" placeholder="${en['connection.relayPlaceholder']}" data-i18n-placeholder="connection.relayPlaceholder" autocomplete="off" spellcheck="false">
      <div class="sub" style="margin-top:6px" data-i18n-html="connection.relayHelp">${en['connection.relayHelp']}</div>

      <label for="agentName" data-i18n="connection.name">${en['connection.name']}</label>
      <input id="agentName" maxlength="80" autocomplete="off">

      <div class="row" style="margin-top:14px">
        <div style="flex:1;min-width:150px">
          <label for="heartbeatMs" data-i18n="connection.heartbeat">${en['connection.heartbeat']}</label>
          <select id="heartbeatMs">
            <option value="15000" data-i18n="connection.seconds15">${en['connection.seconds15']}</option>
            <option value="30000" data-i18n="connection.seconds30">${en['connection.seconds30']}</option>
            <option value="60000" data-i18n="connection.seconds60">${en['connection.seconds60']}</option>
            <option value="120000" data-i18n="connection.minutes2">${en['connection.minutes2']}</option>
          </select>
        </div>
        <div style="flex:1;min-width:150px">
          <label for="enabled" data-i18n="connection.control">${en['connection.control']}</label>
          <select id="enabled">
            <option value="true" data-i18n="connection.enabled">${en['connection.enabled']}</option>
            <option value="false" data-i18n="connection.disabled">${en['connection.disabled']}</option>
          </select>
        </div>
      </div>

      <div class="actions">
        <button class="primary" id="save" data-i18n="connection.save">${en['connection.save']}</button>
        <button id="test" data-i18n="connection.test">${en['connection.test']}</button>
        <button class="ghost" id="restart" data-i18n="connection.restart">${en['connection.restart']}</button>
      </div>
    </div>

    <div class="card">
      <h2 data-i18n="wake.title">${en['wake.title']}</h2>
      <div class="seg" id="wakeModes">
        <button type="button" data-mode="off" data-i18n="wake.off">${en['wake.off']}</button>
        <button type="button" data-mode="task" data-i18n="wake.task">${en['wake.task']}</button>
        <button type="button" data-mode="always" data-i18n="wake.always">${en['wake.always']}</button>
      </div>
      <div class="status" style="grid-template-columns:1fr;margin-top:14px">
        <div class="kv"><span data-i18n="wake.lock">${en['wake.lock']}</span><span id="wakeState">—</span></div>
        <div class="kv"><span data-i18n="wake.mechanism">${en['wake.mechanism']}</span><span id="wakePlatform">—</span></div>
        <div class="kv"><span data-i18n="wake.since">${en['wake.since']}</span><span id="wakeSince">—</span></div>
      </div>
      <div class="sub" style="margin-top:10px" data-i18n="wake.help">${en['wake.help']}</div>
    </div>
  </div>

  <div class="grid" style="margin-top:16px">
    <div class="card">
      <h2 data-i18n="identity.title">${en['identity.title']}</h2>
      <div class="status">
        <div class="kv"><span data-i18n="identity.agentId">${en['identity.agentId']}</span><span id="agentId" class="mono">—</span></div>
        <div class="kv"><span data-i18n="identity.localId">${en['identity.localId']}</span><span id="localAgentId" class="mono">—</span></div>
        <div class="kv"><span data-i18n="identity.ed">${en['identity.ed']}</span><span id="edKey" class="mono">—</span></div>
        <div class="kv"><span data-i18n="identity.x">${en['identity.x']}</span><span id="xKey" class="mono">—</span></div>
      </div>

      <h2 style="margin-top:18px"><span data-i18n="identity.controllers">${en['identity.controllers']}</span> <span class="hint" data-i18n="identity.peers">${en['identity.peers']}</span></h2>
      <div id="bindings" class="bindings"><div class="empty" data-i18n="identity.empty">${en['identity.empty']}</div></div>
    </div>

    <div class="card">
      <h2 data-i18n="runtime.title">${en['runtime.title']}</h2>
      <div class="status" style="grid-template-columns:1fr">
        <div class="kv"><span data-i18n="runtime.state">${en['runtime.state']}</span><span id="state">—</span></div>
        <div class="kv"><span data-i18n="runtime.lastHb">${en['runtime.lastHb']}</span><span id="lastHb">—</span></div>
        <div class="kv"><span data-i18n="runtime.nextHb">${en['runtime.nextHb']}</span><span id="nextHb">—</span></div>
        <div class="kv"><span data-i18n="runtime.hbCount">${en['runtime.hbCount']}</span><span id="hbCount">—</span></div>
        <div class="kv"><span data-i18n="runtime.cmdCount">${en['runtime.cmdCount']}</span><span id="cmdCount">—</span></div>
        <div class="kv"><span data-i18n="runtime.sessions">${en['runtime.sessions']}</span><span id="sessions">—</span></div>
        <div class="kv"><span data-i18n="runtime.lastError">${en['runtime.lastError']}</span><span id="lastError">—</span></div>
      </div>
      <h2 style="margin-top:18px" data-i18n="runtime.diagnostics">${en['runtime.diagnostics']}</h2>
      <div id="log" class="log"></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <h2 data-i18n="command.title">${en['command.title']}</h2>
    <div class="sub" data-i18n-html="command.help">${en['command.help']}</div>
    <div class="status" style="grid-template-columns:1fr;margin-top:10px">
      <div class="kv"><span data-i18n="command.setupUrl">${en['command.setupUrl']}</span><span id="setupUrl" class="mono">—</span></div>
    </div>
  </div>
</div>
<div id="toast" class="toast"></div>

<script>
  var BASE = ${JSON.stringify(basePath)};
  var I18N = ${JSON.stringify(MESSAGES)};
  var token = new URLSearchParams(location.search).get('token') || '';
  var lastState = null;
  var pairingBaseline = null;
  var pairingTimer = null;
  var pairingExpiresAt = 0;
  var LANG_KEY = 'puppet.setup.lang';
  var lang = (function () {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === 'zh' || saved === 'en') return saved;
    } catch (e) {}
    return String(navigator.language || 'en').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  })();
  var queryLang = new URLSearchParams(location.search).get('lang');
  if (queryLang === 'zh' || queryLang === 'en') lang = queryLang;

  function dict() { return I18N[lang] || I18N.en; }
  function t(key, vars) {
    var text = dict()[key];
    if (text === undefined) text = I18N.en[key];
    if (text === undefined) text = key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }
  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function locale() { return lang === 'zh' ? 'zh-CN' : 'en-US'; }
  function when(iso) {
    if (!iso) return t('common.time');
    var d = new Date(iso);
    if (isNaN(d.getTime())) return t('common.time');
    return d.toLocaleString(locale());
  }
  function toast(message, bad) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.className = 'toast'; }, 3200);
  }
  function stopPairingTimer() {
    if (pairingTimer) {
      clearInterval(pairingTimer);
      pairingTimer = null;
    }
    pairingExpiresAt = 0;
  }
  function clearPairing() {
    stopPairingTimer();
    pairingBaseline = null;
    $('qrBox').innerHTML = '<div class="empty">' + esc(t('pair.empty')) + '</div>';
    $('pairStatus').textContent = '';
    $('pairToken').value = '';
  }
  function updatePairingCountdown() {
    if (!pairingExpiresAt) return;
    var left = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000));
    $('pairStatus').textContent = t('pair.expires', { seconds: left });
    if (left <= 0) clearPairing();
  }
  async function startPairing() {
    try {
      var result = await api('/api/pairing', { method: 'POST', body: '{}' });
      $('qrBox').innerHTML = result.svg || '';
      $('pairToken').value = result.token || '';
      pairingExpiresAt = Date.parse(result.expires_at);
      pairingBaseline = lastState && lastState.bindings ? lastState.bindings.length : 0;
      $('pairStatus').textContent = '';
      if (pairingTimer) clearInterval(pairingTimer);
      pairingTimer = setInterval(updatePairingCountdown, 1000);
      updatePairingCountdown();
    } catch (error) {
      toast(t('pair.failed') + ': ' + error.message, true);
    }
  }
  async function api(path, options) {
    options = options || {};
    options.headers = Object.assign({
      'content-type': 'application/json',
      'x-puppet-setup': '1'
    }, token ? { 'x-puppet-setup-token': token } : {}, options.headers || {});
    var res = await fetch(BASE + path, options);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error && body.error.message ? body.error.message : ('HTTP ' + res.status));
    return body;
  }

  function applyLanguage(next, persist) {
    lang = next === 'zh' ? 'zh' : 'en';
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    document.title = t('title');
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    var langSwitch = document.getElementById('langSwitch');
    if (langSwitch) langSwitch.setAttribute('aria-label', t('lang.label'));
    document.querySelectorAll('#langSwitch button').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-lang') === lang);
    });
    if (persist) {
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    }
    if (lastState) render(lastState);
  }

  function stateLabel(value) {
    var key = 'state.' + String(value || 'unknown');
    return I18N[lang] && I18N[lang][key] !== undefined ? t(key) : String(value || t('state.unknown'));
  }

  function render(state) {
    lastState = state;
    var status = state.status || {};
    var config = state.config || {};
    var pill = $('pill');
    pill.textContent = stateLabel(status.state || 'unknown');
    pill.className = 'pill' + (status.state === 'online' ? ' online' : (status.state === 'error' ? ' error' : ''));

    var connected = status.state === 'online';
    $('banner').hidden = connected || Boolean(config.relayUrl);

    if (document.activeElement !== $('relayUrl')) $('relayUrl').value = config.relayUrl || '';
    if (document.activeElement !== $('agentName')) $('agentName').value = config.agentName || '';
    if (document.activeElement !== $('heartbeatMs')) $('heartbeatMs').value = String(config.heartbeatMs || 30000);
    if (document.activeElement !== $('enabled')) $('enabled').value = String(config.enabled !== false);

    var modes = $('wakeModes').querySelectorAll('button');
    modes.forEach(function (button) {
      button.className = button.getAttribute('data-mode') === config.keepAwake ? 'active' : '';
    });
    var wake = status.wake || {};
    $('wakeState').textContent = wake.active ? t('wake.held') : t('wake.released');
    var platformKey = wake.platform ? ('platform.' + wake.platform) : '';
    $('wakePlatform').textContent = platformKey && I18N[lang] && I18N[lang][platformKey]
      ? t(platformKey)
      : (wake.platform || '—');
    $('wakeSince').textContent = when(wake.startedAt);

    $('agentId').textContent = status.agentId || '—';
    $('localAgentId').textContent = status.localAgentId || '—';
    $('edKey').textContent = state.identity ? state.identity.ed : '—';
    $('xKey').textContent = state.identity ? state.identity.x : '—';

    $('state').textContent = stateLabel(status.state || 'unknown');
    $('lastHb').textContent = when(status.lastHeartbeatAt);
    $('nextHb').textContent = when(status.nextHeartbeatAt);
    $('hbCount').textContent = status.heartbeatCount == null ? '—' : status.heartbeatCount;
    $('cmdCount').textContent = status.commandCount == null ? '—' : status.commandCount;
    $('sessions').textContent = status.sessions == null ? '—' : status.sessions;
    $('lastError').textContent = status.lastError || '—';

    var bindings = state.bindings || [];
    var box = $('bindings');
    if (!bindings.length) {
      box.innerHTML = '<div class="empty">' + esc(t('identity.empty')) + '</div>';
    } else {
      box.innerHTML = bindings.map(function (binding) {
        return '<div class="binding"><div class="meta">' +
          '<div class="id">' + esc(binding.binding_id) + '</div>' +
          '<div class="scopes">' + esc(binding.controller_id) + ' · ' + esc((binding.scopes || []).join(', ')) + '</div>' +
          '</div><button class="danger" data-revoke="' + esc(binding.binding_id) + '">' + esc(t('identity.revoke')) + '</button></div>';
      }).join('');
      box.querySelectorAll('button[data-revoke]').forEach(function (button) {
        button.addEventListener('click', async function () {
          if (!confirm(t('identity.revokeConfirm'))) return;
          try {
            await api('/api/binding/delete', { method: 'POST', body: JSON.stringify({ binding_id: button.getAttribute('data-revoke') }) });
            toast(t('toast.bindingRevoked'));
            await refresh();
          } catch (error) { toast(error.message, true); }
        });
      });
    }

    if (pairingBaseline !== null && bindings.length > pairingBaseline) {
      toast(t('pair.bound'));
      clearPairing();
    }

    var log = state.log || [];
    $('log').innerHTML = log.map(function (entry) {
      return '<div class="' + esc(entry.level) + '">' + esc(entry.at.slice(11, 19)) + '  ' + esc(entry.message) + '</div>';
    }).join('') || '<div class="info">' + esc(t('runtime.noEvents')) + '</div>';
    $('log').scrollTop = $('log').scrollHeight;

    $('setupUrl').textContent = location.origin + BASE + '/setup' + (token ? ('?token=' + encodeURIComponent(token)) : '');
  }

  async function refresh() {
    try {
      var state = await api('/api/state');
      render(state);
    } catch (error) {
      var pill = $('pill');
      pill.textContent = t('state.unreachable');
      pill.className = 'pill error';
    }
  }

  $('langSwitch').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-lang]');
    if (!button) return;
    applyLanguage(button.getAttribute('data-lang'), true);
  });

  $('save').addEventListener('click', async function () {
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          relayUrl: $('relayUrl').value,
          agentName: $('agentName').value,
          heartbeatMs: Number($('heartbeatMs').value),
          enabled: $('enabled').value === 'true'
        })
      });
      toast(t('toast.saved'));
      await refresh();
    } catch (error) { toast(error.message, true); }
  });

  $('test').addEventListener('click', async function () {
    try {
      var result = await api('/api/test', { method: 'POST', body: '{}' });
      var serverTime = result.server_time ? when(result.server_time) : t('common.unknown');
      toast(result.ok ? t('toast.reachable', { time: serverTime }) : t('toast.testFailed'), !result.ok);
      await refresh();
    } catch (error) { toast(error.message, true); }
  });

  $('restart').addEventListener('click', async function () {
    try {
      await api('/api/restart', { method: 'POST', body: '{}' });
      toast(t('toast.restarted'));
      await refresh();
    } catch (error) { toast(error.message, true); }
  });

  $('wakeModes').addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-mode]');
    if (!button) return;
    try {
      await api('/api/wake', { method: 'POST', body: JSON.stringify({ mode: button.getAttribute('data-mode') }) });
      toast(t('toast.wakeMode', { mode: button.textContent }));
      await refresh();
    } catch (error) { toast(error.message, true); }
  });

  document.getElementById('pairStart').addEventListener('click', startPairing);
  document.getElementById('pairCancel').addEventListener('click', async function () {
    try { await api('/api/pairing/cancel', { method: 'POST', body: '{}' }); } catch (e) {}
    clearPairing();
  });
  document.getElementById('copyToken').addEventListener('click', async function () {
    var value = document.getElementById('pairToken').value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast(t('pair.tokenCopied'));
    } catch (error) {
      document.getElementById('pairToken').select();
      document.execCommand('copy');
      toast(t('pair.tokenCopied'));
    }
  });

  applyLanguage(lang, false);
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>`
}
