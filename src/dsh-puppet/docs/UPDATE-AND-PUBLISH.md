# 更新与发布指南

本文分两件事：

1. **更新插件**：改本机已安装的受控端插件。
2. **发布到公网**：让手机/网页控制端在外网可用。

先记住一个前提：**受控端插件本身不需要公网 IP**。它只主动向外发 HTTPS 心跳；需要公网的是服务端（中继/轻量站点）。把 PC 的设置页直接暴露到公网是错误做法。

## 0. 插件命名约束（先看这一节）

DSH 把命名分成几层，约束不同：

| 层 | 字段 | 约束 |
| --- | --- | --- |
| npm 包名 | `package.json` → `name` | 小写、URL-safe；DSH 安装校验正则为 `^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$`，总长 ≤ 214；不能大写、空格、开头 `.`/`_`；scoped 用 `@scope/name` |
| profile bundle | `package.json` → `dsh.profile.bundles[]` | 必须**逐字**等于包名（含 scope）；`dsh plugin add` 安装 bundle 时自动写入 |
| 配置行 | `cordis.patch.yml` 的 `- id` / `name` | `id` 必填且 profile 内唯一、稳定不变；`name` 是 loader 的模块 specifier，包安装时用包名；非 insert 覆盖时 `name` 若写了必须与目标行一致 |
| 浏览器半边 | `dsh.client` + `window.__ModuleLoader__.load({ id })` | `id` 必须等于解析后的包名；`dsh.client.platform` 为 `web`，导出 `./client` |

补充：

- **`id` 不要含 `:`**。Cordis loader 用 `:` 表示嵌套 entry id（`a:b`），带冒号的 id 无法正常 `resolve`。
- `id` 建议用 kebab-case：`dsh-puppet`、`multi-remote`、`wsl-workspace`。DSH 的 schema 只要求 string，不强校验正则，但小写 + `-`/`_`/`.` 最安全。
- `id` 是配置/设置/禁用状态的稳定身份；**升级不要改 id**，否则旧配置不会命中，设置页也会当成新插件。
- `name` 在 insert 里可以是包名、相对路径或 `file:` URL；但发布到 npm 的插件应使用包名。
- `dsh.bundle.patch` 必须是相对包根的路径（一个文件或有序数组），指向的 `cordis.patch.yml` 必须存在；否则安装后不会成为 profile layer。
- `engines.dsh` 写 SemVer range 时会被兼容性检查使用；没有它时才看 `@deepseek-ai/dsh*` 的 `peerDependencies`。prerelease 也算在 range 内。
- `@deepseek-ai/*` 是官方 scope，不要用；`dsh-` 前缀不是保留字，但容易被误认为官方，第三方建议加自己的前缀或 scope。
- 包名/`id` 不要和内置行冲突：`session`、`ui-settings`、`timer`、`plugin-manager`、`tool-plugin-manager` 等。

例子：

```text
dsh-puppet          ✅ 小写、kebab-case
@acme/dsh-puppet          ✅ scoped
DSH-Remote-Control                ❌ 大写
dsh remote control                ❌ 空格
.dsh-remote                       ❌ 开头点
dsh:remote                        ❌ 冒号（也会破坏 loader id）
```

> 当前仓库的包名是 **`dsh-puppet`**（截至 2026-10-31 npm 上仍为空）；原候选 `dsh-remote-control` 已被另一个 npm 项目占用。

---

## 1. 更新插件

### 1.1 本地 `link:` 安装（开发/自用）

如果你当初这样安装：

```powershell
dsh plugin --profile desktop add link:D:\Users\lfgsu\Documents\Projects\Puppetry\dsh-puppet
```

profile 里的 `node_modules/dsh-puppet` 是指向源码目录的链接，**改磁盘上的源码就是改插件**。

更新步骤：

1. 改代码，必要时提升版本：
   - `package.json` 的 `version`
   - `src/util.js` 的 `PLUGIN_VERSION`（设置页/命令行显示用）
