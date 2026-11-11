# Puppet — Agent (受控端插件)

DeepSeek Harness 的受控端插件：把本机 DSH 的在线状态、会话摘要和任务指令，通过一个零知识的公网中继/轻量 Web 站点与手机或网页控制端连接起来。服务端只转发密文，不持有内容密钥。

这是 [Puppetry 协议规范](../../docs/spec/README.md) 的受控端参考实现（v0.3），目标是 **L1（心跳 + 指令邮箱）**：

- 扫码 / 拷贝 token 绑定：设置页展示二维码或 token，控制端取得受控端信息后把身份以 HPKE 加密经心跳回传，Agent 自动建绑定。
- 周期心跳：在线状态、会话摘要（配对后为密封模式，含标题/路径/最近消息；未配对只上报 id/状态/时间）、**可用模型列表（按 provider 分组）**、指令结果。
- 指令邮箱：控制端把 HPKE 加密的指令提交到服务端，Agent 在心跳响应里取回、执行、回传加密结果。
- **模型选择**：心跳上报 `models.groups`；控制端发 `session.prompt` 时可携带 `model: {provider, model}`，Agent 先做会话级 `selectModel` 再发指令。
- 本地设置页：首次运行自动打开，之后随时用 `/puppet-settings` 打开；支持 **中文 / English** 切换，默认跟随浏览器语言并记住选择。
- 保持唤醒：Windows `SetThreadExecutionState`、macOS `caffeinate`、Linux `systemd-inhibit`，支持 `off / task / always` 三档。
- 无隧道：`session.snapshot` 提供有界的批量事件快照（受心跳间隔限制）；完整流式/`env.watch` 仍需 L2 Full Relay。

## 安装

```bash
# link 到本地源码（推荐开发用；路径按实际仓库位置）
dsh plugin --profile desktop add link:D:\Users\lfgsu\Documents\Projects\Puppetry\src\dsh-puppet
```

或发布到 npm 后：

```bash
dsh plugin --profile desktop add dsh-puppet
```

> DSH `0.2.1-rc.x` 起 `--profile <名称>` 为必填，且要放在 `plugin` 与子命令之间；本机桌面端的 profile 名通常是 `desktop`（见 `~/.dsh/profiles/`）。

安装后**完全退出并重开 DSH**（HMR 只热更配置，不会重新 import 插件）。

更新插件、发布 npm 包、把服务端部署到公网的完整步骤见 [docs/UPDATE-AND-PUBLISH.md](docs/UPDATE-AND-PUBLISH.md)。

如果 CLI 没有自动把包加入 profile 的 bundle 栈，手工补两处：

`~/.dsh/profiles/<profile>/package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-puppet"]
    }
  }
}
```

`~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-puppet
      name: 'dsh-puppet'
```

## 首次运行

1. DSH 启动后，插件在 `~/.dsh/puppet/` 生成 `identity.json`（Ed25519 + X25519 私钥，0600）、`config.json`、`bindings.json`、`state.json`。
2. 如果没有配置中继地址，约 1.8 秒后自动打开本机设置页：

   ```
   http://127.0.0.1:<dsh-web-port>/puppet/setup
   ```

   同时在 DSH 日志里打印同一个地址。
3. 在设置页填入中继/站点地址，例如：

   - Lite（PHP/MySQL 站点）：`https://example.com/thread`
   - 本机 mock：`http://127.0.0.1:8787`
   - Full Relay：`https://relay.example.com`

   保存后 Agent 会注册设备并开始心跳。

## 随时打开设置

在任意会话里输入：

```
/puppet-settings
```

会打开同一个设置页；`/puppet-settings status` 只返回文本状态。

```
/puppet-wake on       # 始终阻止睡眠
/puppet-wake off      # 释放
/puppet-wake task     # 只在有任务运行时持有（默认）
```

设置页也可以直接收藏；如果 DSH Web 绑定在局域网地址，URL 会带一次性 `token` 查询参数。语言默认跟随浏览器（`zh*` → 中文，其余英文），右上角可切换并记住；也可用 `?lang=zh` / `?lang=en` 强制。

## 配置项（`~/.dsh/puppet/config.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `relayUrl` | `""` | 中继/站点基地址，不含 `/v1` |
| `agentName` | 主机名 | 控制端显示名 |
| `enabled` | `true` | 关闭后不心跳、不持锁 |
| `heartbeatMs` | `30000` | 15s–120s，服务端可通过 `next_hb_ms` 调整 |
| `keepAwake` | `"task"` | `off` / `task` / `always` |
| `autoOpenSetup` | `true` | 未配置时自动打开设置页 |
| `allowInsecureHttp` | `true` | 允许 `http://`（局域网/mock）；生产建议 `false` |
| `allowedRoots` | `[]` | 远端 `session.create` 允许的目录；空表示不限制 |
| `allowRemoteCreate` | `true` | 是否允许远端新建会话 |
| `setupToken` | 随机 | 非 loopback 访问设置页/API 时要求 |

`identity.json` 里的私钥不会上传；丢失即换 `agent_id`，需要重新绑定。

## 绑定控制端（v0.3）

设置页的「绑定控制端」卡片提供**两种方式**，任选其一，二者共用同一套邀约/响应协议（见协议规范 [identity-pairing.md](../../docs/spec/identity-pairing.md)）：

**方式一：扫码绑定**

