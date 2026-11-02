# Puppetry：DSH 远程控制方案与协议设计

> 版本：0.1（设计草案） · 日期：2026-10-30 · 适用：DeepSeek Harness 0.2.x
> 定位：一份可被第三方分别实现「控制端 / 服务端 / 受控端」的开放协议 + 插件框架。
> 阅读约定：第 4–8、11 章为**规范性**内容（实现方必须一致，其中 §8.8–8.13 为 Lite 参考实现示例）；第 9、10 章为**实现参考**（说明性，非协议规范）；其余章节为设计说明与取舍。
> 第 2 章对现有项目的描述基于其公开 README/协议文档（2026-10-30 检索），版本与行为可能随项目演进而变化。

---

## 命名约定（Puppetry）

本方案整体命名为 **Puppetry**。三个角色与名称如下：

| 角色 | 中文 | Puppetry 名称 | 职责 |
| --- | --- | --- | --- |
| Controller | 控制端 | **Puppeteer** | 用户触达面：Web / 移动 App / CLI，持有用户设备密钥 |
| Server / Relay | 服务端 | **Thread** | 公网可达的零知识中继，负责设备注册、在线状态、消息邮箱、隧道转发、推送，**不持有任何内容密钥** |
| Agent | 受控端 | **Puppet** | 运行在 PC 上、装进 DSH 进程的插件，持有 DSH 会话访问能力与设备私钥 |



---

## 0. 摘要

本设计（Puppetry）把「用手机或网页远程管理 PC 上的 DSH」拆成三个可独立替换的角色：

- **控制端（Controller，即 Puppeteer）**：Web 页面、移动 App、CLI，持有用户设备密钥。
- **服务端（Relay / Server，即 Thread）**：公网可达的零知识中继，负责设备注册、在线状态、消息邮箱、隧道转发、推送，**不持有任何内容密钥**。
- **受控端（Agent，即 Puppet）**：运行在 PC 上、装进 DSH 进程的插件，持有 DSH 会话访问能力与设备私钥。

服务端有两种可选的部署形态（这是实现方的选择，而非协议对实现语言的硬性规定）：

- **Full Relay（L2）**：具备常驻数据面与 WSS 隧道，支持实时流、`env.watch`、大并发。
- **Lite Relay（L1）**：只依赖 HTTP 请求-响应与关系型数据库（无 WebSocket、无常驻进程、无内存队列），即可完成在线状态、会话列表、发指令、审批、结果拉取；适合资源受限的托管环境（共享虚拟主机是典型场景之一，但不是唯一选择）。

两种形态使用同一套身份、加密信封与 L0/L1 语义；服务端通过发现接口声明 `deployment` 与 `features`，控制端/受控端据此自动降级（见第 8.7–8.13 节）。

核心机制是三条：

1. **消息邮箱 + 心跳捎带**：服务端为每个受控端维护一个「邮箱」（mailbox）——即按收件人排队的加密消息队列，类比信箱：控制端投递、受控端取件。受控端周期 `POST /v1/agent/hb` 上报在线状态与会话摘要（密封），服务端在心跳响应里把邮箱中待投递的加密指令捎带下发；指令结果回传后由控制端拉取。简单操作因此不需要隧道，也不要求任何一端常连。
2. **复杂操作按需开隧道**：控制端申请一次性隧道，服务端把双方 WSS 接起来并只转发密文；隧道内跑 Noise IK + 多路复用 RPC，用于新建项目、实时输出、环境观测等。Lite 没有隧道，降级为「指令 + 本地确认 + 快照拉取」（见 §8.9）。
3. **端到端加密分两层**：异步消息用 **HPKE（RFC 9180）Auth 模式**，隧道用 **Noise IK**；服务端在两种路径上都只能看到密文与必要的路由元数据。

现有生态里没有完全覆盖该形态的成熟方案，但有几个高质量项目可以组合复用（详见第 2 章）：