2. 跑测试：
   ```powershell
   node --test test/*.test.js
   ```
3. **完全退出 DSH**：托盘/菜单栏也要退出，确认任务管理器里没有 `DeepSeek Harness` 进程。
4. 重新打开 DSH。
5. 验证：
   - 打开 `/puppet-settings`，页头版本号应为新版本；
   - 或运行 `/puppet-settings status`；
   - 或看 profile：
     ```powershell
     dsh plugin --profile desktop why dsh-puppet
     ```

> HMR 只热更 `cordis.patch.yml` 的配置，**不会重新 import 宿主插件模块**。只刷新页面或只重开窗口通常不够，必须完全重启进程。

如果 `link:` 没有生效（例如之前用 `file:` 或 npm 装过），重新执行一次：

```powershell
dsh plugin --profile desktop add link:D:\Users\lfgsu\Documents\Projects\Puppetry\dsh-puppet
```

### 1.2 npm 安装

```powershell
dsh plugin --profile desktop add dsh-puppet@latest
```

然后完全退出并重开 DSH。需要固定版本时：

```powershell
dsh plugin --profile desktop add dsh-puppet@0.2.2
```

`dsh plugin` 没有独立的 `update` 子命令，它把参数转发给 pnpm；`add <pkg>@<version>` 就是升级/降级。若 pnpm 缓存导致版本没变：

```powershell
dsh plugin --profile desktop remove dsh-puppet
dsh plugin --profile desktop add dsh-puppet@0.2.2
```

### 1.3 GitHub 安装

```powershell
dsh plugin --profile desktop add github:<user>/<repo>#v0.2.2
```

升级时把 tag 换成新版本，重启 DSH。

### 1.4 更新前备份、失败回滚

插件数据在：

```
%USERPROFILE%\.dsh\puppet\
  config.json
  identity.json
  bindings.json
  state.json
  audit.log
```

升级前复制一份：

```powershell
Copy-Item "$HOME\.dsh\puppet" "$HOME\.dsh\puppet.bak-$(Get-Date -Format yyyyMMdd-HHmm)" -Recurse
```

回滚：

- npm：`dsh plugin --profile desktop add dsh-puppet@<旧版本>`
- link：把源码目录切回旧 tag/旧提交，重启 DSH
- 配置回滚：用备份覆盖 `puppet` 目录（注意 `identity.json` 决定 `agent_id`，覆盖后绑定关系才一致）

### 1.5 版本发布前检查

```powershell
npm pack --dry-run
node --test test/*.test.js
```

确认打包内容包含：`src/`、`scripts/`、`cordis.patch.yml`、`README.md`、`LICENSE`，不包含 `.dsh-test`、`node_modules`、日志或密钥。

---

## 2. 把插件包发布到公网

### 2.1 npm 包名：冲突与选择

- 原名 `dsh-remote-control` **已经被另一个项目占用**（`dsh-remote/plugin`，最新 0.5.5），不能直接发布。
- 因此 v0.2 起曾用包名 **`dsh-kiteline`**（截至 2026-10-31 查询时 npm 上仍为空，404）。
- `dsh-kiteline` 与风筝线品牌 “KITELINE” 撞名，**商标意义上不是完全干净**；v0.3 起改用现名 **`dsh-puppet`**。个人/团队自用没问题；若要长期公网分发，建议加 scope 更稳妥：

```json
{
  "name": "@your-scope/dsh-puppet"
}
```

发布前再确认一次：

```powershell
npm view dsh-puppet version
```

如果 404 说明可用；如果已被占用就改 scope，并把 `cordis.patch.yml` 的 `name` 改成同一个包名。`id` 可以继续叫 `dsh-puppet`，它是配置树里的标识。

### 2.2 npm 发布步骤

```powershell
cd D:\Users\lfgsu\Documents\Projects\Puppetry\dsh-puppet
npm login
npm whoami
npm publish --access public
npm view dsh-puppet version
```