1. 点 **「显示二维码 / Show QR code」**，用 Puppeteer App 扫码。
2. App 把控制端身份与绑定请求用 HPKE 加密后提交到服务端；Agent 在下一次心跳里取回、验签并建绑定，然后把含 `meta_key` 的结果加密回传。
3. 手机 App 轮询到 `bound` 后即完成绑定；设置页会自动显示「控制端已绑定」并清除二维码。

**方式二：拷贝 token 绑定**

1. 点 **「生成 token / Generate token」**，复制生成的 token。
2. 把 token 粘贴进 Puppeteer App；token 是二维码内容的文本形式（`base64url(canonical JSON)`），App 解出 `relay / pid / psk / 公钥 / exp` 后走与扫码完全相同的邀约流程。
3. 后续绑定与回传结果与方式一一致。

二维码 / token 都是 5 分钟内有效、一次性；含一次性 `psk`，只在本机屏幕展示，不要截图/投屏/外发。流程见协议规范 [identity-pairing.md](../../docs/spec/identity-pairing.md)。

**离线/救援兜底**：仍可通过 `POST /puppet/api/binding` 手工导入 BindingRecord（见协议规范 [identity-pairing.md](../../docs/spec/identity-pairing.md) §1.4 的 JSON 结构），但不再是主流程。

## 指令

支持的指令（明文在 HPKE 内，服务端不可见）：

- `agent.ping`
- `session.prompt`（可选 `model: {provider, model}` 指定模型，从心跳上报的模型列表中选择；缺省跟随会话当前模型）/ `session.cancel` / `session.rename` / `session.archive`
- `session.create`（受 `allowRemoteCreate` / `allowedRoots` 限制）
- `session.snapshot`（Lite 的流式降级）
- `env.info`
- `approval.respond` / `question.respond`（v0.2 返回 `unsupported`，待接入审批瀑布）

每个指令结果都会用 Agent 的 X25519 私钥 + 控制端公钥做 HPKE Auth 加密，并回传 `POST /v1/commands/{id}/result`。

## 协议路径

| 动作 | 路径 |
| --- | --- |
| 设备注册 | `POST /v1/devices/enroll` |
| 心跳 | `POST /v1/agent/hb` |
| 会话摘要 | `PUT /v1/agents/{id}/digest` |
| 指令结果 | `POST /v1/commands/{id}/result` |
| 创建配对窗口 | `POST /v1/pairings` |
| 提交扫码邀约 | `POST /v1/pairings/{id}/invitation` |
| 查询/取绑定结果 | `GET /v1/pairings/{id}` |
| 提交绑定结果 | `POST /v1/pairings/{id}/result` |

认证使用 `Puppetry1-Sig` 每请求签名（Lite），不依赖 JWT。签名覆盖 method、path、body hash、ts、nonce。

## 保持唤醒

| 平台 | 机制 |
| --- | --- |
| Windows | 长驻 PowerShell 调 `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED \| ES_DISPLAY_REQUIRED)` |
| macOS | `caffeinate -dimsu` |
| Linux | `systemd-inhibit --what=idle:sleep ... sleep infinity` |

- `task`：每 5 秒检查是否有 running 会话；有则持锁，连续 15 秒没有则释放。
- `always`：插件启用期间一直持锁。
- `off`：不持锁。
- 助手进程退出/插件卸载时锁自动释放。

Windows 上 `powercfg /requests` 需要管理员权限才能查看；插件状态页会显示 `active/pid`。

## 测试

用内置 mock 中继和测试控制端（需要 Node 24）。以下命令均从仓库根目录执行：

```bash
node src/dsh-puppet/scripts/mock-relay.mjs
```

把设置页的 relay 设为 `http://127.0.0.1:8787`，然后：

```bash
SETUP_BASE=http://127.0.0.1:<dsh-web-port> \
  node src/dsh-puppet/scripts/test-controller.mjs
```

`TEST_TYPE=env.info|session.create|session.prompt|session.snapshot` 可切换指令；结果写到 `_controller-result.txt`。

扫码绑定端到端（会创建配对窗口 → 提交邀约 → 等心跳 → 绑定 → 发 `agent.ping`）：

```bash
SETUP_BASE=http://127.0.0.1:<dsh-web-port> \
MOCK_BASE=http://127.0.0.1:8787 \
  node src/dsh-puppet/scripts/test-qr-pair.mjs
```

单元测试：

```bash
node --test test/*.test.js
```

覆盖：RFC 8439 ChaCha20-Poly1305 向量、HPKE Auth/Base 往返、扫码/拷贝 token 邀约绑定、Binding 签名、指令/结果信封、重放拒绝、摘要/配置持久化、快照缓冲、设置页结构与中英文词典。

## 已知限制（v0.3）

- 没有 WebSocket 隧道；`session.snapshot` 走心跳邮箱，延迟等于心跳间隔（15–30s），不是真正的流。
- 模型列表依赖 DSH 宿主的 `llm` registry；宿主未注入时安全降级为空列表（控制端不显示模型选择，不影响心跳与其它指令）。
- 没有远端审批/提问应答；审批仍在 PC 本地完成。
- 没有客户端设置侧边栏；入口是 `/puppet-settings` 和书签 URL。
- 服务端需要按设计文档实现 `Puppetry1-Sig`、`/v1/*`（含 `/v1/pairings/*`）与 HPKE 不可见存储；本仓库只含 Agent 与 mock。

## License

MIT