| 项目 | 最值得借用的部分 | 与本需求的差距 |
| --- | --- | --- |
| [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | Noise IK、设备身份固定、账号成员校验、Relay/TURN/WebRTC 选路、Host API allowlist | 始终维持常连；没有邮箱式离线投递；栈较重 |
| [dsh-remote/plugin](https://github.com/dsh-remote/plugin) | 零知识 relay、载荷级密封、扫码/短码配对、离线队列、协议包分层 | 常连 WS；无独立隧道 RPC；多控制端未声明 |
| [MoonlitDropOfBlood/dsh-remote-control](https://github.com/MoonlitDropOfBlood/dsh-remote-control) | DSH Host API 映射、审批瀑布、会话纪元抗重放、离线补发 | 常连 + 静态 PSK；无每连接前向保密 |
| [yeerock/dsh-rc](https://github.com/yeerock/deepseek-harness-remote-control) | 用单个出站 WSS 代理原生 DSH Web UI 的工程实现 | **TLS 终止的可信中继**，不满足「服务端不可解密」 |

本方案以「消息邮箱 + 按需隧道 + 一致性等级（L0/L1/L2）」为设计主线，并用一个统一的协议包 `@thread/protocol` 把线格式冻结下来（命名仅为示例，避免与现有 npm 包冲突）。

---

## 1. 目标、非目标与约束

### 1.1 功能目标

| 编号 | 能力 | 走哪条通道 |
| --- | --- | --- |
| F1 | 查看受控端在线状态、最后活跃时间 | 心跳 → 服务端 presence |
| F2 | 查看会话列表、运行状态、未读数 | 心跳上报密封摘要 → 控制端拉取解密 |
| F3 | 向已有会话发送任务指令（prompt）、取消、重命名、归档 | 指令邮箱（心跳响应捎带） |
| F4 | 新建会话 / 新建项目 | 按需隧道；Lite 降级为指令 + 本地确认 |
| F5 | 实时查看回复流、工具调用步骤、审批请求 | 按需隧道；Lite 降级为快照拉取 |
| F6 | 查看受控端环境实时信息（CPU/内存/磁盘/工具链） | 按需隧道（`env.watch`）；Lite 为 `env.info` 快照 |
| F7 | 多控制端绑定、撤销、密钥轮换 | 绑定记录 + 心跳下发撤销 |
| F8 | 第三方可替换任一角色 | 一致性等级 + 协议包 + 测试向量 |

### 1.2 非目标（v1 明确不做）

- 远程桌面 / 屏幕镜像。
- 通用 Shell / PTY / 任意文件读写（DSH 自身的工具仍在受控端本地权限内运行，不经远端暴露）。
- 服务端内容搜索、内容审核、内容索引。
- 匿名网络（服务端仍能看到连接元数据）。
- 大文件传输（图片/附件只做有界分块，作为 v2 扩展）。

### 1.3 约束

- **网络**：受控端只做出站连接，不需要公网 IP、端口映射、UDP；企业代理/ TLS 检查网络下也能用。
- **零知识**：服务端代码路径中不存在解密函数；数据库中没有内容明文；日志中不出现 payload。
- **离线容忍**：受控端短时离线不丢指令（TTL 内），恢复后按序补发。
- **低空闲成本**：没有隧道时，受控端只发心跳；控制端不保持常连也能工作。
- **可演进**：协议版本 + 能力协商；加性字段不升主版本，破坏性变更必须升版本并三端同步。
- **部署弹性**：L1 能力应能在「HTTP 请求-响应 + 关系型数据库」这一最小依赖集上实现（不假设 WebSocket、内存队列、常驻进程或可靠定时任务），从而兼容资源受限的托管环境；L2（隧道）才涉及常驻数据面与 WSS。这是设计取向，不限定具体实现语言、数据库或托管平台选型。

---

## 2. 现有方案调研（截至 2026-10-30）

### 2.1 liguobao/ds-harness-remote（最完整的「远端原生 DSH」实现）

- **形态**：DSH 插件（Host）+ 独立 Server + Web / Android / iOS / VS Code 客户端；当前 `0.5.23`。
- **拓扑**：Host 与 Client 各自向 Server 建立出站 WSS 控制通道；数据面按 `LAN → P2P → TURN → Relay` 选路，所有路径都跑同一条 Noise 通道。
- **加密**：固定 `Noise_IK_25519_ChaChaPoly_SHA256`；每个 Host / Client 独立 `deviceId` 与 X25519 身份密钥；连接必须同时通过「同账号 membership」与「本地 identity pinning」两层校验；Noise prologue 绑定 `connectionId`、Host `deviceId`、Client `deviceId`，防止握手被移植。
- **权限**：Host 解密后仍走官方 Harness API 的固定 allowlist；E2EE 与 allowlist 是两件事。
- **可观察性**：Server 能看到账号/设备归属、在线状态、连接时间、协商版本、路径、帧大小与时序；看不到 prompt、会话、工具输出、workspace 路径。
- **优点**：身份模型、密钥固定、路径回退、流式 RPC、多客户端并发都经过工程打磨；有 golden vector 与较完整文档。
- **与本需求的差距**：它假设「客户端与 Host 之间始终有一条已建立的安全通道」，控制面本身就是常连 WSS；没有「心跳捎带指令」这种低状态模式。对只需要「看一眼状态、发一句话」的移动端来说，常连 + WebRTC 栈偏重。

**可借用**：设备身份与 pinning、两层授权、Noise IK + prologue 绑定、allowlist 思路、Relay 作为最终回退。

### 2.2 dsh-remote/plugin（零知识 relay 的极简形态）

- **形态**：DSH 宿主插件 + 官方微信小程序 + 零知识 WebSocket 中继 + 独立协议包；当前 `0.5.5`。
- **加密**：载荷级端到端加密，中继只见 `base64(nonce ‖ secretbox)`；每会话 PSK；配对码由中继签发，扫码即认领。
- **配对**：主机状态栏 pill 展示小程序码；主机 token 只以环境变量名形式存在配置里。
- **可靠性**：中继离线缓存、断线重连、幂等窗口、协议版本闸；`@dsh-remote/protocol` 把帧、载荷、错误码、能力 id 做成纯函数包。
- **优点**：把「服务端零知识」做得很彻底（连中继构建产物里都不含密码学实现，有测试锁住）；配对 UX 极简；协议包可独立复用。
- **与本需求的差距**：仍是「两端常连中继 + 事件流」；没有单独的隧道 RPC / 多路复用；多控制端与撤销模型未在公开文档中展开。

**可借用**：密封记录格式、扫码配对、离线队列与幂等、`protocol` 包的分层方式（frames / payloads / limits / errors / negotiate）。

### 2.3 MoonlitDropOfBlood/dsh-remote-control（DSH Host API 映射最细）

- **形态**：DSH 插件 + 中继 + HarmonyOS App；当前 `1.1.6`。
- **加密**：配对 `secret` 经 HKDF-SHA256 派生 AES-256-GCM 密钥；每帧 `iv‖ct‖tag`，AAD 绑定发送方 role 与 seq；v1.1.3 增加「会话纪元」（持久化单调递增）+ 对端 `sid` 钉扎，防跨会话重放。
- **可靠性**：中继离线缓存 256 帧 / 24h，`urgent` 帧优先补发；同角色新连接顶替旧连接。
- **审批**：`approval/request` 瀑布拦截，手机超时/断线一律 `next()` 放行给桌面答案器（fail-open），绝不把手机变成任务单点。
- **价值**：其 `docs/PROTOCOL.md` 附录记录了 2026-10 实测的 DSH Host API 事实（`sessionController`、`session/event`、`workspaceRegistry`、`approval/request`、`user-questions/request`、模型/权限目录），可直接作为本设计受控端适配层的实现参考。
- **与本需求的差距**：常连 + 静态 PSK 派生，无每连接前向保密；无隧道 RPC；单控制端模型。

**可借用**：Host API 映射、审批瀑布语义、会话纪元/去重、离线补发上限。

### 2.4 yeerock/dsh-rc（反例：可信中继）

- **形态**：自托管 edge + 桌面 agent + DSH 插件；浏览器访问 `https://edge/d/<device>/`，edge 代理**未修改的 DSH Web UI**。
- **优点**：功能 parity 最好（原生 UI 即客户端），单出站 WSS，NAT 友好；有完整的 mux、流控、优先级调度与压测数据。
- **关键差异**：README 明确说明 edge **终止 TLS、能看到代理明文**，是 trusted relay，不是 E2EE。这与本设计「服务端不可解密、不可查看会话内容」的硬约束冲突，因此只借鉴其「单连接多路复用 + 流控 + 原生 UI」的工程手法，不采用其信任模型。

### 2.5 通用标准与成熟构件

| 构件 | 用途 | 本设计怎么用 |
| --- | --- | --- |
| [Noise Protocol Framework](https://noiseprotocol.org/noise.html)（rev 34） | 交互式安全通道 | 隧道握手 `Noise_IK_25519_ChaChaPoly_SHA256`，1-RTT，双向身份认证 + 前向保密 |
| [HPKE RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) | 单向/异步公钥加密 | 邮箱里的指令与结果；`mode_auth` 让接收方确认发送方身份 |
| [SPAKE2 RFC 9382](https://www.rfc-editor.org/rfc/rfc9382) / [OPAQUE RFC 9807](https://www.rfc-editor.org/rfc/rfc9807) | 低熵口令认证密钥交换 | 8 位短码配对；二维码高熵场景可直接 PSK-Noise |
| [Ed25519 RFC 8032](https://www.rfc-editor.org/rfc/rfc8032) / [X25519 RFC 7748](https://www.rfc-editor.org/rfc/rfc7748) | 签名 / DH | 设备长期身份、HPKE 收件人密钥 |
| [MQTT 5](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html) | 心跳、QoS、离线队列、保留消息 | 借鉴「keepalive + 邮箱 + TTL」语义，不直接跑 MQTT（它没有应用层 E2EE 语义） |
| [Matrix](https://spec.matrix.org/)（Olm/Megolm、to-device、SAS） | 设备模型、设备间加密消息、设备验证 | 借鉴「每设备密钥 + to-device 密封消息 + SAS 验证」；不引入 homeserver 的元数据模型 |
| [Tailscale](https://tailscale.com/blog/how-tailscale-works)/DERP | 控制面与数据面分离、中继只转发密文 | 架构主参考：协调服务器 + 中继，业务密钥只在两端 |
| [WebRTC](https://www.rfc-editor.org/rfc/rfc8825)/TURN | P2P 数据面、NAT 穿透 | v2 可选：同一 Noise 通道改跑 DataChannel，服务端只做 signaling/TURN |
| [APNs](https://developer.apple.com/documentation/usernotifications)/[FCM](https://firebase.google.com/docs/cloud-messaging)/[UnifiedPush](https://unifiedpush.org/)/[Web Push RFC 8030](https://www.rfc-editor.org/rfc/rfc8030) | 唤醒控制端 | 只推「有结果/有审批」的提示，不推内容 |
| [JSON-RPC 2.0](https://www.jsonrpc.org/specification) / [ACP](https://agentclientprotocol.com/) / [MCP](https://modelcontextprotocol.io/) | 应用层 RPC | 隧道内采用 JSON-RPC 2.0 子集；与 MCP/ACP 不混层（它们解决的是 agent↔工具/客户端，不是设备间远控） |

### 2.6 结论

- 调研的现有方案多采用「常连 + 固定中继」的设计思路，尚未看到以「邮箱式离线投递 + 按需隧道 + 零知识服务端 + 三方开放」为核心取向的完整方案。
- 现有方案普遍要求常驻中继与 WebSocket，缺少一种能在「HTTP 请求-响应 + 关系型数据库」这种最小依赖上落地的一致性等级；本方案以 Lite 一致性等级补足这一空白（见 §8.7–8.13）。
- 本方案的设计思路是：不发明密码学，只把成熟构件组合成明确的线协议；用一致性等级（L0/L1/L2）定义「哪些能替换、替换后如何互操作」，而非强制单一的部署形态。

---

## 3. 总体架构

### 3.1 角色与组件

```
                          ┌──────────────────────────────────────────────┐
                          │              服务端（公网，零知识）             │
    HTTPS 心跳 / 邮箱      │  /v1/agent/hb   /v1/commands   /v1/tunnels/ws │
   ┌─────────────────────▶│  Presence · Mailbox · Digest · Tunnel Relay  │
   │                      │  Device Registry · Push · Audit(metadata)    │
   │                      └───────▲────────────────────────▲─────────────┘
   │                              │                        │
┌──┴────────────┐   WSS 隧道（服务端只转发 Noise 密文）  ┌──┴─────────────┐
│ 受控端 Agent   │◀═════════════════════════════════════▶│ 控制端 Client  │
│ DSH 插件       │                                      │ Web / App/CLI  │
└──┬────────────┘                                      └────────────────┘
   │ Host Adapter（进程内）
   ▼
 DSH：sessions / workspace / approvals / models / tools
```

四个平面：

| 平面 | 承载 | 是否常连 | 服务端可见 |
| --- | --- | --- | --- |
| 注册/认证面 | HTTPS REST + DPoP / 每请求签名 | 否 | 设备公钥、角色、账号归属 |
| 控制面 | HTTPS 心跳 + 邮箱 + 长轮询 | 心跳周期；长轮询可选 | 设备 id、时间、大小、摘要 rev/hash |
| 数据面 | WSS 隧道（密文） | 仅复杂操作期间 | 隧道 id、字节数、时序 |
| 通知面 | APNs/FCM/WebPush/UnifiedPush | 否 | 推送 token、事件类型（不含内容） |

> Lite 部署没有「数据面」一列：所有交互都走控制面的短轮询，复杂操作降级为指令 + 快照（见 §8.8–8.9）。图中 WSS 隧道是 Full Relay 的能力，不是协议的强制要求。

### 3.2 控制面 / 数据面分离（借鉴 Tailscale + DERP）

- **控制面只做三件事**：证明「你是谁」、记录「你在不在」、搬运「密封的小消息」。
- **数据面只在需要时建立**：隧道是短时的（默认 5 分钟，可续），关闭后服务端不保留任何会话状态。
- **两条路径共用同一套身份与绑定**：不会出现「心跳里是 A、隧道里是 B」的错配；隧道握手必须绑定 `binding_id` 与双方设备 id。
- **服务端可水平扩展**：心跳/邮箱是无状态 API + 共享存储；隧道节点按 `tunnel_id` 哈希路由，状态放共享缓存。

### 3.3 两种交互模式与选择矩阵

| 操作 | 通道 | 延迟量级 | 原因 |
| --- | --- | --- | --- |
| 在线状态、最后活跃 | 心跳 → presence | ≤ 心跳周期 | 服务端本就知道，不需要端到端 |
| 会话列表 / 标题 / 运行状态 | 密封摘要 + 拉取 | ≤ 心跳周期 | 数据量小，可缓存；标题对服务端保密 |
| 向已有会话发 prompt | 指令邮箱 | ≤ 心跳周期（长轮询时 ≈ RTT） | 单条、幂等、可离线排队 |
| 取消 / 重命名 / 归档 | 指令邮箱 | 同上 | 单条、结果小 |
| 审批应答 / 提问应答 | 指令邮箱（+推送） | 同上 | 可靠性优先，必须有 TTL 与幂等 |
| 新建会话 / 新建项目 | 隧道 | ≈ RTT | 需要选项协商、目录校验、本地确认 |
| 实时回复流 / 工具步骤 | 隧道订阅 | ≈ RTT | 高频、有序、可中断 |
| 环境实时信息 | 隧道 `env.watch` | ≈ RTT | 周期采样、可取消 |
| 大图 / 附件 | 隧道分块（v2） | — | 需要流控与上限 |

**判定规则（给实现方）**：

1. 单条、可幂等、结果 ≤ 256 KiB、不需要中间过程 → 邮箱。
2. 需要多次往返、服务端推送事件、或单次结果 > 256 KiB → 隧道。
3. 需要「用户在场做决定」（新建项目、危险权限）→ 隧道 + 本地确认，绝不走静默邮箱。
4. 控制端在后台/省电模式 → 只邮箱 + 推送；回到前台再按需开隧道。

**Lite 部署（无隧道）下的降级**：

| 操作 | Lite 下的实现 | 体验 |
| --- | --- | --- |
| 新建会话 / 新建项目 | 改为指令 `session.create` / `project.create`，受控端本地确认后执行 | 需在 PC 上点一次确认；结果走指令结果 |
| 实时回复流 | 快照上传 + 1.5–2s 拉取 | 2–3s 延迟；流量高于隧道 |
| 环境实时信息 | 指令 `env.info`（受心跳间隔限制） | 只能看 15–30s 级快照，无推送式变化 |
| 大图 / 附件 | 不支持（v2） | 明确提示 |

> Lite 的降级不是「功能缺失」，而是把「长连接 + 推送」换成「短轮询 + 指令」，协议语义不变；控制端根据 `server/info` 的 `features` 自动切换，不需要用户配置。

### 3.4 信任边界与不变量

| 不变量 | 含义 | 违反即拒绝 |
| --- | --- | --- |
| I1 | 服务端不持有任何能解密业务载荷的密钥 | 服务端代码/配置中出现内容私钥 |
| I2 | 指令必须由已绑定控制端的私钥认证 | HPKE Auth 失败 / 绑定不存在 |
| I3 | 隧道双方必须固定对方身份公钥 | Noise 握手对端静态公钥与绑定不符 |
| I4 | 重放、过期、跨绑定移植的指令必须失败 | 计数器/时间/`binding_id` 校验失败 |
| I5 | 服务端只能影响可用性，不能影响完整性 | 任何「服务端说这是 A 发的」都不被采信 |
| I6 | 受控端的本地策略高于远端指令 | 策略拒绝时返回 `policy_denied`，不执行 |

---

## 4. 身份、配对与授权

### 4.1 密钥与标识

| 对象 | 算法 | 生命周期 | 存储 |
| --- | --- | --- | --- |
| Agent 身份签名钥 `ag_ed` | Ed25519 | 长期（换机/重置才换） | OS keychain（Windows DPAPI / macOS Keychain / Linux Secret Service） |
| Agent 身份 DH 钥 `ag_x` | X25519 | 同上 | 同上 |
| Controller 身份签名钥 `ct_ed` | Ed25519 | 长期 | 手机 Secure Enclave / Android Keystore / 浏览器 IndexedDB（WebCrypto 非导出） |
| Controller 身份 DH 钥 `ct_x` | X25519 | 同上 | 同上 |
| 配对预共享秘密 `psk` | 32 字节随机 | 一次性（配对窗口） | 只出现在二维码/短码，不入服务端 |
| 元数据密钥 `mk` | 32 字节随机，按 epoch | 每次撤销/轮换递增 | Agent 生成；HPKE 分发给各控制端 |
| 隧道临时密钥 | Noise 每连接生成 | 单次隧道 | 内存 |
| 服务端访问令牌（Full） | Ed25519/DPoP 绑定的 JWT | 15 分钟 + refresh | 设备内存 |
| 每请求签名（Lite） | Ed25519 `Puppetry1-Sig` | 单次请求 | 设备内存 |

标识：

```
agent_id      = "ag_" + base32lower(SHA-256(ag_ed_pub)[0..15])     # 自证身份
controller_id = "ct_" + base32lower(SHA-256(ct_ed_pub)[0..15])
binding_id    = "bd_" + base32lower(random(16))
command_id    = "cmd_" + UUIDv7
tunnel_id     = "tn_" + base32lower(random(16))
pairing_id    = "pr_" + base32lower(random(16))
kid           = base32lower(SHA-256(public_key)[0..7])
```

> 说明：`agent_id` 由公钥哈希而来，服务端无法给两个不同公钥分配同一个 id；代价是**换钥即换 id**，需要重新配对（v1 接受这个代价，换取实现简单）。

### 4.2 设备注册（Proof of Possession）

```
POST /v1/devices/enroll
{
  "role": "agent" | "controller",
  "name": "Office PC",
  "ed25519_pub": "b64url",
  "x25519_pub":  "b64url",
  "ts": 1761782400000,
  "nonce": "b64url(16B)",
  "sig": "b64url(Ed25519(sk, 'puppetry1-enroll' || role || nonce || ts))"
}
→ 201 { "device_id": "...", "access_token": "...", "refresh_token": "...", "expires_in": 900 }
   # Lite：只返回 { "device_id": "..." }，不签发 token
```

- 服务端只存公钥、角色、显示名、账号归属（可选）、创建时间；**不存任何私钥**。
- **Full 部署**：后续请求用 `Authorization: DPoP <access_token>` + `DPoP: <proof JWT>`（[RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)），令牌与公钥绑定，防止 bearer token 被挪用。
- **Lite 部署**：不签发令牌，改用每请求签名 `Authorization: Puppetry1 device="...", ts="...", nonce="...", sig="..."`；`sig = Ed25519(sk, "Puppetry1\n" + method + "\n" + path + "\n" + hex(sha256(body)) + "\n" + ts + "\n" + nonce)`。服务端用设备公钥验签、校验 `ts ±300s`、记录 `nonce` 防重放，无需签发/校验 JWT。
- 两种方式都是 proof-of-possession，授权语义相同；`/.well-known/puppetry` 的 `auth` 字段声明支持哪一种（Lite 通常只支持 `sig-v1`）。
- 公开服务器支持三种准入：`device-pop`（默认，无账号，按 IP/ASN 配额）、`oauth`（团队）、`mtls`（企业）。

### 4.3 配对

本协议支持多种配对方式，以适应不同的设备能力与场景。下表给出各方式的定位（详细流程见后文）：

| 方式 | 熵/信道 | 适用场景 | 说明 |
| --- | --- | --- | --- |
| 扫码 / 拷贝 | 高熵（二维码承载一次性 `psk` 与受控端公钥） | 默认主流程 | 扫码与拷贝是同一 `PairingOffer` 的两种载体（§4.3.2） |
| 8 位短码 + SPAKE2 | 低熵（口述/输入） | 无摄像头、远程口述 | 用 PAKE 把低熵口令升为会话密钥（方式 B） |
| 手工导入 BindingRecord | 离线 | 救援、无在线信道 | 控制端 → 受控端方向导入（方式 C） |
| 账号体系预置 | 服务端账号（可选） | 团队/企业批量授权 | 部署方按自身账号体系预置绑定关系 |

**方式 A：扫码（推荐，高熵）**

```
Agent（PC）                         Relay                        Controller（手机）
   │ POST /v1/pairings {psk_commit}   │                                  │
   │── 展示 QR: pid + psk + relay ───▶│                                  │
   │                                  │◀── POST /v1/pairings/{pid}/join ─│
   │ WSS /v1/pairings/{pid}?role=a    │    WSS /v1/pairings/{pid}?role=c  │
   │◀══════════ 服务端只转发二进制帧 ══════════════════════════════════▶│
   │◀════ Noise_XXpsk3(psk, prologue = "puppetry1/pair" || pid) ═══════════▶│
   │◀════ 交换身份公钥、名称、能力；计算 SAS（可选，双方比对 6 位数字）══▶│
   │◀════ 双方各自签 BindingRecord，互验后持久化 ══════════════════════▶│
   │ POST /v1/bindings（公开字段 + 双签）│                                  │
```

- `psk` 只存在于二维码与两端内存；服务端只看到 `pairing_id` 与密文，因此**无法中间人**（没有 psk 无法完成 `XXpsk3`）。
- `psk_commit = SHA-256(psk)` 让服务端能校验「加入者拿到的 psk 与创建时一致」而不暴露 psk（可选，防止配对窗口被换码）。
- SAS = `HKDF(handshake_hash, "puppetry1/sas", 3 bytes)` 转 6 位数字；二维码场景可选，短码场景必做。
- 配对窗口默认 5 分钟、一次性；二维码内容含 psk，**不得写入日志、不得截图分享**。
- **Lite（无 WebSocket）**：配对改用「配对邮箱」轮询（`POST/GET /v1/pairings/{id}/messages`），二维码额外携带 Agent 的 `ed/x` 公钥；控制端用 `HMAC(psk, transcript)` 证明扫过码，双方用 `BindingRecord` 双签完成同等强度的绑定。流程见 §8.9。Lite 默认只支持扫码配对，短码 SPAKE2 留作 v2。

#### 4.3.1 扫码邀约绑定（Controller-initiated invitation，推荐；Lite/Full 通用）

这是受控端采用的默认绑定方式，也是「受控端不再手工粘贴 JSON」的关键。控制端扫 Agent 展示的二维码后，把**自己的身份与绑定请求**用 HPKE 密封后提交给服务端；服务端只排队密文，Agent 在下一次心跳响应里取回并解密，完成绑定后再把加密结果回传给控制端。

```
Agent（PC）                         Relay                         Controller（手机）
   │ POST /v1/pairings               │                                  │
   │  {pid, agent_ed, agent_x,       │                                  │
   │   psk_commit, exp}              │                                  │
   │── QR: pid + psk + relay + keys ──────────────────────────────────▶│ 扫码
   │                                 │◀── POST /v1/pairings/{pid}/invitation
   │                                 │    {psk_commit, envelope}        │
   │◀── 心跳响应 pairings:[{pid, envelope}] ───────────────────────────│
   │  HPKE 解密 → 验 proof/签名 → 建 BindingRecord → 存 meta_key        │
   │ POST /v1/pairings/{pid}/result  │                                  │
   │  {state:"bound", envelope}      │── GET /v1/pairings/{pid} ───────▶│
   │                                 │◀── {state:"bound", result} ──────│
   │                                 │          HPKE 解密 + 验 agent_sig │
```

**二维码内容**

二维码只装一个 opaque token（与「拷贝」形式字节相同，见 §4.3.2）：

```
puppetry://pair?t=<base64url(canonicalJSON(PairingOffer))>
```

- `psk` 是 32 字节一次性秘密，只出现在二维码 / token 与两端内存；**不上送服务端**，不得写日志。
- `psk_commit = base64url(SHA-256(psk_bytes))`，Agent 创建配对时上送；服务端用它校验邀约没有拿错二维码。
- 配对窗口 5 分钟有效、一次性；展示后应提供「取消」按钮。

**邀约明文（Controller → Agent）**

```jsonc
{
  "v": 1,
  "type": "bind.request",
  "pairing_id": "pr_...",
  "binding_id": "bd_...",
  "agent_id": "ag_...",
  "controller_id": "ct_...",
  "controller_ed": "b64url",
  "controller_x": "b64url",
  "scopes": ["presence", "session.list", "session.read", "session.prompt"],
  "created_at": 1761782400000,
  "expires_at": null,
  "ts": 1761782400000,
  "nonce": "b64url(16B)",
  "proof": "b64url(HMAC-SHA256(psk, ...))",
  "controller_sig": "b64url(Ed25519(controller_ed, canonical(bindingPayload)))",
  "exp": 1761782700000
}
```

- `bindingPayload` 就是 §4.4 的 BindingRecord 去掉两个签名后的规范化字段（包含 `agent_ed/agent_x/expires_at:null`）。
- `proof` 原文：
  ```
  "puppetry1-pair\n" || pairing_id || "\n" || controller_ed || "\n" ||
  controller_x || "\n" || ts || "\n" || nonce
  ```
  用 `psk` 做 HMAC-SHA256；Agent 用常量时间比较。它证明控制端确实扫过二维码。
- `controller_sig` 证明控制端持有 `controller_ed` 对应私钥；`controller_id` 必须等于 `ct_ + base32(SHA-256(controller_ed))`。
- 邀约用 **HPKE base** 加密到 `agent_x`：
  ```
  info = "puppetry1/pair-request/" || pairing_id
  aad  = SHA-256(canonical {v, type:"bind.request", pid})
  ```
- 服务端只做四件事：校验 `pairing_id` 存在/未过期、`psk_commit` 匹配、状态为 `waiting`、把 `{enc, ct}` 放进该 Agent 的 pending 队列。

**心跳响应携带**

```json
{
  "pairings": [
    {
      "pairing_id": "pr_...",
      "envelope": { "enc": "b64url", "ct": "b64url" },
      "exp": 1761782700000
    }
  ]
}
```

- 服务端看不到邀约内容，只能看到 `pairing_id`、密文大小与时间。
- Agent 每次心跳都拉取仍在 `invited` 状态的邀约；处理成功后服务端状态变 `bound`，不再下发。
- 同一 `pairing_id` 处理失败（proof/签名/scope 不合法）时，Agent 回 `state:"rejected"` 并清空本地窗口；控制端看到 `rejected` 后重新扫码。

**绑定结果（Agent → Controller）**

```jsonc
{
  "v": 1,
  "type": "bind.result",
  "pairing_id": "pr_...",
  "binding_id": "bd_...",
  "agent_id": "ag_...",
  "agent_ed": "b64url",
  "agent_x": "b64url",
  "controller_id": "ct_...",
  "scopes": ["presence", "session.list", "session.read", "session.prompt"],
  "created_at": 1761782400000,
  "agent_sig": "b64url(Ed25519(agent_ed, canonical(bindingPayload)))",
  "meta_key": "b64url(32B)",
  "meta_epoch": 1,
  "ts": 1761782400000,
  "result_sig": "b64url(Ed25519(agent_ed, canonical(result_without_result_sig)))"
}
```

- `agent_sig` 让控制端验证 BindingRecord 确实是 Agent 签的；`result_sig` 额外覆盖 `meta_key/meta_epoch`，防止服务端替换元数据密钥。
- 结果用 **HPKE Auth** 从 Agent 发给控制端（控制端从二维码已知 `agent_x`）：
  ```
  info = "puppetry1/pair-result/" || pairing_id
  aad  = SHA-256(canonical {v, type:"bind.result", pid})
  ```
- Agent 提交：
  ```
  POST /v1/pairings/{pid}/result
  { "state": "bound", "envelope": { "enc": "b64url", "ct": "b64url" } }
  ```
  拒绝时：`{ "state": "rejected", "reason": "scope_denied:..." }`（reason 不含敏感内容）。
- **登记绑定**：建立绑定后，Agent 应把 BindingRecord 的公开字段与双签 `POST /v1/bindings` 登记到服务端（幂等，同 `binding_id` 覆盖），供服务端做粗粒度 ACL、presence 路由与指令投递；若 Agent 登记失败，控制端在 `GET /v1/pairings/{pid}` 拿到 `bound` 并验签通过后也应登记一次作为兜底。
- 控制端轮询：
  ```
  GET /v1/pairings/{pid}
  X-Puppetry-Pairing-Commit: <psk_commit>
  → { "state": "waiting" | "invited" | "bound" | "rejected" | "expired",
      "exp": ..., "result": { "enc": "...", "ct": "..." } }
  ```
  拿到 `result` 后用控制端 X25519 私钥 + `agent_x` 解密，验证 `result_sig`，保存 BindingRecord 与 `meta_key`。

**受控端响应结果的交互过程（状态机）**

这是协议必须一致的部分：受控端收到邀约后如何把「响应结果」交回控制端。

服务端为每个 `pairing_id` 维护单一状态，合法迁移如下：

```
waiting ──invitation──▶ invited ──Agent 提交 result──▶ bound / rejected
   │                        │
   │◀──── 超时 / cancel ─────┘
   ▼
expired / cancelled
```

1. **waiting → invited**：控制端 `POST /v1/pairings/{pid}/invitation` 提交密文邀约；服务端校验 `pairing_id` 存在、未过期、`psk_commit` 匹配后置为 `invited`，并把密文塞进该 Agent 的待处理队列。
2. **Agent 取回并处理**：Agent 在下一次心跳响应的 `pairings[]` 里取回 `{pairing_id, envelope, exp}`；解密、验 `proof`/`controller_sig`/scope 策略。
3. **Agent 交回结果**：无论成功与否，Agent 都调用
   ```
   POST /v1/pairings/{pid}/result
   { "state": "bound", "envelope": {...} }        // 成功
   { "state": "rejected", "reason": "..." }        // 失败
   ```
   服务端据此把状态置为终态 `bound` / `rejected`。
4. **控制端取结果**：控制端轮询 `GET /v1/pairings/{pid}`，进入终态后拿到 `result`（或 `reason`），解密、验签、持久化绑定。
5. **幂等**：服务端只接受第一次终态写入；重复提交终态返回冲突/忽略。Agent 收到 `invited` 后应尽快处理，处理后不得再对该 `pairing_id` 重复提交。

> **是否要「显式确认」是本地授权策略，不是线协议要求。** 协议只约束终态 `bound`/`rejected` 的语义与信封格式。某个实现可以自动绑定（把「扫到二维码」当作授权凭据），也可以先在本地弹出确认、暂不交终态；若想暴露「等待确认」，实现可自行加一个 `pending` 状态作为**扩展**，控制端轮询到 `pending` 就继续等。参考实现采用自动绑定（凭 `psk` + 签名 + scope 策略），并不要求其他实现也这样做。

**协议设计与实现策略的边界**

| 类别 | 内容 | 是否属于协议 |
| --- | --- | --- |
| 端点/状态机 | `/v1/pairings*`、`waiting→invited→bound/rejected`、心跳 `pairings[]` 字段 | ✅ 协议，必须一致 |
| 密码学 | QR 字段、`psk_commit`、`proof`、`controller_sig`、HPKE info/aad、`result_sig` | ✅ 协议，必须一致 |
| 响应结果 | `state:"bound"|"rejected"`、`envelope`、`reason`、幂等语义 | ✅ 协议，必须一致 |
| 心跳加速 | 展示二维码时把心跳间隔临时降到 2s | ⚠️ 实现策略，可自行选择 |
| 即时回传 | 处理完邀约后立刻再发一次心跳/立即 `POST result`，不等下一个周期 | ⚠️ 实现策略，可自行选择 |
| 长轮询/批量确认 | `?wait=25`、命令/结果合并下发 | ⚠️ 实现策略，可自行选择 |

实现策略的结论：**展示二维码期间心跳可加密到秒级，处理完邀约后立即交结果**，是为了缩短「扫码 → 绑定完成」的感知延迟；它不改变任何线上字段，其他实现无需复刻也能互操作。协议只保证：只要心跳里出现 `pairings[]`，Agent 最终会交一个终态 `result`，控制端最终能轮询到它。

**端点**

| 方法 | 路径 | 调用方 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/v1/pairings` | Agent | 创建配对窗口（`pid, agent_ed, agent_x, psk_commit, exp`） |
| `POST` | `/v1/pairings/{pid}/invitation` | Controller | 提交 HPKE 密封邀约（可只带 `psk_commit`，无需账号） |
| `GET` | `/v1/pairings/{pid}` | Controller | 查询状态/结果；`X-Puppetry-Pairing-Commit` 校验 |
| `POST` | `/v1/pairings/{pid}/result` | Agent | 提交绑定结果/拒绝原因（密文） |
| `POST` | `/v1/pairings/{pid}/cancel` | 任一方 | 取消窗口 |

**安全性质与边界**

- 服务端无 `psk`、无 Agent/Controller 私钥，无法解密邀约或结果，也无法伪造 `proof`/签名。
- 重放：`pairing_id` 一次性 + 服务端状态机 + 邀约 `exp/ts/nonce`；结果只接受一次。
- 中间人：控制端从二维码拿到 Agent 公钥，结果签名可验证；Agent 用 `psk` HMAC 验证控制端扫过码。服务端替换二维码/公钥会被 `proof` 或 `agent_sig` 检出。
- 绑定授权：Agent 默认只接受策略内的 scopes；请求超出（如 `project.create`/`admin`）直接 `rejected`，不会静默降权。
- 二维码含 `psk`，**只在本机屏幕展示**；不要投屏、截图、发群。配对窗口关闭/过期后 `psk` 立即失效。
- 手工导入 BindingRecord 仍保留为离线/救援路径，不再是主流程。

#### 4.3.2 统一配对信息：一种消息、一种编码、两种载体

受控端与控制端建立绑定控制关系，无论「扫码」还是「拷贝内容」，控制端从受控端取得的**信息格式完全一致**；扫码/拷贝只是呈现与交付的实现差异，不属于协议分歧。

**语义消息 `PairingOffer`**

```jsonc
{
  "v": 1,
  "relay": "https://relay.example.com",
  "pid": "pr_...",
  "psk": "b64url(32B)",          // 一次性秘密，只出现在两端内存
  "agent_id": "ag_...",
  "agent_ed": "b64url(32B)",     // Agent Ed25519 公钥
  "agent_x": "b64url(32B)",      // Agent X25519 公钥
  "name": "Office PC",           // 可选，仅展示
  "exp": 1761782700000
}
```

字段名用可读形式（`agent_id / agent_ed / agent_x / relay / pid / psk / name / exp`）——因为字段名不直接出现在二维码里（它在 base64url 内部），不需要为了压缩二维码而牺牲可读性。

**规范编码（唯一 token）**

```
payload = base64url( UTF-8( canonicalJSON(PairingOffer) ) )
```

- `canonicalJSON`：键按字典序、无多余空白、UTF-8 原样、最小 JSON 转义（确定性）。
- `base64url`：RFC 4648 §5，URL-safe、无填充，便于二维码 byte 模式与文本拷贝。

**两种载体（纯呈现）**

| 载体 | 形式 | 说明 |
| --- | --- | --- |
| 二维码 | `puppetry://pair?t=<payload>` | URI scheme 用于路由到 App，`t` 里只装那一个 payload |
| 拷贝 | `puppetry1:pair:<payload>` | 自描述前缀，便于识别/过滤/脱敏 |

二维码与拷贝承载**字节完全相同**的 payload。控制端只需一个解析入口 `parsePairOffer(input)`：识别 `puppetry://pair?t=` 取 `t`（或去掉 `puppetry1:pair:` 前缀）→ base64url 解码 → canonicalJSON 解析 → 校验 `v` / 必填字段 / `exp`。

**统一的交互流程**

两条载体共用 §4.3.1 的全部状态机、端点与信封，流程固定为：

1. **从受控端获取信息**：受控端生成配对窗口，产出 `PairingOffer` 并渲染为二维码或 token；控制端扫码或拷贝，得到 `relay / pid / psk / agent_id / agent_ed / agent_x / exp`。
2. **控制端发出邀约**：构造 §4.3.1 的 `bind.request`，HPKE 密封到 `agent_x`，`POST /v1/pairings/{pid}/invitation`（可只带 `psk_commit`，无需账号）。
3. **服务器传递邀约**：服务端只校验 `pairing_id` / `psk_commit` / `exp` 与状态，把密文放进待处理队列，随心跳 `pairings[]` 下发；服务端无法解密。
4. **服务器传递响应**：受控端解密、验 `proof` / `controller_sig` / scope 策略，建 BindingRecord，`POST /v1/pairings/{pid}/result` 交 `bound` / `rejected`；控制端轮询 `GET /v1/pairings/{pid}` 取终态并解密结果。

> 结论：扫码与拷贝在协议层**只有载体不同**，消息格式与后续流程完全相同。token / 二维码含一次性 `psk`，只在本机展示、5 分钟有效、一次性，不得写日志、不得缩网址。

**界面（实现建议，非线协议）**：扫码与拷贝是同一消息的两种交付，实现应只提供一个绑定入口，避免双端各留两套操作——受控端一个「生成 token」按钮同时展示二维码与 token 文本，并提供「复制 token」与有效期倒计时；控制端一个「受控端 token」输入框（支持粘贴）+「扫码绑定」（扫码后自动填入）+「绑定」按钮。手工导入 BindingRecord 仍保留为离线/救援路径，不作为主流程入口。

**方式 B：8 位短码 + SPAKE2（无摄像头/远程口述）**

1. Agent 显示 `pairing_id` + 8 位数字短码（高熵随机，非用户自选）。
2. Controller 输入短码，双方在配对隧道（或配对邮箱）上跑 **SPAKE2**（RFC 9382），以短码为低熵口令。
3. SPAKE2 把低熵口令升为高强度会话密钥，抵抗离线字典攻击；服务端只能在线暴力尝试，需配合每 IP/每 pairing 的严格限速。
4. 成功后同样交换身份公钥、签署 BindingRecord；SAS 可省略（PAKE 已完成双向认证）。
5. 短码配对无需摄像头，适合「远程口述」或「无摄像头设备」；因码短，务必限速并设置短配对窗口。

**方式 C：手工导入 BindingRecord（离线/救援）**

1. 控制端离线生成身份与 BindingRecord（§4.4 结构），把公开字段与双签导出为文件或文本。
2. 受控端在设置页手工导入，本地验签后建立绑定。
3. 方向为「控制端 → 受控端」，不经服务端配对窗口，用于无在线信道或救援场景，不作为主流程。

### 4.4 绑定记录（BindingRecord）

```json
{
  "v": 1,
  "binding_id": "bd_...",
  "agent_id": "ag_...",
  "agent_ed": "b64url",
  "agent_x":  "b64url",
  "controller_id": "ct_...",
  "controller_ed": "b64url",
  "controller_x":  "b64url",
  "scopes": ["presence", "session.list", "session.read", "session.prompt",
             "session.create", "session.cancel", "session.organize",
             "env.read", "approval.respond", "project.create", "tunnel"],
  "created_at": 1761782400000,
  "expires_at": null,
  "agent_sig": "Ed25519(ag_ed, canonical(payload))",
  "controller_sig": "Ed25519(ct_ed, canonical(payload))"
}
```

- 三份副本：Agent 本地（权威）、Controller 本地（权威）、Server（公开字段 + 双签，用于路由与粗粒度 ACL）。
- **授权以 Agent 本地为准**：服务端即使被攻破、伪造绑定，Agent 仍会用本地绑定与公钥校验指令，拒绝未知控制端。
- `scopes` 在配对时由 Agent UI 展示并可裁剪；默认最小集：`presence`、`session.list`、`session.prompt`。

### 4.5 多控制端、撤销与轮换

| 场景 | 动作 |
| --- | --- |
| 新增第二台手机 | 再走一次配对，生成独立 `binding_id`、独立计数器、独立 `mk` 分发 |
| 手机丢失 | 在 Agent UI（或另一台有 `admin` scope 的控制端）撤销该 binding；Agent 心跳上报 `bindings.epoch++`；服务端停止路由；Agent 本地删除公钥 |
| 控制端主动解绑 | 调 `DELETE /v1/bindings/{id}`；Agent 下次心跳收到撤销并本地确认 |
| 元数据密钥轮换 | 撤销后 Agent 生成 `mk(epoch+1)`，用 HPKE 逐个封装给剩余控制端；旧控制端无法解密新摘要 |
| Agent 换钥/重装 | `agent_id` 改变，所有绑定失效，必须重新配对（v1 不做在线轮换） |
| 服务端被攻破 | 攻击者能删队列/拒绝服务，但无法伪造指令（HPKE Auth）或解密历史（无密钥） |

---

## 5. 端到端加密设计

### 5.1 密码套件

v1 只允许一套，禁止协商降级：

```
Puppetry1_SUITE = X25519-HKDF-SHA256-CHACHA20POLY1305
  KEM:  DHKEM(X25519, HKDF-SHA256)        (RFC 9180 §7.1)
  KDF:  HKDF-SHA256                       (RFC 5869)
  AEAD: ChaCha20-Poly1305                 (RFC 8439)
  SIG:  Ed25519                           (RFC 8032)
  HASH: SHA-256
```

实现方必须在 `server/info` 与 `hello` 中声明套件；不在白名单内直接拒绝，不做「尽力兼容」。

### 5.2 异步信封（HPKE Auth）

用于：指令（Controller → Agent）、结果（Agent → Controller）、密钥分发（Agent → Controller）、事件（Agent → Controller）。

```jsonc
{
  "v": 1,
  "suite": "X25519-HKDF-SHA256-CHACHA20POLY1305",
  "kind": "cmd",            // cmd | res | evt | key
  "bid": "bd_...",          // binding id，绑定授权上下文
  "sid": "ct_...",          // sender device id
  "rid": "ag_...",          // recipient device id
  "kid": "....",            // sender key id
  "ctr": 42,                // 每个 (bid, kind, direction) 单调递增
  "ts": 1761782400000,
  "exp": 1761786000000,
  "mid": "cmd_...",         // 消息 id（也是幂等键）
  "ref": "ses_...",         // 可选：关联会话/指令
  "enc": "b64url",          // HPKE encapsulated key
  "ct":  "b64url"           // AEAD 密文
}
```

**线上序列化**：当信封作为 HTTP 字段传输（心跳 `commands[].envelope`、`POST /commands` 的 `envelope`、`POST /commands/{id}/result` 的 `envelope`）时，一律为 `base64url(JSON(上述信封对象))` 字符串，服务端不解析；配对邀约/结果的 `envelope` 则保持 `{enc, ct}` 对象（见 §4.3.1）。

加密：

```
info = "puppetry1/" || kind || "/" || bid
aad  = SHA-256("puppetry1-aad" || canonical_cbor(header_without_enc_ct))
(ctx, enc) = SetupAuthS(pkR = recipient_x25519_pub, skS = sender_x25519_sk, info)
ct = ctx.Seal(aad, plaintext)
```

- `mode_auth` 让接收方确认「确实持有 `sid` 对应私钥的发送方」，不需要额外签名；`kind="key"` 的载荷里再带 Ed25519 签名，便于审计。
- 明文是 CBOR map（或 JSON，二选一由 `content_type` 声明；推荐 CBOR 省流量）。
- **每条消息独立 HPKE**：指令之间没有链式状态，适合「服务端排队、随机时刻投递」的邮箱模型。

**前向保密边界（必须诚实说明）**：异步邮箱在「Agent 长期私钥未来被攻破」的情况下，历史密文可被解密（HPKE Auth 的 KEM 共享秘密依赖收件人静态私钥）。缓解：

1. `exp` 短（指令默认 24 小时；审批/提问应答等时效性指令 10 分钟）；
2. 服务端结果/指令 TTL 到期即删；
3. Agent 侧按 epoch 轮换 `mk`，但不解决指令本身；
4. 真正需要 FS 的交互走隧道（Noise IK 每连接临时密钥）。

### 5.3 隧道握手（Noise IK）

```
Noise_IK_25519_ChaChaPoly_SHA256:
  <- s
  ...
  -> e, es, s, ss
  <- e, ee, se
```

- Controller 是发起方（它已从绑定记录知道 Agent 的静态公钥）；Agent 是响应方。
- `prologue = "puppetry1/tunnel" || tunnel_id || binding_id || controller_id || agent_id || v1`
- 握手完成后双方校验对端静态公钥与绑定记录**逐字节一致**，不一致立即断开。
- 隧道内所有业务帧都是 Noise transport 密文；服务端只看到长度与时序。
- 每次隧道重新握手，天然获得每连接前向保密与重放保护（Noise nonce 单调）。

### 5.4 元数据密封（会话标题等）

心跳只上报 `{epoch, rev, hash, count}`，真正的会话列表是一个密封 blob（Lite 用 JSON 编码，见 §8.9.1；Full 可选 CBOR 但须经 `content_type` 声明）：

```
digest_plain = {
  "mode": "sealed",              // "sealed"（含标题/路径/消息）| "summary"（仅 id/状态，无标题/路径）
  "epoch": 3,
  "sessions": [{
    "id": "ses_...",
    "title": "修复登录页",        // 仅 mode="sealed"
    "running": true,
    "updatedAt": 1761782400000,
    "origin": "root" | "subagent",
    "parentId": null,
    "archived": false,
    "cwd": "D:/work/foo",         // 仅 mode="sealed" 且存在
    "messages": [                 // 仅 mode="sealed"；该会话最近 m 条（增量窗口，≤ m 条）
      { "role": "user" | "assistant" | "tool", "text": "…", "ts": 1761782400000, "seq": 91 }
    ]
  }]
}
digest_blob = nonce(12) || AEAD(mk, digest_plain,
                aad = "digest|" || agent_id || "|" || epoch || "|" || rev)
```

- `||` 为字节级 UTF-8 拼接；`nonce` 为 12 字节随机数，前置到密文；`aad` 用字符串形式而非裸二进制拼接，避免 epoch/rev 的字节宽度歧义。
- Server 存最新 blob（≤ 256 KiB；Lite ≤128 KiB），超过则截断并置 `truncated:true`，控制端按需走隧道拉全量。
- 控制端 `GET /v1/agents/{id}/digest` 取回 blob，用本地 `mk` 解密；`mk` 即配对结果 `bind.result.meta_key`（32 字节，**agent 级共享**：同一 Agent 的所有 binding 复用同一 `mk`，以便每个控制端都能解密同一份摘要）。
- `mk` 分发：配对完成后 Agent 生成并经 `bind.result.meta_key` 交给新控制端；撤销时轮换。
- 退化模式：尚未配对（无 `mk`）时 `mode:"summary"`，只上报 `id/running/updatedAt/origin/parentId/archived`，标题与路径不上送（隐私最低但兼容性最好）。

### 5.5 重放、顺序与时钟

| 机制 | 规则 |
| --- | --- |
| 计数器 | 每个 `(binding_id, kind, sender)` 独立 `ctr`，严格 +1；接收方持久化 high-water mark |
| 重放 | `ctr ≤ hwm` 且 `mid` 不在去重窗口 → `replay_detected` 并审计；重复 `mid` 直接返回缓存结果 |
| 乱序 | 邮箱按 binding FIFO 投递；Agent 收到 gap 时发 `resync {after_ctr}`，服务端从队列重发 |
| 过期 | `exp < now - 300s` 拒绝；`ts` 只用于诊断，不参与安全判定 |
| 时钟 | Agent 用心跳响应里的 `server_time` 维护偏移；控制端同理 |
| 跨绑定 | `bid` 参与 HPKE `info` 与 AAD，换绑定无法解密/通过校验 |

### 5.6 服务端能看到什么

| 可见 | 不可见 |
| --- | --- |
| 设备 id、角色、公钥、显示名、账号归属 | 指令类型与参数、prompt、回复、工具输出 |
| 在线状态、心跳时间、隧道时长、字节数 | 会话标题、workspace 路径、文件内容 |
| 摘要 epoch/rev/hash/count、信封大小 | 元数据密钥、任何私钥 |
| 推送 token、事件「有结果/有审批」 | 结果内容、审批详情 |

> 设计上接受「流量分析」这一残余风险：服务端能看出「什么时候有通信、大概多大」。高敏感场景可在信封层做固定长度填充与随机延迟（v2 可选）。

---

## 6. 控制面协议（心跳 + 邮箱）

「邮箱」（mailbox）在本协议中指服务端为每个设备维护的待投递加密消息队列（定义见 §0 摘要）：控制端把加密指令投递到受控端的邮箱，受控端在下一次心跳时取走并执行，再回传加密结果。本章规定这一「心跳 + 邮箱」控制面的全部端点、消息结构与可靠性语义。

### 6.1 端点总览

| 方法 | 路径 | 认证 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/v1/devices/enroll` | 设备自签 | 注册，换取令牌 |
| `POST` | `/v1/devices/token` | refresh + DPoP | 轮换 access token |
| `POST` | `/v1/pairings` | Agent | 创建配对窗口 |
| `POST` | `/v1/pairings/{id}/join` | Controller | 加入配对 |
| `POST` | `/v1/pairings/{id}/invitation` | Controller | 提交加密绑定邀约（扫码，§4.3.1） |
| `GET` | `/v1/pairings/{id}` | Controller | 查询配对状态/结果（`X-Puppetry-Pairing-Commit`） |
| `POST` | `/v1/pairings/{id}/result` | Agent | 提交绑定结果/拒绝（密文） |
| `POST` | `/v1/pairings/{id}/cancel` | 任一方 | 取消配对窗口 |
| `POST` | `/v1/pairings/{id}/messages` | 双方 | 配对邮箱：投递握手/绑定消息（Lite） |
| `GET` | `/v1/pairings/{id}/messages?after_seq=` | 双方 | 拉取配对消息（Lite） |
| `GET` | `/v1/pairings/{id}/ws` | 一次性 ticket | 配对隧道（WSS，Full 可选） |
| `POST` | `/v1/bindings` | Agent | 登记绑定（公开字段 + 双签） |
| `DELETE` | `/v1/bindings/{id}` | 任一方 | 撤销 |
| `POST` | `/v1/agent/hb` | Agent DPoP / Puppetry1-Sig | 心跳（可 `?wait=25` 长轮询；Lite 不支持 wait） |
| `GET` | `/v1/agents/{id}` | Controller | 在线状态、最后活跃、能力 |
| `GET` | `/v1/agents/{id}/digest` | Controller | 取密封会话摘要 |
| `POST` | `/v1/agents/{id}/commands` | Controller | 提交指令（密文） |
| `GET` | `/v1/commands/{id}` | 提交者 | 取指令状态/结果 |
| `POST` | `/v1/commands/{id}/result` | Agent | 回传结果（密文） |
| `POST` | `/v1/agents/{id}/events` | Agent | 主动事件（审批请求、turn end） |
| `PUT` | `/v1/agents/{id}/sessions/{sid}/snapshots` | Agent | 上传加密增量快照（Lite） |
| `GET` | `/v1/agents/{id}/sessions/{sid}/snapshots?after_seq=` | Controller | 拉取增量快照（Lite） |
| `GET` | `/v1/controller/inbox` | Controller | 拉取结果/事件（可长轮询） |
| `POST` | `/v1/controller/inbox/ack` | Controller | 确认消费 |
| `POST` | `/v1/tunnels` | Controller | 申请隧道 |
| `GET` | `/v1/tunnels/{id}/ws` | 双方 ticket | 隧道（WSS，二进制） |
| `POST` | `/v1/push/register` | Controller | 注册推送 token |
| `GET` | `/.well-known/puppetry` | 无 | 服务端能力发现 |

> `/v1/tunnels/*` 只有 Full Relay 提供。Lite 对隧道申请返回 `501 tunnel_unavailable`，可在错误体里带 `alternate_relay`（外部数据面地址），控制端据此走 §8.9 的降级路径或切换外部 relay。

### 6.2 心跳请求

```jsonc
POST /v1/agent/hb
Authorization: DPoP <token>          # Lite: Puppetry1 device="...", ts="...", nonce="...", sig="..."
Content-Type: application/cbor            # Lite: application/json

{
  "v": 1,
  "agent_id": "ag_...",
  "boot_id": "b_7f3a...",           // 每次进程启动变化，用于识别重启
  "seq": 1042,                       // 进程内单调，诊断用
  "ts": 1761782400000,
  "presence": "online",             // online | busy | dnd
  "version": { "agent": "0.1.0", "dsh": "0.2.1", "protocol": "1.0" },
  "caps": ["mailbox", "tunnel", "sealed-meta", "approval", "project.create"],
  "limits": { "max_cmd": 65536, "max_result": 262144, "max_streams": 64 },
  "digest": { "epoch": 3, "rev": 57, "hash": "sha256:...", "count": 12 },
  "active": { "running": 1, "tunnel": null },
  "health": { "cpu": 0.18, "mem": 0.42, "disk_free": 123456789012 },
  "bindings": { "count": 2, "epoch": 5 },
  "acks": [ { "command_id": "cmd_...", "state": "done" } ],
  "resync": [ { "binding_id": "bd_...", "after_ctr": 41 } ]
}
```

### 6.3 心跳响应

```jsonc
{
  "v": 1,
  "server_time": 1761782400123,
  "next_hb_ms": 30000,               // 服务端可动态调整（10s–120s）
  "commands": [{
    "id": "cmd_...",
    "binding_id": "bd_...",
    "envelope": "b64url",            // 完整 HPKE 信封对象的 base64url(JSON(envelope))，服务端不解析
    "exp": 1761786000000,
    "attempt": 1
  }],
  "pairings": [{                     // 扫码邀约，见 §4.3.1；服务端只搬运密文
    "pairing_id": "pr_...",
    "envelope": { "enc": "b64url", "ct": "b64url" },
    "exp": 1761782700000
  }],
  "tunnel": {                        // 有控制端申请隧道时下发
    "id": "tn_...",
    "token": "b64url",               // 一次性、绑定 role
    "exp": 1761782700000,
    "purpose": "session.attach"
  },
  "bindings": { "revoked": ["bd_..."], "epoch": 6 },
  "config": { "hb_ms": 30000, "long_poll_ms": 25000 }
}
```

规则：

- `commands` 按 binding FIFO；单次最多 32 条 / 512 KiB；超出时 `has_more=true`，Agent 立即再发一次心跳。
- `pairings` 是待处理的扫码绑定邀约；Agent 解密、验 `proof`/`controller_sig`、建 BindingRecord，然后 `POST /v1/pairings/{id}/result`。服务端不解析 `envelope`。
- 服务端不解析 `envelope`，只校验大小、TTL、绑定存在。
- `tunnel` 是「offer」：Agent 收到后自行连接；连接失败不影响心跳。
- `bindings.revoked` 是权威撤销列表；Agent 必须本地删除并停止受理。
- 响应可压缩（CBOR + gzip/br）；移动网络下 30s 一次的空响应应 < 200 字节。

### 6.4 会话摘要同步（Lite 发 prompt 的基础）

```
Agent 本地会话/消息变化
  → 重新生成 digest_plain（最近 n 个会话 × 每会话 m 条消息，增量窗口）
  → 内容 hash 变化才 rev++ 并重新密封上传；无变化则跳过（服务端保留旧 blob）
  → PUT /v1/agents/{id}/digest  {epoch, rev, hash, count, mode, blob}
  → 心跳带 {epoch, rev, hash, count}
  → Controller GET /v1/agents/{id}/digest
      200  → {epoch, rev, blob} → 用 mk 解密 → 更新会话/消息 UI
```

- **消息窗口**：受控端只带最近 `n` 个会话（按 `updatedAt` 降序）与每会话最近 `m` 条消息（受控端默认 n=10、m=20，可调）；消息文本截断（每条约 1 KiB）以控制 blob 体积，Lite 摘要 ≤128 KiB。
- **增量提交**：受控端对 digest_plain 做哈希，`hash` 未变则不重复 `PUT`（`rev`/`hash` 不变）；控制端按 `rev` 判断是否有新内容，前台按需拉取（不触发推送）。
- **发 prompt**：控制端对已有会话 `POST /v1/agents/{id}/commands` 提交 `session.prompt` 指令（HPKE Auth 信封），受控端心跳取回执行后 `POST /v1/commands/{id}/result` 回传 `{accepted, turn_id}`；控制端轮询 `GET /v1/commands/{id}` 取结果（见 §6.5）。
- **本地清理**：控制端在浏览器 IndexedDB 只保留最近 `n` 个会话 × 每会话 `m` 条消息，超过阈值的消息定期清理（阈值可在控制端配置）。
- 心跳里只有 hash，不传标题/消息；服务端只存 blob，无法做内容索引。
- 较复杂操作（新建工作区、翻看更久历史）需走 `session.create` / `session.page` 等受控端指令或隧道，不在本摘要窗口内（见 §8.9.4 / §9.3）。

### 6.5 指令生命周期

```
Controller                 Server                    Agent
   │ POST /commands           │                        │
   │  {id, bid, envelope}     │                        │
   │─────────────────────────▶│ 入队（TTL 24h）         │
   │ 202 {state:"queued"}     │                        │
   │                          │◀── 心跳（或长轮询）──────│
   │                          │── 响应 commands[] ─────▶│
   │                          │                        │ 解密 → 校验
   │                          │                        │ ctr/exp/scope
   │                          │                        │ 执行 Host Adapter
   │                          │◀── POST /result ───────│
   │                          │ 存结果（TTL 24h）       │
   │◀── 长轮询/推送通知 ───────│                        │
   │ GET /commands/{id}       │                        │
   │─────────────────────────▶│                        │
   │ 200 {state, envelope}    │                        │
   │◀─────────────────────────│                        │
```

状态机：

```
CREATED ──submit──▶ QUEUED ──deliver──▶ DELIVERED ──ack──▶ EXECUTING
                       │                    │                 │
                       │ TTL 到期            │ 重投（≤3 次）    ├─▶ DONE
                       ▼                    ▼                 ├─▶ ERROR
                    EXPIRED              QUEUED               └─▶ DENIED(policy)
```

可靠性规则：

| 规则 | 说明 |
| --- | --- |
| 至少一次 + 幂等 | 服务端可能重投；Agent 按 `command_id` 去重，缓存结果 7 天 |
| 顺序 | 同一 binding 内严格 FIFO；不同 binding 可并行 |
| 超时 | Agent 执行超过 `exec_timeout`（默认 60s，`session.prompt` 只等待「已受理」）→ 返回 `accepted` 而非阻塞 |
| 结果大小 | ≤ 256 KiB；超出时结果只放摘要 + `result_ref`，细节走隧道 |
| 取消 | Controller 可 `DELETE /v1/commands/{id}`；已投递的指令由 Agent 尽力取消，不保证 |
| 离线 | Agent 离线时指令留在队列；控制端看到 `queued` 与 `agent_offline` 标记 |

### 6.6 长轮询与延迟优化

纯心跳的指令延迟 = 心跳间隔（默认 30s，最坏 30s）。为了让「发一句话」接近即时，同时不引入常连：

1. **交互态长轮询**：控制端打开某个会话/刚提交指令时，Agent 切到 `POST /v1/agent/hb?wait=25`；服务端在没有指令时挂起最多 25s，有指令立即返回。
2. **邮箱唤醒**：Agent 处于长轮询时，新指令直接完成该请求；否则等下一次心跳。
3. **配对/隧道窗口**：Agent 展示配对码或刚收到 tunnel offer 时，临时切长轮询 2 分钟。
4. **空闲回退**：无交互 2 分钟后回到 30s 心跳；电池/流量友好。

> 这不违反「简单操作不必建立持续性长连接」：长轮询仍是请求-响应，服务端不维护 per-connection 会话状态；只是把「等待」放在一次 HTTP 请求里。

**Lite 不提供长轮询**：`features.long_poll=false`，Agent 按 `heartbeat.min_ms/max_ms` 固定间隔发心跳；控制端提交指令后按 1s → 2s → 5s → 10s 退避拉取结果，前台时最长 30s 放弃并提示「已排队，稍后通知」。这让单次请求的执行时间保持在共享主机允许的范围内。

### 6.7 错误码

| code | HTTP | 含义 | 可重试 |
| --- | --- | --- | --- |
| `unauthorized` | 401 | 令牌无效/DPoP 失败 | 否（刷新后重试） |
| `binding_revoked` | 403 | 绑定已撤销 | 否 |
| `binding_not_found` | 404 | 绑定不存在 | 否 |
| `agent_offline` | 409 | 受控端离线（指令仍可入队） | 是 |
| `queue_full` | 429 | 邮箱满 | 是（退避） |
| `payload_too_large` | 413 | 超过上限 | 否 |
| `replay_detected` | 409 | 重放/计数器异常 | 否 |
| `expired` | 410 | 指令过期 | 否 |
| `unsupported_version` | 426 | 协议版本不兼容 | 否 |
| `rate_limited` | 429 | 限流 | 是 |
| `policy_denied` | 403 | 受控端本地策略拒绝 | 否 |
| `session_busy` | 409 | 会话忙且策略不允许排队 | 是 |
| `tunnel_unavailable` | 501 | 当前服务端不支持隧道（Lite） | 否（降级或换 relay） |
| `unsupported_auth` | 401 | 服务端不支持该认证方式 | 否 |
| `encoding_unsupported` | 415 | 不支持请求的编码（JSON/CBOR） | 否 |
| `internal` | 500 | 服务端错误 | 是 |

---

## 7. 数据面协议（按需隧道）

### 7.1 建立流程

```
Controller                     Server                        Agent
   │ POST /v1/tunnels            │                              │
   │ {agent_id, purpose, ttl}    │                              │
   │────────────────────────────▶│ 创建 tunnel_id + 两个 ticket  │
   │ 201 {id, token, exp}        │                              │
   │◀────────────────────────────│                              │
   │ WSS /tunnels/{id}?role=c    │                              │
   │════════════════════════════▶│◀── 心跳响应 tunnel offer ─────│
   │                             │     (id, token, purpose)      │
   │                             │◀── WSS /tunnels/{id}?role=a ──│
   │◀════ 服务端配对，开始转发二进制帧 ═════════════════════════▶│
   │◀════ Noise IK 握手（prologue 绑定 tunnel/binding/双方 id）══▶│
   │◀════ JSON-RPC over multiplexed streams ═══════════════════▶│
```

- 隧道 ticket 是**一次性 bearer**：只用于拿到 socket，不构成身份；身份由 Noise 握手证明。
- 服务端最多等 15s 让双方到齐；超时关闭。控制端可重试。
- 隧道默认 TTL 300s，活动期间可 `tunnel.extend`；空闲 90s 关闭。
- 服务端不解析 Noise 明文，只按外层帧转发；可做字节级限速与连接数限制。
- 隧道是 **L2 能力**：Lite Relay 不提供 WSS。控制端收到 `tunnel_unavailable` 后按 §8.9 改用快照拉取，或切换到外部 relay（Hybrid），不对同一 Lite 端点反复重试。

### 7.2 外层帧（服务端可见）

```
0        1        2        3        4        5        6 ...
+--------+--------+--------+--------+--------+--------+
| type   | flags  |            length (u32)            |
+--------+--------+--------+--------+--------+--------+
| payload (Noise ciphertext, ≤ 64 KiB)                |
+-------------------------------------------------------+
```

| type | 名称 | 说明 |
| --- | --- | --- |
| `0x01` | DATA | Noise 密文 |
| `0x02` | PING | 保活（服务端可回应） |
| `0x03` | PONG | 保活应答 |
| `0x04` | CLOSE | `{code, reason}`，关闭隧道 |
| `0x05` | WINDOW | 外层背压（可选；默认靠 TCP） |

### 7.3 内层多路复用（Noise 明文内）

```
+--------+--------+--------+--------+----------------+--------+
| ver(1) | type(1)| flags(2)| stream(4) | seq(8)       | len(4) |
+--------+--------+--------+--------+----------------+--------+
| payload ...                                                  |
+--------------------------------------------------------------+
```

| type | 名称 | 说明 |
| --- | --- | --- |
| `0x01` | OPEN | 开流，payload = 方法名/订阅参数 |
| `0x02` | DATA | 流数据（JSON-RPC 消息） |
| `0x03` | CLOSE | 正常关闭 |
| `0x04` | RESET | 异常终止 |
| `0x05` | WINDOW | 信用窗口（初始 256 KiB，消费后归还） |
| `0x06` | PING/PONG | 隧道内 RTT |
| `0x07` | GOAWAY | 节点迁移/优雅关闭 |

- `stream_id` 由发起方分配（Controller 用奇数，Agent 用偶数），避免碰撞。
- 每条流独立 `seq`，接收方校验单调；乱序丢弃并 `RESET`。
- 最多 64 条并发流；每条流独立流控，防止大响应饿死交互流。

### 7.4 RPC 方法（Controller → Agent）

| 方法 | 参数 | 返回 | scope |
| --- | --- | --- | --- |
| `rpc.discover` | `{}` | `{methods, caps, limits}` | `session.list` |
| `session.list` | `{include_archived?}` | `{sessions[]}` | `session.list` |
| `session.get` | `{session_id}` | `{session}` | `session.read` |
| `session.history` | `{session_id, before_seq?, limit?}` | `{messages[], steps[], has_more}` | `session.read` |
| `session.create` | `{cwd?, title?, preset?, permission?, model?}` | `{session}` | `session.create` |
| `session.prompt` | `{session_id, text, delivery?}` | `{turn_id, accepted}` | `session.prompt` |
| `session.cancel` | `{session_id}` | `{cancelled}` | `session.cancel` |
| `session.rename` | `{session_id, title}` | `{}` | `session.organize` |
| `session.archive` | `{session_id, stop?}` | `{}` | `session.organize` |
| `session.attach` | `{session_id, after_seq?}` | **流**：事件 | `session.read` |
| `session.detach` | `{stream_id}` | `{}` | `session.read` |
| `project.create` | `{path, git?, template?}` | `{project, session?}` | `project.create` |
| `env.info` | `{}` | `{os, cpu, mem, disk, dsh, tools[]}` | `env.read` |
| `env.watch` | `{interval_ms}` | **流**：采样 | `env.read` |
| `approval.respond` | `{ask_id, decision, note?}` | `{applied}` | `approval.respond` |
| `question.respond` | `{ask_id, answers, free_text?}` | `{applied}` | `approval.respond` |

错误沿用 JSON-RPC 2.0 错误对象，`data.code` 使用第 6.7 节同一套错误码。

### 7.5 事件（Agent → Controller，流内）

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `turn.start` | `{session_id, turn_id}` | 一轮开始 |
| `assistant.delta` | `{session_id, turn_id, text}` | 正文增量（可节流合并） |
| `assistant.reasoning` | `{session_id, turn_id, text}` | 思考增量，与正文分流 |
| `tool.call` | `{session_id, turn_id, call_id, name, args_preview}` | 工具调用开始（参数截断） |
| `tool.result` | `{session_id, turn_id, call_id, status, output_preview}` | 工具结束（输出截断） |
| `approval.request` | `{ask_id, session_id, tool, reason, expires_at}` | 需要用户决定 |
| `question.request` | `{ask_id, session_id, questions[]}` | agent 提问 |
| `turn.end` | `{session_id, turn_id, status, error?}` | 一轮结束 |
| `session.updated` | `{session_id, rev}` | 摘要变化提示 |

约束：单条事件 ≤ 64 KiB；预览字段截断到 2 KiB 并标注 `truncated:true`；高频增量按 100ms 合并；`turn.end` 必须在所有增量之后发出（保序）。

### 7.6 断线、恢复与关闭

| 场景 | 行为 |
| --- | --- |
| 网络切换 | 隧道断开；控制端重新申请；不自动重放「结果未知」的 mutation |
| 服务端节点迁移 | `GOAWAY` → 双方在 5s 内重连同一 `tunnel_id`（ticket 未过期） |
| 短暂断线 | 服务端为每个方向缓存 ≤ 256 KiB / 60s；重连带 `last_recv_seq` 续传；超出则 `RESET` |
| 空闲 | 90s 无帧关闭；可由任一方 `PING` 续命 |
| 主动关闭 | `CLOSE {code:"normal"}`；服务端释放配对状态 |
| 协议错误 | `CLOSE {code:"protocol_error"}`，记录审计（不含载荷） |

---

## 8. 服务端设计

### 8.1 组件

```
                    ┌────────────────────────────────────────────┐
   HTTPS/WSS ──────▶│ Edge / API Gateway（无状态，水平扩展）        │
                    │  TLS · 限流 · DPoP 校验 · 路由               │
                    └───────┬──────────┬──────────┬──────────────┘
                            │          │          │
                 ┌──────────▼──┐ ┌─────▼─────┐ ┌──▼─────────────┐
                 │ Device/Auth │ │ Presence  │ │ Mailbox        │
                 │ 关系型数据库 │ │ 内存缓存  │ │ 关系型数据库/缓存 │
                 └─────────────┘ └───────────┘ └──┬─────────────┘
                                                   │
                 ┌─────────────┐ ┌───────────┐ ┌──▼─────────────┐
                 │ Digest Blob │ │ Push      │ │ Tunnel Relay   │
                 │ object store│ │ APNs/FCM  │ │ WSS nodes      │
                 └─────────────┘ └───────────┘ └────────────────┘
```

### 8.2 数据模型（只存元数据/密文）

| 表 | 关键列 | 说明 |
| --- | --- | --- |
| `accounts` | `id, plan, created_at` | 可选；公开模式可为空 |
| `devices` | `id, role, ed_pub, x_pub, kid, name, account_id, status, last_seen` | 公钥可公开 |
| `bindings` | `id, agent_id, controller_id, scopes, agent_sig, controller_sig, status, created_at` | 双签；服务端只做粗 ACL |
| `pairings` | `id, agent_id, psk_commit, expires_at, state` | 5 分钟 TTL |
| `mailbox` | `device_id, seq, msg_id, kind, blob, exp, attempts, state` | blob 为密文；FIFO |
| `commands` | `id, agent_id, controller_id, binding_id, state, exp, result_blob` | 结果 TTL 24h |
| `digests` | `agent_id, epoch, rev, blob, updated_at` | blob 为密封摘要 |
| `tunnels` | `id, agent_id, controller_id, exp, state, bytes_in/out` | 仅活跃期 |
| `push_tokens` | `device_id, provider, token, exp` | 不含内容 |
| `audit` | `ts, actor, action, target, meta_json` | 只记录元数据 |

### 8.3 零知识如何被「工程保证」

1. **协议层**：服务端只接收 `envelope`/`blob` 字段，schema 里没有 `plaintext` 字段；解析器拒绝未知字段。
2. **代码层**：server 构建产物不依赖任何 AEAD/HPKE/Noise 解密实现；CI 用静态检查 + 依赖白名单锁住。
3. **存储层**：数据库列名 `*_blob`/`*_ct`；备份加密；日志脱敏（不打印 payload，只打印长度与 hash）。
4. **运维层**：生产环境禁止抓包落盘；审计只记「谁在何时对哪个设备做了什么」。
5. **可选**：机密计算/TEE 或自托管，进一步降低「服务端被攻破」的信任成本。

### 8.4 开放/公共服务的滥用防护

- 每设备：邮箱 1000 条 / 24h，指令 60 条/分钟，隧道 8 MiB/s。
- 每 IP/ASN：注册 10 个设备/天，配对 20 次/小时，失败配对指数退避。
- 信封大小上限：指令 64 KiB、结果 256 KiB、摘要 256 KiB、事件 64 KiB。
- 隧道：每设备 4 条并发，单条 5 分钟，空闲 90s 关闭。
- 公开服务器可要求「邀请码/工作量证明/邮箱验证」之一，按部署方策略。
- **Lite 部署**使用更小限额（每设备 120 req/min、每次心跳 ≤16 条且总 ≤128 KiB、结果 ≤64 KiB、摘要 ≤128 KiB），见 §8.13；限额是协议可协商项，不是硬编码。

### 8.5 部署与伸缩（Full Relay）

- 无状态 API + 关系型数据库（主从）+ 内存缓存（presence/长轮询唤醒/限流）。
- 隧道节点按 `tunnel_id` 哈希到固定节点；节点间用共享缓存发布订阅完成「双方到齐」通知。
- 多地域：控制端与 Agent 各自就近接入；隧道必须落在同一节点（用 DNS/Anycast + 一致性哈希）。
- 灾备：邮箱与摘要持久化；隧道状态可丢（重建即可）。
- Lite 的部署模型完全不同，见 §8.7–8.13。

### 8.6 服务端插件 SPI（第三方定制）

```ts
export interface RelayPlugin {
  name: string;
  authenticate(req: EnrollmentRequest): Promise<Principal>;
  authorize(p: Principal, action: Action, res: Resource): Promise<boolean>;
  onCommand?(cmd: QueuedCommand): Promise<void>;
  onTunnelOpen?(t: TunnelInfo): Promise<void>;
  store: MetadataStore;      // devices/bindings/commands/digests
  mailbox: MailboxStore;     // enqueue/dequeue/ack/resync
  presence: PresenceStore;   // heartbeat/last_seen/long-poll wakeup
  push: PushProvider;        // APNs/FCM/WebPush/UnifiedPush/null
  tunnel: TunnelTransport;   // WSS relay / WebRTC signaling / TURN
  limits: LimitPolicy;
  audit: AuditSink;
}
```

替换任意实现不影响线协议；一致性套件会验证「只实现 L0/L1 的服务端」也能被标准 Agent/Controller 使用。

### 8.7 部署形态：Full Relay / Lite Relay / Hybrid

| 形态 | 运行环境 | 等级 | 隧道 | 长轮询 | 推送 | 典型场景 |
| --- | --- | --- | --- | --- | --- | --- |
| **Full Relay** | VPS/容器，常驻数据面，关系型数据库/内存缓存 | L0–L2 | WSS | 支持 | APNs/FCM/WebPush | 生产、多用户、低延迟 |
| **Lite Relay** | 受限托管环境（如共享虚拟主机），关系型数据库 | L0–L1 | 无 | 不支持 | 可选 webhook | 个人、小团队、资源受限环境 |
| **Hybrid** | Lite 控制面 + 外部 WSS relay 数据面 | L0–L2 | 外部 | 不支持 | 可选 | 想保留流式但不想自建全套 |

核心原则：**L1 的语义只依赖四样东西**——HTTP/1.1 请求-响应、一个支持事务的关系型数据库、Ed25519 验签、HTTPS。它不要求 WebSocket、内存队列、消息队列、常驻进程或可靠定时任务。L2（隧道）才允许要求这些。

**Full Relay 的能力与特性**（对应 L2）：

| 能力 | 说明 |
| --- | --- |
| 实时流 | 隧道内 `session.attach` / `assistant.delta` / `tool.call` 等事件实时推送（§7） |
| 环境实时观测 | `env.watch` 周期采样推送（§7.4） |
| 长轮询 | `POST /v1/agent/hb?wait=25` 让指令延迟接近 RTT（§6.6） |
| 主动推送 | APNs/FCM/WebPush 唤醒控制端（只推事件 id，不推内容） |
| 多控制端实时协同 | 多个控制端可同时订阅同一会话的事件流 |
| 横向扩展 | 无状态 API + 隧道节点按 `tunnel_id` 哈希；多地域就近接入（§8.5） |
| 节点迁移 | 隧道 `GOAWAY` → 5s 内重连同一 `tunnel_id`（§7.6） |
| 断线续传 | 每方向缓存 ≤256 KiB/60s，`last_recv_seq` 续传（§7.6） |

Full Relay 面向「低延迟、流式、多用户」场景；Lite 面向「低依赖、个人/小团队」场景。二者使用同一套身份、信封与 L0/L1 语义，通过能力发现（`/.well-known/puppetry`）自动切换，部署方无需修改两端实现。

### 8.8 Lite Relay：目标环境与能力边界

**目标环境**（以受限托管环境为例，共享虚拟主机是典型场景，实现语言不限）：

| 约束 | 影响 | 设计对策 |
| --- | --- | --- |
| 无 WebSocket | 不能做隧道 | Lite 只实现 L0/L1；复杂操作走快照上传/拉取或外部 relay |
| 请求执行时间受限（如 30s）、无长连接 | 不能 long-poll | 心跳 15–30s；请求内只做「读队列 + 写 ack」 |
| 无内存队列/消息队列 | 不能内存排队 | 关系型数据库表 + 短事务 |
| 定时任务可能受限或不可用 | 不能依赖定时投递 | 投递完全由 Agent 心跳驱动；定时任务只做清理 |
| 单库、连接数少 | 并发有限 | 每设备每次 ≤16 条；事务 <50ms；索引覆盖 |
| 无系统推送 | 审批/结果不能主动唤醒 | 前台轮询；可选 webhook 调外部推送（只带事件 id） |
| Ed25519 验签库可能未启用 | 无法验签 | 启动自检；缺失则拒绝启用 L1，**不降级为 HMAC** |
| 只能 80/443、共享 IP | 端口/限速受限 | 标准 HTTPS；按设备限速，不做激进 IP 封禁 |
| 只能部署在子目录 | 路径不固定 | 所有端点相对 `base_url`，支持 `https://example.com/thread/` |

**能力发现**（`GET /.well-known/puppetry`，Lite 示例）：

```json
{
  "protocol": ["1.0"],
  "deployment": "lite",
  "levels": ["L0", "L1"],
  "features": ["mailbox", "digest", "pair-poll", "snapshot", "json"],
  "tunnel": false,
  "long_poll": false,
  "auth": ["sig-v1"],
  "encoding": ["json"],
  "heartbeat": { "min_ms": 15000, "max_ms": 120000, "default_ms": 30000 },
  "limits": { "max_body": 262144, "max_cmds": 16, "max_result": 65536, "max_digest": 131072 }
}
```

**Lite 下的功能覆盖**：

| 能力 | Lite 实现 | 说明 |
| --- | --- | --- |
| F1 在线状态 | ✅ 心跳 + `devices.last_seen` | 在线判定 `now - last_seen < 3 × hb` |
| F2 会话列表 | ✅ 密封摘要 + `digests` 表 | 服务端只见 blob |
| F3 prompt / cancel / rename / archive | ✅ 指令邮箱 | 结果轮询 |
| F4 新建会话 | ✅ 指令 `session.create` + 本地确认 | 不是隧道，但可用 |
| F4 新建项目 | ⚠️ 指令 `project.create`（可选，默认关闭） | 必须本地确认；路径受 `allowed_roots` 限制 |
| F5 实时回复流 | ⚠️ 快照上传 + 1.5–2s 拉取 | 2–3s 延迟；非真正推送 |
| F6 环境实时信息 | ⚠️ `env.info` 指令（15–30s 级） | 无 `env.watch` |
| F7 多控制端/撤销 | ✅ 绑定表 + 心跳下发 | 与 Full 相同 |
| 大图/附件 | ❌ | v2；Lite 不做分块 |

> 结论：Lite 能覆盖「看状态、看列表、发指令、审批、建会话」；**不能覆盖**「低延迟流式、`env.watch`、大文件」。需要后者时升级 Full 或加一个外部 relay（Hybrid）。

### 8.9 Lite 协议增量（必须实现）

#### 8.9.1 每请求签名 `Puppetry1-Sig`

Lite 不签发 JWT，认证头：

```
Authorization: Puppetry1 device="ct_...", ts="1761782400", nonce="b64url(16B)", sig="b64url"
```

> 部分共享主机/反向代理会过滤 `Authorization`；同时接受 `X-Puppetry-Auth`（值完全相同），服务端两者取其一。

签名原文（UTF-8，字段间用 `\n`，末尾不追加 `\n`）：

```
Puppetry1
<METHOD>
<PATH_AND_QUERY>  # 含 query；按 key 排序、统一百分号编码
<hex(sha256(body))>
<ts>              # Unix 秒
<nonce>
```

> query 参与签名，防止把已签名的分页请求改成另一个 `after_seq`；服务端必须先规范化再验签。

服务端校验顺序：

1. 按 `device` 查 `devices.ed_pub` 与 `status='active'`；
2. 用设备 Ed25519 公钥验签（等价于 `sodium_crypto_sign_verify_detached`）；
3. `|now - ts| ≤ 300s`；
4. `INSERT INTO nonces(device_id, nonce, ts)` 唯一冲突 → 重放，拒绝；
5. 限速（每设备 120 req/min，每 IP 600 req/min）。

注册 `POST /v1/devices/enroll` 用同一签名格式，`device` 留空，公钥放在 body，服务端用 body 里的公钥验签。验签通过后返回 `device_id`，**不返回令牌**。

#### 8.9.2 配对邮箱（替代配对隧道）

端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/pairings` | Agent 创建窗口：`{agent_id, ed, x, psk_commit?, exp}`（`psk_commit` 仅供审计，服务端不校验） |
| `POST` | `/v1/pairings/{id}/messages` | 双方投递 `{role, ct}`；服务端分配 `seq` |
| `GET` | `/v1/pairings/{id}/messages?after_seq=&role=` | 拉取「发给 role」的消息 |
| `POST` | `/v1/pairings/{id}/close` | 任一方关闭 |

限制：窗口 5 分钟、最多 8 条消息、每条 ≤64 KiB、只允许 `agent`/`controller` 两个 role。

流程：

```
Agent（PC）                     Lite Server                    Controller（手机）
   │ POST /pairings               │                                │
   │  {agent_id, ed, x, psk_commit}│                               │
   │── QR: pid + psk + agent ed/x ────────────────────────────────▶│ 扫码
   │                              │◀── POST /pairings/{pid}/messages │
   │                              │    {role:"controller", ct}       │
   │ GET .../messages?role=agent  │                                  │
   │◀── ct ───────────────────────│                                  │
   │ 解密 → 验 HMAC(psk) + 签名 → 本地确认（Allow?）                 │
   │ 生成 BindingRecord，双签，POST /bindings                        │
   │ POST .../messages {role:"agent", ct: PairResult}                │
   │                              │── GET ...?role=controller ──────▶│
   │                              │── ct ──────────────────────────▶│
   │                              │                        验签、存绑定
```

`PairRequest`（Controller → Agent，HPKE base 模式加密到 `agent_x`；身份由签名承担）：

```jsonc
{
  "v": 1, "pid": "pr_...",
  "controller_id": "ct_...", "ed": "b64url", "x": "b64url",
  "name": "iPhone",
  "scopes": ["presence", "session.list", "session.prompt", "session.read"],
  "ts": 1761782400, "nonce": "b64url",
  "proof": "b64url(HMAC-SHA256(psk, 'puppetry1-pair' || pid || ed || x || ts || nonce))",
  "sig": "b64url(Ed25519(ct_ed, canonical(payload)))"
}
```

- `proof` 证明控制端扫过二维码（知道 psk）；`sig` 证明身份；HPKE 让服务端看不到名称与 scope。
- Agent 必须校验 `controller_id == "ct_" + base32lower(SHA-256(ct_ed)[0..15])`，防止把签名钥与 id 错配。
- 控制端必须校验 `agent_id == "ag_" + base32lower(SHA-256(agent_ed)[0..15])`，且 `agent_ed/agent_x` 与二维码一致。
- Agent 本地确认后返回 `PairResult`：`{binding_id, agent_ed, agent_x, scopes, agent_sig}`，用 HPKE base 到 `controller_x` 并签名。
- 控制端校验 `agent_ed/agent_x` 与二维码里的值一致，防止服务端换钥。
- 可选 SAS：`SHA-256("puppetry1-sas" || pid || psk || ct_x || ag_x)` 取前 3 字节转 6 位数字，两端比对。
- **安全等价性**：psk 高熵且只在二维码里；服务端没有 psk 无法伪造 `proof`，也无法在不知道 `agent_x` 私钥的情况下解密 PairRequest。服务端仍可拒绝服务/延迟，与 Full 的威胁模型一致。
- Lite 不做短码 SPAKE2（需要多轮交互，轮询体验差）；短码配对留给 Full 或 v2。

#### 8.9.3 流式降级：快照上传 + 增量拉取

Lite 没有 WebSocket，但可以让 Agent「小步上传」快照、控制端「增量拉取」，做到 2–3s 的近实时，而不是等 15–30s 的心跳：

1. Agent 在 turn 运行期间，把事件按 ≥1s 节流合并成增量快照：
   `{turn_id, seq, status, events:[...]}`；用 `mk`（或由 `mk` 派生的 `stream_key`）AEAD 加密，`blob = nonce(12) || ct`，AAD 绑定 `agent_id/session_id/seq`。
2. `PUT /v1/agents/{id}/sessions/{sid}/snapshots`，body `{seq, ct}`；服务端只存密文，按 `(agent_id, session_id, seq)` 唯一，保留最近 64 条（约 1 分钟）/ 2 分钟 TTL；更早的段由 `session.snapshot` 补偿。若主机不允许 `PUT`，用 `POST` + `X-HTTP-Method-Override: PUT`。
3. 控制端 `GET /v1/agents/{id}/sessions/{sid}/snapshots?after_seq=N` → `{items:[{seq,ct}], next_seq, gap:false}`；解密并按 `seq` 合并。没有新数据时返回 `304`。
4. 控制端前台每 1.5–2s 拉一次，`turn.end` 后停止；同一时间只跟一个会话。
5. 若 `gap:true`（Agent 重启、服务端 GC 掉了中间段），控制端发一次 `session.snapshot` 指令取全量环形缓冲，或退回 `session.history`。

```jsonc
// PUT body
{ "seq": 128, "ct": "b64url" }

// GET response
{
  "items": [ { "seq": 127, "ct": "..." }, { "seq": 128, "ct": "..." } ],
  "next_seq": 128,
  "gap": false
}
```

成本：一个活跃 turn 约 1 次上传/秒 + 1 次拉取/2 秒；个人站点可接受，多用户共享主机需要限额（见 §8.13）。**为什么不复用指令**：指令要等心跳（15–30s），做不到 2s 级；快照上传/拉取是独立短请求，不等心跳。

Agent 仍保留环形缓冲（512 条 / 256 KiB / 10 分钟），用于 `session.snapshot` 的 gap 恢复与断线补看；事件 schema 与隧道事件完全一致，UI 渲染逻辑可复用。

#### 8.9.4 指令化的复杂操作

Lite 把一部分原本走隧道的操作改成「指令 + 本地确认 + 结果」：

| 指令 | 载荷 | 本地确认 | 说明 |
| --- | --- | --- | --- |
| `session.create` | `{cwd?, title?, preset?, permission?, model?}` | 可选（默认允许，受 `allowed_roots` 限制） | 创建成功返回 `session_id` |
| `project.create` | `{path, git?, template?}` | **必须** | 默认关闭；路径必须在 `allowed_roots` 下 |
| `env.info` | `{}` | 否 | 一次性快照；受心跳间隔限制（15–30s） |
| `session.snapshot` | `{session_id, after_seq?}` | 否 | gap 恢复/全量环形缓冲；不是主路径 |

`project.create` 的确认在 PC 端弹出（DSH 通知/插件 UI），远端等待 ≤120s；超时/无人在场 → `policy_denied`。这样既保留「复杂操作需要人在场」的安全语义，又不要求 WebSocket。

#### 8.9.5 隧道不可用时的返回

```http
POST /v1/tunnels
→ 501
{
  "error": {
    "code": "tunnel_unavailable",
    "message": "this relay is lite; use snapshot polling or an external relay",
    "alternate_relay": "wss://relay2.example.com"   // 可选
  }
}
```

控制端策略：`tunnel` → `snapshot` → `final-only` 三级降级；若 `alternate_relay` 存在且用户允许，切换到 Hybrid 数据面（绑定与 Noise 身份不变）。

### 8.10 Lite 的最小数据模型与队列算法

关系型数据库示例（以 MySQL 为例；SQLite 把 `AUTO_INCREMENT` 改成 `INTEGER PRIMARY KEY AUTOINCREMENT`，`ENGINE` 去掉）：

```sql
CREATE TABLE devices (
  id            VARCHAR(64) PRIMARY KEY,
  role          ENUM('agent','controller') NOT NULL,
  ed_pub        VARBINARY(32) NOT NULL,
  x_pub         VARBINARY(32) NOT NULL,
  name          VARCHAR(128),
  status        ENUM('active','revoked') DEFAULT 'active',
  created_at    DATETIME NOT NULL,
  last_seen     DATETIME,
  KEY idx_last_seen (last_seen)
) ENGINE=InnoDB;

CREATE TABLE bindings (
  id            VARCHAR(64) PRIMARY KEY,
  agent_id      VARCHAR(64) NOT NULL,
  controller_id VARCHAR(64) NOT NULL,
  scopes        TEXT,
  agent_sig     VARBINARY(64) NOT NULL,
  controller_sig VARBINARY(64) NOT NULL,
  status        ENUM('active','revoked') DEFAULT 'active',
  created_at    DATETIME NOT NULL,
  KEY idx_agent (agent_id, status)
) ENGINE=InnoDB;

CREATE TABLE mailbox (
  seq        BIGINT AUTO_INCREMENT PRIMARY KEY,
  device_id  VARCHAR(64) NOT NULL,
  msg_id     VARCHAR(64) NOT NULL,
  kind       VARCHAR(16) NOT NULL,
  blob       MEDIUMBLOB NOT NULL,
  exp        DATETIME NOT NULL,
  state      ENUM('queued','done','expired') DEFAULT 'queued',
  deliver_count INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uniq_msg (device_id, msg_id),
  KEY idx_pick (device_id, state, seq)
) ENGINE=InnoDB;

CREATE TABLE commands (
  id            VARCHAR(64) PRIMARY KEY,
  agent_id      VARCHAR(64) NOT NULL,
  controller_id VARCHAR(64) NOT NULL,
  binding_id    VARCHAR(64) NOT NULL,
  state         ENUM('queued','done','error','expired') DEFAULT 'queued',
  exp           DATETIME NOT NULL,
  result_blob   MEDIUMBLOB,
  updated_at    DATETIME,
  KEY idx_ctrl (controller_id, updated_at)
) ENGINE=InnoDB;

CREATE TABLE digests (
  agent_id   VARCHAR(64) PRIMARY KEY,
  epoch      INT NOT NULL,
  rev        BIGINT NOT NULL,
  blob       MEDIUMBLOB NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB;

CREATE TABLE snapshots (
  agent_id   VARCHAR(64) NOT NULL,
  session_id VARCHAR(64) NOT NULL,
  seq        BIGINT NOT NULL,
  blob       MEDIUMBLOB NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (agent_id, session_id, seq),
  KEY idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE nonces (
  device_id VARCHAR(64) NOT NULL,
  nonce     VARCHAR(64) NOT NULL,
  ts        BIGINT NOT NULL,
  PRIMARY KEY (device_id, nonce),
  KEY idx_ts (ts)
) ENGINE=InnoDB;
```

**投递算法（ack 驱动，至少一次）**：

> 所有 Controller 端点先查 `bindings(agent_id, controller_id, status='active')`；服务端只做粗粒度 ACL（是否绑定、是否撤销），细粒度 scope 仍由 Agent 在解密后校验。`PUT snapshots` 只允许 `device_id == agent_id` 的 Agent 调用。

1. 控制端提交：`INSERT INTO mailbox (...) VALUES (...)`；`UNIQUE(device_id,msg_id)` 保证幂等；同一事务里 `INSERT INTO commands` 建状态行。
2. Agent 心跳：一个短事务内
   - `UPDATE devices SET last_seen=NOW() WHERE id=?`；
   - 处理请求体里的 `acks`：`UPDATE mailbox SET state='done' WHERE device_id=? AND msg_id IN (...)`；同时更新 `commands.state`；
   - `SELECT seq,msg_id,blob,exp FROM mailbox WHERE device_id=? AND state='queued' AND exp>NOW() ORDER BY seq LIMIT 16`；
   - `UPDATE mailbox SET deliver_count=deliver_count+1 WHERE seq IN (...)`；
   - `COMMIT`；返回命令。
3. **不标记 delivered**：响应丢失时下一轮还会返回同一条，Agent 用 `msg_id` 去重并返回缓存结果。这是共享主机上最稳的「至少一次」实现，不需要重投定时器。
4. 结果回传：Agent `POST /v1/commands/{id}/result` → `UPDATE commands SET state=?, result_blob=?, updated_at=NOW()`；控制端按 `GET /v1/commands/{id}` 读取。
5. 过期：机会式 GC 把 `exp<NOW()` 的行置 `expired`；`commands` 同步过期；`snapshots` 删除 2 分钟前的行，并保证每会话最多 64 条。
6. 毒消息：`deliver_count > 10` 且仍未 ack，置 `expired` 并记审计（防止 Agent 永久卡住）。

SQLite 注意：开启 WAL、`busy_timeout=5000`，写事务用 `BEGIN IMMEDIATE`；单机低并发足够。

### 8.11 Lite 参考实现示例（以 PHP 为例）

> PHP 仅作为 Lite 服务端的一种示例实现语言：Lite 服务端可以用任何支持「HTTP + 关系型数据库 + Ed25519 验签」的语言实现，本节不将 PHP 认定为默认或唯一选项。

目录：

```
thread/
  public/index.php       # 前端控制器 / 路由
  src/Auth.php           # Puppetry1-Sig 验签、nonce
  src/Store.php          # PDO 连接、事务
  src/Mailbox.php        # 入队/取队/ack
  src/Pairing.php        # 配对邮箱
  src/Digest.php         # 密封摘要存取
  src/Gc.php             # 机会式清理
  src/Response.php       # JSON 输出、gzip
  schema.sql
  config.php
  .htaccess              # rewrite 到 index.php
  bin/gc.php             # 可选 cron
```

验签（PHP 7.4+ / 8.1+，需 sodium）：

```php
function thread_verify(string $deviceId, string $method, string $path,
                    string $body, array $h): bool {
    $st = db()->prepare('SELECT ed_pub FROM devices WHERE id=? AND status="active"');
    $st->execute([$deviceId]);
    $pub = $st->fetchColumn();
    if ($pub === false) return false;

    $msg = "Puppetry1\n{$method}\n{$path}\n" . hash('sha256', $body) . "\n"
         . $h['ts'] . "\n" . $h['nonce'];   // $path 含规范化 query
    return sodium_crypto_sign_verify_detached(b64u_dec($h['sig']), $msg, $pub)
        && abs(time() - (int)$h['ts']) <= 300;
}
```

取队（一个事务，短平快）：

```php
$pdo->beginTransaction();
$pdo->prepare('UPDATE devices SET last_seen=NOW() WHERE id=?')->execute([$agentId]);
foreach ($acks as $msgId) {
    $pdo->prepare('UPDATE mailbox SET state="done" WHERE device_id=? AND msg_id=?')
        ->execute([$agentId, $msgId]);
}
$q = $pdo->prepare('SELECT seq,msg_id,blob FROM mailbox
                    WHERE device_id=? AND state="queued" AND exp>NOW()
                    ORDER BY seq LIMIT 16');
$q->execute([$agentId]);
$rows = $q->fetchAll(PDO::FETCH_ASSOC);
$pdo->commit();
```

其他要点：

- **编码**：Lite 默认 JSON（`application/json`），二进制字段 base64url；比 CBOR 大 ~33%，但共享主机不需要 CBOR 扩展。`features` 里声明 `"json"`，Agent/Controller 按 `encoding` 选择。
- **路由**：`base_url` 可配置（`https://example.com/thread/`）；`.htaccess` 不可用时用 `index.php?r=/v1/...` 兜底。
- **响应**：`Content-Type: application/json`；`ob_gzhandler` 可用则开；空响应保持 <2 KiB。
- **错误**：统一 `{error:{code,message}}`；5xx 不泄露堆栈。
- **GC**：每个请求 1% 概率触发 `gc_expired()`（LIMIT 500，走索引）；可选 `bin/gc.php` 每 5 分钟。
- **可观测**：`/v1/health` 返回 `{ok, deployment:"lite", version, time}`；日志只记 method/path/status/耗时/设备 id，不记 body。
- **安全**：`display_errors=Off`；配置放 Web 根之外；数据库账号只授予该库；禁用 `exec` 不影响。
- **共享主机兼容**：`Authorization` 被过滤时用 `X-Puppetry-Auth`；只允许 GET/POST 时用 `X-HTTP-Method-Override`；不能改 rewrite 时用 `index.php?r=/v1/...`；IIS 用 `web.config`；`open_basedir` 限制时把 `config.php` 放 Web 根内并加 `<?php exit; ?>` 防直接访问。
- **同源优先**：Web 控制端尽量与 API 部署在同一虚拟主机/子目录，避免 CORS；必须跨源时只允许白名单 `Origin`，预检放行 `Authorization`，不要用 `*`。

### 8.12 Lite 的限制、失败模式与安全

| 问题 | 表现 | 处理 |
| --- | --- | --- |
| 共享主机 30s 超时 | 请求被 504 | 事务 <50ms；不在请求内做外呼；`LIMIT 16` |
| DB 死锁/锁等待 | 偶发 500 | 重试 1 次；SQLite 用 `BEGIN IMMEDIATE` + busy_timeout |
| cron 不可用 | 过期数据/snapshot 堆积 | 机会式 GC；每设备队列上限 1000；snapshots 每会话 64 条、2 分钟 TTL |
| 主机杀进程 | 写入中断 | 所有写操作幂等；Agent 重试；唯一键兜底 |
| 共享 IP 被限速 | 429/403 | 按设备限速；建议挂 CDN；不激进封 IP |
| Ed25519 验签库缺失 | 无法验签 | 启动自检失败 → 明确报错，不降级 |
| 托管方恶意/被攻破 | 可读 DB、改 PHP | 只能看到密文与元数据；建议原生 App 或对 Web 资源做完整性校验 |
| 备份泄露 | DB 备份被下载 | 只有密文与元数据；仍应加密备份、限制访问 |
| 无推送 | 审批不能唤醒 | 前台轮询；可选 webhook（只发事件 id，不发内容） |

**共享主机额外信任问题（必须明说）**：托管方拥有 root，能改 PHP、看数据库、给 Web 控制端投放恶意 JS。E2EE 保证它读不到会话内容，但它可以**冒充服务端**（拒绝服务、丢弃/延迟配对消息）或**偷 Web 端密钥**。因此：

- 高安全场景优先用原生 App（密钥在 Secure Enclave/Keystore），而不是共享主机上的 Web 控制端；
- Web 控制端至少启用 SRI/固定资源哈希，或把静态资源放在可信 CDN；
- 配对时展示 SAS，用户可比对；
- 关键操作（`project.create`、危险权限）强制 PC 本地确认。

### 8.13 Lite 参考实现部署清单（PHP 示例）

| 项 | 要求 |
| --- | --- |
| PHP | ≥ 7.4（推荐 8.1+），启用 `sodium`、`pdo_mysql`（或 `pdo_sqlite`）、`json` |
| Web | HTTPS（必须）、HSTS；支持 rewrite，或使用 `index.php?r=` |
| 数据库 | MySQL 5.7+/MariaDB 10.4+ 或 SQLite 3.35+；InnoDB/WAL；`snapshots` 走 `(agent_id,session_id,seq)` 主键，2 分钟 TTL |
| 目录 | 配置在 Web 根之外；`data/` 仅 SQLite 时需要可写 |
| 路径 | `base_url` 支持子目录，如 `https://example.com/thread/` |
| 定时 | 可选 cron `*/5 * * * * php bin/gc.php`；不配置也能跑 |
| 限制 | 每设备 120 req/min、每 IP 600 req/min；请求 ≤256 KiB；响应 ≤128 KiB；每次心跳 ≤16 条且总 ≤128 KiB；快照 ≤64 KiB/条、≤1 条/秒 |
| 监控 | 5xx 率、队列深度、最老未 ack 消息年龄 |
| 验证 | 跑一致性套件 L1；确认 `tunnel_unavailable` 时客户端能降级 |

---

## 9. 受控端（Agent）插件设计

> 本章为**实现参考**（说明性）：描述受控端参考实现（DSH 插件）的组织方式与内部接口，非协议规范；受控端需要遵守的协议要求见 §4–§8。

### 9.1 在 DSH 中的形态

- 一个 DSH **host bundle**：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入插件；可选 `dsh.client` 提供设置页/配对二维码。
- 兼容门：`engines.dsh` 与 peerDependencies 使用双段范围（参考社区插件的做法），否则会被静默禁用。
- 安装：`dsh plugin --profile <profile> add <pkg>`；改代码后需完全重启（HMR 只热更配置，不重新 import）。

### 9.2 模块划分

```
src/
  index.ts            # 插件入口：读配置、装配、注册命令/设置页
  identity.ts         # 密钥生成/加载、keychain、agent_id
  enroll.ts           # 设备注册、DPoP / Puppetry1-Sig、token 刷新
  pairing.ts          # QR/短码、Noise XXpsk3 / 配对邮箱、BindingRecord
  heartbeat.ts        # 定时器、长轮询、退避、server_time 偏移
  mailbox.ts          # 解密指令、去重、计数器、结果回传
  tunnel.ts           # Noise IK、mux、RPC 分发、流控（L2）
  snapshot.ts         # 环形事件缓冲、快照上传（Lite）、session.snapshot 响应
  capability.ts       # 读取 server/info，决定长轮询/隧道/轮询策略
  adapter/            # Host Adapter（DSH API 映射）
  policy.ts           # scope、allowed_roots、远程审批开关、限速
  audit.ts            # 本地审计（谁在何时做了什么）
  ui/                 # 设置页、配对二维码、状态 pill
```

### 9.3 Host Adapter 接口

```ts
export interface PuppetAgentHost {
  readonly info: AgentInfo;

  listSessions(opts?: { includeArchived?: boolean }): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  getHistory(id: string, opts: { beforeSeq?: number; limit?: number }): Promise<HistoryPage>;

  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  prompt(input: PromptInput): Promise<PromptReceipt>;
  cancel(sessionId: string): Promise<boolean>;
  rename(sessionId: string, title: string): Promise<void>;
  archive(sessionId: string, opts?: { stop?: boolean }): Promise<void>;

  subscribe(sessionId: string, afterSeq: number, cb: (e: SessionEvent) => void): Unsubscribe;
  capabilities(): Promise<HostCapabilities>;
  environment(): Promise<EnvironmentInfo>;

  createProject?(input: ProjectInput): Promise<ProjectInfo>;
  respondApproval?(askId: string, decision: ApprovalDecision): Promise<boolean>;
  respondQuestion?(askId: string, answers: AnswerMap): Promise<boolean>;
}
```

**DSH API 映射参考**（来自社区 2026-10 实测，可能随版本变化；实现时应做能力探测与降级）：

| Adapter 方法 | DSH 侧 | 备注 |
| --- | --- | --- |
| `listSessions` | `sessionController.list({}, signal)` + `projections` 拼标题 | list 不含 title，需投影 |
| `getHistory` | `sessionController` 历史/投影 + `session/event` | 含 `steps`、`reasoning` |
| `createSession` | `sessionController.create({cwd, agentPreset})` | 创建后再 rename/selectModel |
| `prompt` | `sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})` | 繁忙时按宿主 `busyEnter` 策略 |
| `cancel` | `sessionController.cancel(sessionId)` | — |
| `archive` | `workspaceRegistry.archiveSession(id, {stopActivity})` | 运行中归档可能被拒绝 |
| `subscribe` | `ctx.on('session/event', (session, event) => …)` | `tool/call`、`tool/result`、`assistant/message` 等 |
| `respondApproval` | `approval/request` 瀑布答案器 | 返回 `allowed-once/rejected/cancelled/unavailable` |
| `respondQuestion` | `user-questions/request` 瀑布 | answers 结构随宿主 |
| `capabilities` | `agentPresets` / `permissionPresets` / `modelCatalog` | 空目录则隐藏对应 UI |
| `environment` | `os`/`process` + DSH 版本 + PATH 探测 | 采样需限频 |

> 关键点：**远端指令最终仍以「用户 prompt」进入 DSH 会话**，沿用该会话的 permission preset 与工具审批；远控插件不绕过 DSH 的权限系统。

### 9.4 本地策略与审批

```yaml
policy:
  allowed_controllers: [bd_...]        # 缺省=全部已绑定
  scopes: [presence, session.list, session.prompt, session.read]
  allowed_roots: ["D:/work", "D:/projects"]
  remote_approval: false               # 默认关闭：审批只在 PC 上做
  require_local_confirm: ["project.create", "danger-full-access"]
  max_commands_per_min: 20
  quiet_hours: "23:00-08:00"           # 静默期只读
```

审批语义（必须 fail-open 到本地，不能 fail-closed 卡死任务）：

- 手机在线且 `remote_approval=true` 且 binding 有 `approval.respond` → 转发给手机，等待 ≤120s。
- 超时/断线/手机拒绝通道异常 → `next()` 交还桌面答案器。
- 高危操作（`danger-full-access`、写系统目录、执行任意命令）→ 强制本地确认，手机只能看到提示。
- 所有远端审批动作写本地审计（ask_id、决定、来源、耗时）。

### 9.5 生命周期

| 事件 | 行为 |
| --- | --- |
| DSH 启动 | 加载密钥 → 注册/刷新 token（Lite 无 token）→ 首次心跳 → 恢复未完成指令（按 ctr 去重） |
| 进程重启 | `boot_id` 变化；服务端可识别「同一设备的新实例」，清理旧长轮询 |
| 休眠/唤醒 | 心跳失败 → 指数退避（1s→60s，full jitter）；唤醒后立即心跳 |
| 网络切换 | 心跳/隧道各自重连；隧道不迁移，重建即可 |
| 多实例 | 文件锁（state dir）拒绝第二个 Agent，避免双心跳/双执行 |
| 服务端为 Lite | 心跳按 `server/info.heartbeat` 定时；不尝试长轮询/隧道；配对走配对邮箱；流式走快照上传/拉取 |
| 撤销 | 收到 `bindings.revoked` → 删除本地绑定 → 拒绝该控制端所有指令 |
| 卸载 | 删除本地密钥与状态（可选保留审计） |

### 9.6 密钥存储

- 优先 OS keychain；不可用时退化为 `0600` 文件 + 明确警告（Windows 上 chmod 只切只读位，需显式提示）。
- 私钥不写日志、不进崩溃转储、不出现在 argv。
- 配对二维码含 psk，渲染后不落盘；提供「重新生成/隐藏」。

---

## 10. 控制端（Controller）插件设计

> 本章为**实现参考**（说明性）：给出控制端 SDK 分层与页面状态机的组织建议，供实现方参考，非协议规范；控制端需要遵守的协议要求见 §4–§8。

### 10.1 分层

```
@thread/client-core     # 无 UI：密钥、配对、HTTP、HPKE、Noise、状态机
@thread/client-web      # Web UI（React/Svelte 均可）
@thread/client-mobile   # React Native / Flutter / 原生壳
@thread/client-cli      # 终端
```

`client-core` 只依赖标准 WebCrypto/Node crypto；UI 层不接触密钥材料，只拿「已解密的事件/会话」。

### 10.2 页面与状态机

```
Unpaired → Pairing → Idle → AgentSelected → SessionList → SessionView
                                   │                         │
                                   ├── Tunnel(open) ◀────────┤  L2
                                   └── Snapshot(poll) ◀──────┘  Lite
```

| 页面 | 数据来源 | 操作 |
| --- | --- | --- |
| 设备列表 | `GET /v1/agents` + presence | 选择、重命名、撤销 |
| 会话列表 | 密封摘要解密 | 打开、刷新、新建（隧道或 Lite 指令） |
| 会话详情 | 隧道 `session.attach`，或 Lite 快照拉取 | 发 prompt、取消、审批、切模型（可选） |
| 设置 | 本地 | 服务器地址、密钥、推送、隐私 |

### 10.3 推送与后台

- 注册 token：`POST /v1/push/register {provider, token}`。
- 服务端只推「有结果 / 有审批 / 任务结束」的事件 id，不推内容。
- App 收到后短连拉取 inbox → 解密 → 本地通知（通知文案通用，避免锁屏泄露）。
- 后台不保持隧道；回到前台再按需开。
- **Lite 没有服务端推送**：前台轮询 `inbox` 或在快照拉取里捎带状态；需要唤醒时，可由 Agent 直接调用外部推送服务（ntfy/Bark/Telegram），只发「有审批/有结果」与一个事件 id，不发内容。

### 10.4 Web 端限制

- 浏览器密钥存 IndexedDB + WebCrypto（尽量非导出）；清缓存 = 丢密钥 = 需重新配对。
- 不建议在共享浏览器上配对；提供「本次会话临时密钥」选项（关闭标签即失效）。
- 移动端优先用 Secure Enclave/Keystore；Web 作为便利层，安全等级在 UI 中明示。

---

## 11. 开放插件框架

### 11.1 包布局

```
@thread/protocol       # 线格式、加密、帧、错误码、测试向量（纯函数、零 I/O）
@thread/agent-sdk      # Agent 角色骨架：心跳/邮箱/隧道/策略，留 Host Adapter
@thread/agent          # DSH 官方 Agent 插件（bundle）
@thread/relay          # 服务端参考实现（L0–L2，实现语言不限）
@thread/relay-lite     # Lite 服务端参考实现（L0–L1）
@thread/client-core    # 控制端 SDK
@thread/client-web     # Web 控制台
@thread/conformance    # 一致性套件 + 假 Agent/Server/Controller
```

### 11.2 插件清单（manifest）

```json
{
  "name": "@acme/puppetry-agent",
  "role": "agent",
  "protocol": { "min": "1.0", "max": "1.x" },
  "suites": ["X25519-HKDF-SHA256-CHACHA20POLY1305"],
  "capabilities": ["session.read", "session.prompt", "session.create",
                   "env.read", "tunnel", "approval"],
  "transport": { "mailbox": true, "tunnel": "wss", "pair": ["ws", "poll"], "snapshot": true, "webrtc": false },
  "limits": { "max_cmd": 65536, "max_result": 262144, "max_streams": 64 }
}
```

### 11.3 一致性等级

| 等级 | 必须实现 | 可以省略 | 可用部署 |
| --- | --- | --- | --- |
| **L0 Presence** | 注册、心跳、presence、摘要 rev/hash | 指令、隧道 | Lite / Full |
| **L1 Mailbox** | L0 + 指令邮箱、结果、幂等、E2EE 信封 | 隧道 | Lite / Full |
| **L2 Tunnel** | L1 + WSS 隧道、Noise、mux、RPC、事件流 | WebRTC、推送 | Full / Hybrid |
| **L3 Extended**（v2） | 推送、多控制端轮换、WebRTC P2P、附件 | — | Full / Hybrid |

服务端在 `/.well-known/puppetry` 声明等级；控制端按等级降级 UI（例如 L1 时隐藏「新建项目」，改用指令或禁用）。

> **Lite 的目标就是 L1**：它不追求 L2，而是把 L1 做到「任何具备 HTTP + 关系型数据库的环境都能部署」。L2 仍由 Full Relay 或 Hybrid 的外部数据面承担。

### 11.4 版本与兼容

- URL 带主版本：`/v1/`；新增可选字段/新方法不升主版本，靠 `caps` 协商。
- 破坏性变更：升 `/v2/`，三端并行支持至少一个版本周期。
- 禁止静默降级：套件、协议版本不在白名单 → 明确报错。
- 协议包冻结帧名/字段名；改既有形状 = 破坏性变更。

### 11.5 测试与一致性

- **测试向量**：HPKE（RFC 9180 官方向量）、Noise IK golden vector、信封 AAD、摘要密封、绑定签名。
- **一致性套件**：假 Server + 真 Agent + 真 Controller，覆盖：注册、配对、心跳、指令、重放、过期、撤销、隧道、流控、断线。
- **L1-Lite 套件**：用 Lite 参考实现 + 关系型数据库，覆盖 `Puppetry1-Sig`、配对邮箱、ack 驱动队列、快照上传/拉取、机会式 GC；断言「无 WebSocket/内存队列也能通过 L1」。
- **模糊测试**：信封解析、CBOR、帧长度、隧道 mux。
- **安全测试**：服务端无解密路径的静态检查；日志不含 payload 的断言。

---

## 12. 安全分析

| 威胁 | 缓解 | 残余风险 |
| --- | --- | --- |
| 恶意服务端读取内容 | HPKE/Noise E2EE；服务端无密钥 | 流量分析（时间/大小） |
| 恶意服务端伪造指令 | HPKE Auth + 本地绑定公钥校验 | 可丢弃/延迟（可用性问题） |
| 服务端重放旧指令 | `ctr` + `exp` + `mid` 去重 + 绑定上下文 | 极端时钟/状态丢失场景需重新配对 |
| 配对中间人 | 二维码 psk + Noise XXpsk3；短码用 SPAKE2 | 用户把二维码给攻击者 |
| 控制端丢失 | 撤销 binding、轮换 mk、服务端停路由 | 已解密的历史在设备上 |
| PC 被入侵 | OS keychain、磁盘加密、最小 scope | 解密后的内容可被读取 |
| 已授权但恶意的控制端 | scope、allowed_roots、本地确认、审计 | 用户主动授权后难以完全防御 |
| 降级攻击 | 固定套件/版本白名单 | 无 |
| DoS | 配额、限流、大小上限、隧道并发限制 | 大流量仍可能挤占 |
| 供应链 | 签名发布、可复现构建、依赖白名单 | 生态依赖 |
| 元数据泄露 | 标题密封、最小字段、可选填充 | 服务端仍见连接时序 |
| 共享虚拟主机托管方 | 只能读到密文与元数据；但能改 PHP、投放恶意 JS | 优先原生 App + SRI/资源哈希；关键操作 PC 本地确认 |
| Lite 单点/无冗余 | 主机宕机、共享 IP 限流 | 邮箱持久化、Agent 重试、可迁移 DB；仍非高可用 |

**明确不承诺**：不承诺匿名；不承诺服务端不可用时的实时性；不承诺防住已被完全控制的 PC 或手机。

---

## 13. 落地路线

| 阶段 | 目标 | 交付 |
| --- | --- | --- |
| M0（2–3 周） | 打通「看状态 + 发 prompt」 | `protocol` + Agent 心跳/邮箱 + Relay L1 + Web 控制端 |
| M1（2 周） | 配对与 E2EE 完整 | QR/短码、HPKE 信封、密封摘要、撤销 |
| M1.5（1–2 周） | **轻量部署可用** | PHP `relay-lite`（L1）+ 配对邮箱 + 快照上传/拉取 + 部署清单 |
| M2（3 周） | 复杂操作 | WSS 隧道、Noise、mux、`session.attach`、`env.watch`、`project.create` |
| M3（2 周） | 多端与生产化 | 多控制端、轮换、推送、审计、一致性套件、移动端 |
| M4（可选） | 体验与规模 | WebRTC P2P、附件分块、联邦/多地域 |

**受控端参考实现**：本工作区的 `dsh-puppet/` 已按本文的 L1（心跳 + 指令邮箱）实现了一版可安装的 DSH 插件：Ed25519/X25519 身份、`Puppetry1-Sig` 每请求签名、HPKE Auth 指令/结果、扫码/拷贝 token 邀约绑定（§4.3.2）、`session.snapshot` 降级、保持唤醒（Windows/macOS/Linux）以及本机设置页（`/remote-settings`）。它把密封摘要的退化模式简化为 `mode:"summary"`（不含标题），并把手工导入 BindingRecord 保留为离线/救援路径。

**建议先做的三个验证**：

1. 用假 Server 跑通「心跳 → 指令 → 结果」闭环，确认 30s/长轮询两种延迟可接受。
2. 用 RFC 9180 向量验证 HPKE Auth 在 WebCrypto、移动端等不同平台的互操作。
3. 用真实 DSH Host 验证 `session.prompt` 的「受理即返回 + 事件流」语义，避免把长任务阻塞在指令结果里。
4. 用一台资源受限的主机跑通 Lite：签名心跳、配对邮箱、指令往返、快照上传/拉取，确认受限执行时间与定时任务约束下都稳定。

---

## 14. 参考资料

**现有实现**

- liguobao/ds-harness-remote — <https://github.com/liguobao/ds-harness-remote>
  - E2EE: <https://github.com/liguobao/ds-harness-remote/blob/main/docs/end-to-end-encryption.md>
  - 网络与传输: <https://github.com/liguobao/ds-harness-remote/blob/main/docs/network.md>
  - 协议: <https://github.com/liguobao/ds-harness-remote/blob/main/docs/protocol.md>
- dsh-remote/plugin — <https://github.com/dsh-remote/plugin>
  - 协议包: <https://github.com/dsh-remote/protocol>
- MoonlitDropOfBlood/dsh-remote-control — <https://github.com/MoonlitDropOfBlood/dsh-remote-control>
  - 协议契约: <https://github.com/MoonlitDropOfBlood/dsh-remote-control/blob/main/docs/PROTOCOL.md>
- yeerock/dsh-rc — <https://github.com/yeerock/deepseek-harness-remote-control>

**标准**

- Noise Protocol Framework, rev 34 — <https://noiseprotocol.org/noise.html>
- HPKE RFC 9180 — <https://www.rfc-editor.org/rfc/rfc9180>
- SPAKE2 RFC 9382 — <https://www.rfc-editor.org/rfc/rfc9382>
- OPAQUE RFC 9807 — <https://www.rfc-editor.org/rfc/rfc9807>
- Ed25519 RFC 8032 — <https://www.rfc-editor.org/rfc/rfc8032>
- X25519 RFC 7748 — <https://www.rfc-editor.org/rfc/rfc7748>
- ChaCha20-Poly1305 RFC 8439 — <https://www.rfc-editor.org/rfc/rfc8439>
- HKDF RFC 5869 — <https://www.rfc-editor.org/rfc/rfc5869>
- DPoP RFC 9449 — <https://www.rfc-editor.org/rfc/rfc9449>
- MQTT 5.0 — <https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html>
- Web Push RFC 8030 — <https://www.rfc-editor.org/rfc/rfc8030>
- Matrix Spec — <https://spec.matrix.org/>
- Tailscale 架构 — <https://tailscale.com/blog/how-tailscale-works>
- JSON-RPC 2.0 — <https://www.jsonrpc.org/specification>

**轻量部署（PHP/共享主机）**

- PHP Sodium（Ed25519 验签）— <https://www.php.net/manual/en/book.sodium.php>
- PDO — <https://www.php.net/manual/en/book.pdo.php>
- MySQL 锁定读 / `SKIP LOCKED` — <https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html>
- SQLite WAL — <https://www.sqlite.org/wal.html>
- SQLite `BEGIN IMMEDIATE` — <https://www.sqlite.org/lang_transaction.html>

---

## 附录 A：指令目录（v1）

| `type` | 明文载荷 | 结果 | scope |
| --- | --- | --- | --- |
| `agent.ping` | `{nonce}` | `{pong, agent_time}` | `presence` |
| `session.prompt` | `{session_id, text, delivery?}` | `{accepted, turn_id}` | `session.prompt` |
| `session.cancel` | `{session_id}` | `{cancelled}` | `session.cancel` |
| `session.rename` | `{session_id, title}` | `{}` | `session.organize` |
| `session.archive` | `{session_id, stop?}` | `{}` | `session.organize` |
| `session.create` | `{cwd?, title?, preset?, permission?, model?}` | `{session_id}` | `session.create` |
| `session.snapshot` | `{session_id, after_seq?}` | `{turn_id, status, events[], next_seq, truncated}` | `session.read` |
| `env.info` | `{}` | `{os, cpu, mem, disk, dsh, tools[]}` | `env.read` |
| `project.create` | `{path, git?, template?}` | `{project, session?}` | `project.create`（需本地确认） |
| `approval.respond` | `{ask_id, decision, note?}` | `{applied}` | `approval.respond` |
| `question.respond` | `{ask_id, answers, free_text?}` | `{applied}` | `approval.respond` |
| `binding.revoke` | `{binding_id}` | `{}` | `admin`（仅 Agent UI 或 admin 控制端） |
| `key.rotate` | `{epoch, wrapped_keys[]}` | `{}` | 内部 |

> **Lite 允许的指令子集**：`agent.ping`、`session.prompt`、`session.cancel`、`session.rename`、`session.archive`、`approval.respond`、`question.respond`、`session.create`、`session.snapshot`、`env.info`；`project.create` 需 PC 本地确认且默认关闭。`session.snapshot` 用于 gap 恢复/全量补偿；Lite 的流式主路径是**快照上传 + 增量拉取**（§8.9.3），不是指令轮询。

## 附录 B：一次完整交互示例

```
1. Agent 心跳（30s 周期）
   POST /v1/agent/hb  → 200 {next_hb_ms:30000, commands:[]}

2. Controller 发 prompt
   POST /v1/agents/ag_x/commands
   {command_id:"cmd_01", binding_id:"bd_01", envelope:"...", exp:...}
   ← 202 {state:"queued"}

3. Agent 下一次心跳（或长轮询）
   ← 200 {commands:[{id:"cmd_01", envelope:"...", ...}]}
   Agent: HPKE open → ctr 校验 → scope 校验 → sessionController.prompt(...)
   → POST /v1/commands/cmd_01/result {envelope:"...", state:"done"}

4. Controller 拉取
   GET /v1/commands/cmd_01 → 200 {state:"done", envelope:"..."}
   解密 → {accepted:true, turn_id:"t_9"}

5. 想看实时输出 → 申请隧道
   POST /v1/tunnels {agent_id, purpose:"session.attach"} → 201
   Controller WSS + Agent WSS → Noise IK → session.attach → assistant.delta...
```

## 附录 C：设计取舍速查（ADR）

| 决策 | 选择 | 理由 | 放弃的方案 |
| --- | --- | --- | --- |
| 简单操作传输 | HTTP 心跳 + 邮箱 | NAT/代理友好、服务端状态少、离线天然排队 | MQTT broker（缺少应用层 E2EE 语义、额外协议栈） |
| 异步加密 | HPKE Auth | 标准化、无会话状态、发送方认证 | 自研 AES+PSK（无前向保密、密钥分发复杂） |
| 隧道加密 | Noise IK | 1-RTT、双向认证、每连接 FS、成熟 | TLS 双向认证（证书管理重、服务端可见明文） |
| 隧道传输 | WSS relay | 穿透企业代理、无需 UDP、实现简单 | WebRTC 优先（UDP 常被封、栈重；留作 v2） |
| 元数据 | 密封摘要 | 服务端不可见标题/路径 | 明文列表（泄露工作内容） |
| 授权 | Agent 本地绑定为准 | 服务端被攻破也不能越权 | 纯服务端 ACL（单点信任） |
| 审批 | 默认本地，远端可选 | 手机不能成为任务单点 | 全部远端（断网即卡死） |
| 轻量服务端 | HTTP + 关系型数据库轮询（L1） | 可部署在受限托管环境，成本低 | 要求 WebSocket/内存队列/常驻进程 |
| 流式降级 | 快照上传 + 1.5–2s 拉取 | 无隧道也能近实时 | 2–3s 延迟、额外流量 |
| 认证 | Lite 用 `Puppetry1-Sig`，Full 用 DPoP | 共享主机无需 JWT 库 | 两套实现（但语义一致） |
| 协议演进 | 版本 + 能力协商 | 三方独立发版 | 单版本硬编码（无法渐进升级） |

---

## 附录 D：应用场景展望（Muse 类个人助理）

> 本附录为**说明性**内容（非规范性）。它描述在 Puppetry 三端模型之上，把「集中式常驻 agent 服务（Muse 类）」分散到用户自己的固定 PC 端的应用形态与可能场景。该形态超出当前 L1 参考实现（`dsh-puppet` + Lite Relay）的范围，依赖 L2 隧道、主动推送与任务模型等演进（见正文 §8、§11）。

### D.1 形态定位

Muse 类产品（[Meta Muse 等](https://gadgetsnow.indiatimes.com/featured/meta-muse-explained-the-cloud-pc-behind-its-24/7-agent/amp_articleshow/133954455.cms)）的核心形态是：**一台 24/7 常驻、可跨应用操作、能自主拆解并执行任务的「云端 AI 虚拟机」**，用户通过手机/网页随时触达。Puppetry 天然支持把它「去云端化」：

| 角色 | Muse 形态 | Puppetry 对应形态 |
| --- | --- | --- |
| 常驻执行环境 | 云端 AI 虚拟机（供应商托管） | **受控端**：用户自己的固定 PC（只出站连接、数据不出本地） |
| 触达面 | 官方 App / 网页 | **控制端**：基于控制端能力封装的个人助理界面 |
| 消息与协作通道 | 供应商后端 | **服务端**：零知识中继（只转发密文；完整形态含 WSS 隧道与推送） |

这一形态的核心价值：**拿到 Muse 的「全天候自主 agent」体验，但运行环境与数据都在用户自己的机器上**；服务端即使被攻破，也只能看到连接元数据与密文，不掌握任何内容或密钥（§5 的零知识边界在此场景下价值最大）。

### D.2 可能应用场景（展望）

| 场景 | 受控端（PC 上常驻 agent） | 控制端（用户触达） |
| --- | --- | --- |
| 全天候研发助手 | 持续运行 DSH：修 bug、跑测试、管项目、盯 CI | 手机实时看进度、下新任务、审批关键操作 |
| 个人情报 / 日报 | 定时抓取 RSS/邮件/行情，汇总成简报 | 推送摘要、按需看全文 |
| 长期项目管家 | 维护跨会话任务队列与记忆，自动推进 | 查看任务看板、调整优先级 |
| 定时运维 / 巡检 | 定时检查服务/磁盘/日志，异常自愈 | 收告警通知、确认处置 |
| 待办与决策外包 | 把「订票 / 比价 / 整理资料」拆成多步任务执行 | 发目标、中途确认、收结果 |
| 多设备一致会话 | 同一 agent 身份与记忆，多台 PC / 多控制端共享 | 换设备无缝接续 |

### D.3 相对当前协议的能力缺口

按「已具备 / 规范已定义未实现 / 需新增」三档：

| 能力 | 状态 |
| --- | --- |
| 常驻、多控制端、E2EE、离线排队、工具 / 审批 | ✅ 已具备（L0 / L1） |
| 实时流、实时对话、事件推送 | ⚠️ 规范已定义（L2 隧道 §3 / §8.10、长轮询与推送 §6.6），实现待补 |
| 任务生命周期（进度 / 产物 / 取消） | ❌ 需在信封明文新增 `task.*` 指令层 |
| 调度 / 触发器（cron 类） | ❌ 需新增 `schedule.*` 指令层（受控端本地调度） |
| 跨会话记忆 | ⚠️ 主要落在受控端（DSH 侧），协议需暴露 `memory.*` 资源 |
| 附件 / 文件 | ❌ §1.2 已预留 v2（分块 + 隧道直传） |

### D.4 演进路径

1. **M2 实时化**：实现 L2 隧道（WSS + Noise IK + mux），打通实时流 / 实时对话 / 事件通知——这是从「远程控制台」到「个人助理」的分水岭。
2. **M3 任务化**：信封明文新增 `task.*` / `schedule.*` / `memory.*`；受控端加任务状态机与调度器。
3. **M4 体验化**：服务端 Web Push、控制端通知 UI、附件分块（v2）。
4. 全程保持能力协商：Lite 继续可部署，控制端 / 受控端按 `features`（`tunnel` / `long_poll` / `push`）自动降级（§8.7–8.13、§11）。

### D.5 形态边界与代价

- **PC 常驻 ≠ 云端 24/7**：关机 / 睡眠 / 断电会中断。已有 keep-awake，可再加 WoL / 定时开关，但可靠性仍低于托管 VM——这是自托管的固有取舍。
- **服务端需升级**：Lite 只能承载 L1；「完整形态」需 Hybrid / Full Relay（外挂常驻数据面做隧道与推送），受限托管环境无法胜任，需具备常驻数据面的环境。
- **权限仍以本地授权为准**：个人助理形态会放大「自主执行」的风险面，`scope`、`allowedRoots`、本地确认 / 审批瀑布（§9）比在远程编码场景更关键。