发布后用户安装：

```powershell
dsh plugin --profile desktop add dsh-puppet
```

如果要发布 scoped 包（`@your-scope/...`），`--access public` 必须保留，否则默认是私有包。

### 2.3 GitHub Release

适合不想上 npm、或想附带 zip 的场景：

```powershell
git tag v0.2.2
git push origin v0.2.2
```

用户安装：

```powershell
dsh plugin --profile desktop add github:<user>/<repo>#v0.2.2
```

Release 里可以附上 `dsh-puppet-0.2.2.zip`，并写清楚 DSH 版本要求（`^0.2.1-rc.3`）和“安装后必须完全重启”。

### 2.4 插件市场/索引

如果你的 DSH 版本带插件市场，且它支持提交索引 URL，就在市场里提交包名或索引；这不是所有 DSH 版本都有。**npm + GitHub 是通用兜底**。

---

## 3. “发布到公网”的两种含义

| 你想发布的东西 | 是否需要公网 | 说明 |
| --- | --- | --- |
| 受控端插件（PC 上的 DSH 插件） | **不需要** | 只做出站 HTTPS，无入站端口，不需要公网 IP/端口映射 |
| 服务端（中继/Lite 站点） | **需要** | 手机/网页控制端必须能访问；插件把心跳发到这里 |
| PC 的设置页 | **绝对不要** | 只应绑定 `127.0.0.1`，通过本机浏览器/`/puppet-settings` 打开 |

拓扑：

```
手机/网页控制端 ──HTTPS──▶ 公网服务端（中继/Lite） ◀──HTTPS 心跳── PC 上的 DSH 插件
                                      │
                                      └── 只存密文/元数据
```

### 3.1 方案 A：Lite Relay 部署在 PHP 虚拟主机（最省成本）

适合已有阿里云/腾讯云虚拟主机、只有 PHP + MySQL 的情况。按设计文档 §8.7–8.13 实现/部署：

1. 域名解析：`thread.example.com` → 虚拟主机 IP。
2. 开启 HTTPS（主机面板申请免费证书，强制 HTTPS）。
3. 上传 Lite 代码到站点子目录，例如 `/htdocs/thread/`。
4. 创建 MySQL 库和最小权限账号，导入 `schema.sql`。
5. 配置 `config.php`：
   - `base_url = https://thread.example.com/thread`
   - 数据库 DSN/账号
   - `deployment = lite`
   - 限制：每条指令/结果/摘要大小、每设备速率
6. 配 rewrite；不能改 rewrite 就用 `index.php?r=/v1/...` 兜底。
7. 可选 cron 每 5 分钟清理过期数据；不配也能跑（机会式 GC）。
8. 验证：
   ```powershell
   curl.exe -i https://thread.example.com/thread/v1/health
   ```
   没有 health 路由就至少确认 404/401 来自你的 PHP，而不是主机默认页。
9. 在插件设置页填：
   ```
   https://thread.example.com/thread
   ```
   `allowInsecureHttp` 设为 false。

**当前状态**：生产级 PHP Lite 实现见 `un-halt.com/thread/`（Lite Relay / L1，PHP 7.4+ + MySQL）；本仓库另含 `scripts/mock-relay.mjs` 用于本地联调，不要把 mock 暴露到公网。

### 3.2 方案 B：Full Relay 部署在 VPS（推荐，支持隧道/流式）

适合需要低延迟、`session.attach`、`env.watch` 的场景。

1. 买一台有公网 IPv4/IPv6 的 VPS（阿里云 ECS、腾讯云 CVM、Hetzner、Vultr 等）。
2. DNS：`relay.example.com` → VPS IP。
3. 安装 Node.js 24。
4. 部署 Full Relay（常驻进程，监听 `127.0.0.1:8787`），用 systemd 托管：
   ```ini
   [Unit]
   Description=DSH Remote Relay
   After=network.target

   [Service]
   User=dshrelay
   WorkingDirectory=/opt/dsh-relay
   ExecStart=/usr/bin/node /opt/dsh-relay/server.js
   Restart=always
   Environment=PORT=8787

   [Install]
   WantedBy=multi-user.target
   ```
5. Caddy 反代并自动签发 TLS：
   ```
   relay.example.com {
     encode zstd gzip
     reverse_proxy 127.0.0.1:8787
   }
   ```
   Caddy 会自动处理 WebSocket upgrade。
6. 防火墙只开 80/443，SSH 限制来源 IP：
   ```bash
   ufw allow 80,443/tcp
   ufw allow from <你的管理 IP> to any port 22
   ufw enable
   ```
7. 插件设置页填 `https://relay.example.com`，`allowInsecureHttp=false`。
8. 验证：
   ```powershell
   curl.exe -i https://relay.example.com/v1/health
   ```

**当前状态**：仓库同样只有 Agent + mock，没有生产级 Full Relay 实现。Full Relay 的协议、隧道和服务器组件见设计文档第 7–8 章。

### 3.3 方案 C：没有公网 IP 时用隧道

如果中继只能跑在家里/公司 NAT 后：

- **Cloudflare Tunnel**：
  ```bash
  cloudflared tunnel --url http://127.0.0.1:8787
  ```
  得到一个 `https://xxx.trycloudflare.com` 临时地址，填到插件 `relayUrl`。
- **frp**：需要一台有公网 IP 的 frps，把本地 8787 映射出去。
- **Tailscale Funnel**：把本机服务以 HTTPS 暴露到公网。

注意：Cloudflare/frp 会终止外层 TLS，能看到连接元数据；但 Puppetry 的业务载荷仍是 HPKE/Noise 端到端加密，服务端读不到内容。它们适合 Lite 心跳/指令，不适合大流量流式。

### 3.4 只在局域网用

如果手机和 PC 在同一 Wi-Fi，不需要公网：

```
http://192.168.1.10:8787
```

插件设置里允许 `http://`（`allowInsecureHttp=true`），但这只适合可信局域网。

---

## 4. 公网部署安全清单

| 项 | 要求 |
| --- | --- |
| TLS | 必须 HTTPS/WSS；不要用自签名证书给手机/浏览器 |
| 设置页 | 只绑 `127.0.0.1`；绝不端口映射 `/puppet/setup` |
| 服务端数据 | 只存密文和元数据；日志不打印 payload |
| 数据库 | 最小权限账号；备份加密；限制公网访问 |
| 认证 | 设备 Ed25519 签名；`Puppetry1-Sig` 的 nonce/ts 校验；绑定撤销 |
| 限速 | 每设备/每 IP 限额；指令/结果/摘要大小上限 |
| 队列 | TTL、最大条数、毒消息上限；避免共享主机被塞满 |
| 主机 | 只开 80/443；SSH 限制来源；自动安全更新 |
| 监控 | 5xx、401/429、队列深度、最老未 ack 消息 |
| 备份 | 只备份密文/元数据；`identity.json`/`config.json` 不公网备份 |

---

## 5. 当前实现状态

- 受控端插件：v0.2.2，L1（心跳 + 指令邮箱 + 统一配对信息（扫码/拷贝 token）绑定），支持保持唤醒、双语设置页。
- 服务端：仓库只有 `scripts/mock-relay.mjs`，用于本地联调；**生产级 Lite PHP / Full Relay 尚未包含**。
- 因此“现在就能公网用”的最短路径是：
  1. 按设计文档实现 Lite PHP 服务端（或 Full Relay）；
  2. 部署到有 HTTPS 的公网主机；
  3. 插件设置页填 `https://...`，完全重启 DSH；
  4. 手机/网页控制端接入同一服务端。

如果你要，我可以下一步直接生成 Lite Relay 的 PHP 骨架（`schema.sql`、`index.php`、`Auth/Mailbox/Digest` 类、Caddy/Nginx 配置、部署脚本），让这条公网路径真正可落地。
