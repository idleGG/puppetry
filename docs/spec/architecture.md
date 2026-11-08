# 架构、目标与设计取舍

> 本模块为协议总览与命名约定，建议作为阅读起点；完整顺序见 [README.md](./README.md)。

## 1. 命名约定（Puppetry）

本方案整体命名为 **Puppetry**。三个角色与名称如下：

| 角色 | 中文 | Puppetry 名称 | 职责 |
| --- | --- | --- | --- |
| Controller | 控制端 | **Puppeteer** | 用户触达面：Web / 移动 App / CLI，持有用户设备密钥 |
| Server / Relay | 服务端 | **Thread** | 公网可达的零知识中继，负责设备注册、在线状态、消息邮箱、隧道转发、推送，**不持有任何内容密钥** |
| Agent | 受控端 | **Puppet** | 运行在 PC 上、装进 DSH 进程的插件，持有 DSH 会话访问能力与设备私钥 |

## 2. 摘要

本设计（Puppetry）把「用手机或网页远程管理 PC 上的 DSH」拆成三个可独立替换的角色：

- **控制端（Controller，即 Puppeteer）**：Web 页面、移动 App、CLI，持有用户设备密钥。
- **服务端（Relay / Server，即 Thread）**：公网可达的零知识中继，负责设备注册、在线状态、消息邮箱、隧道转发、推送，**不持有任何内容密钥**。
- **受控端（Agent，即 Puppet）**：运行在 PC 上、装进 DSH 进程的插件，持有 DSH 会话访问能力与设备私钥。

服务端有两种可选的部署形态（这是实现方的选择，而非协议对实现语言的硬性规定）：

- **Full Relay（L2）**：具备常驻数据面与 WSS 隧道，支持实时流、`env.watch`、大并发。
- **Lite Relay（L1）**：只依赖 HTTP 请求-响应与关系型数据库（无 WebSocket、无常驻进程、无内存队列），即可完成在线状态、会话列表、发指令、审批、结果拉取；适合资源受限的托管环境（共享虚拟主机是典型场景之一，但不是唯一选择）。

两种形态使用同一套身份、加密信封与 L0/L1 语义；服务端通过发现接口声明 `deployment` 与 `features`，控制端/受控端据此自动降级（见[server-design.md](./server-design.md)）。

核心机制是三条：

1. **消息邮箱 + 心跳捎带**：服务端为每个受控端维护一个「邮箱」（mailbox）——即按收件人排队的加密消息队列，类比信箱：控制端投递、受控端取件。受控端周期 `POST /v1/agent/hb` 上报在线状态与会话摘要（密封），服务端在心跳响应里把邮箱中待投递的加密指令捎带下发；指令结果回传后由控制端拉取。简单操作因此不需要隧道，也不要求任何一端常连。
2. **复杂操作按需开隧道**：控制端申请一次性隧道，服务端把双方 WSS 接起来并只转发密文；隧道内跑 Noise IK + 多路复用 RPC，用于新建项目、实时输出、环境观测等。Lite 没有隧道，降级为「指令 + 本地确认 + 快照拉取」（见 [server-design.md](./server-design.md)）。
3. **端到端加密分两层**：异步消息用 **HPKE（RFC 9180）Auth 模式**，隧道用 **Noise IK**；服务端在两种路径上都只能看到密文与必要的路由元数据。

现有生态里没有完全覆盖该形态的成熟方案，但有几个高质量项目可以组合复用（详见第 4 章）：

| 项目 | 最值得借用的部分 | 与本需求的差距 |
| --- | --- | --- |
| [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) | Noise IK、设备身份固定、账号成员校验、Relay/TURN/WebRTC 选路、Host API allowlist | 始终维持常连；没有邮箱式离线投递；栈较重 |
| [dsh-remote/plugin](https://github.com/dsh-remote/plugin) | 零知识 relay、载荷级密封、扫码/短码配对、离线队列、协议包分层 | 常连 WS；无独立隧道 RPC；多控制端未声明 |
| [MoonlitDropOfBlood/dsh-remote-control](https://github.com/MoonlitDropOfBlood/dsh-remote-control) | DSH Host API 映射、审批瀑布、会话纪元抗重放、离线补发 | 常连 + 静态 PSK；无每连接前向保密 |
| [yeerock/dsh-rc](https://github.com/yeerock/deepseek-harness-remote-control) | 用单个出站 WSS 代理原生 DSH Web UI 的工程实现 | **TLS 终止的可信中继**，不满足「服务端不可解密」 |

本方案以「消息邮箱 + 按需隧道 + 一致性等级（L0/L1/L2）」为设计主线，并用一个统一的协议包 `@thread/protocol` 把线格式冻结下来（命名仅为示例，避免与现有 npm 包冲突）。

## 3. 目标、非目标与约束

### 3.1 功能目标

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

### 3.2 非目标（v1 明确不做）

- 远程桌面 / 屏幕镜像。
- 通用 Shell / PTY / 任意文件读写（DSH 自身的工具仍在受控端本地权限内运行，不经远端暴露）。
- 服务端内容搜索、内容审核、内容索引。
- 匿名网络（服务端仍能看到连接元数据）。
- 大文件传输（图片/附件只做有界分块，作为 v2 扩展）。

### 3.3 约束

- **网络**：受控端只做出站连接，不需要公网 IP、端口映射、UDP；企业代理/ TLS 检查网络下也能用。
- **零知识**：服务端代码路径中不存在解密函数；数据库中没有内容明文；日志中不出现 payload。
- **离线容忍**：受控端短时离线不丢指令（TTL 内），恢复后按序补发。
- **低空闲成本**：没有隧道时，受控端只发心跳；控制端不保持常连也能工作。
- **可演进**：协议版本 + 能力协商；加性字段不升主版本，破坏性变更必须升版本并三端同步。
- **部署弹性**：L1 能力应能在「HTTP 请求-响应 + 关系型数据库」这一最小依赖集上实现（不假设 WebSocket、内存队列、常驻进程或可靠定时任务），从而兼容资源受限的托管环境；L2（隧道）才涉及常驻数据面与 WSS。这是设计取向，不限定具体实现语言、数据库或托管平台选型。

## 4. 现有方案调研（截至 2026-10-30）

### 4.1 liguobao/ds-harness-remote（最完整的「远端原生 DSH」实现）

- **形态**：DSH 插件（Host）+ 独立 Server + Web / Android / iOS / VS Code 客户端；当前 `0.5.23`。
- **拓扑**：Host 与 Client 各自向 Server 建立出站 WSS 控制通道；数据面按 `LAN → P2P → TURN → Relay` 选路，所有路径都跑同一条 Noise 通道。
- **加密**：固定 `Noise_IK_25519_ChaChaPoly_SHA256`；每个 Host / Client 独立 `deviceId` 与 X25519 身份密钥；连接必须同时通过「同账号 membership」与「本地 identity pinning」两层校验；Noise prologue 绑定 `connectionId`、Host `deviceId`、Client `deviceId`，防止握手被移植。
- **权限**：Host 解密后仍走官方 Harness API 的固定 allowlist；E2EE 与 allowlist 是两件事。
- **可观察性**：Server 能看到账号/设备归属、在线状态、连接时间、协商版本、路径、帧大小与时序；看不到 prompt、会话、工具输出、workspace 路径。
- **优点**：身份模型、密钥固定、路径回退、流式 RPC、多客户端并发都经过工程打磨；有 golden vector 与较完整文档。
- **与本需求的差距**：它假设「客户端与 Host 之间始终有一条已建立的安全通道」，控制面本身就是常连 WSS；没有「心跳捎带指令」这种低状态模式。对只需要「看一眼状态、发一句话」的移动端来说，常连 + WebRTC 栈偏重。

**可借用**：设备身份与 pinning、两层授权、Noise IK + prologue 绑定、allowlist 思路、Relay 作为最终回退。

### 4.2 dsh-remote/plugin（零知识 relay 的极简形态）

- **形态**：DSH 宿主插件 + 官方微信小程序 + 零知识 WebSocket 中继 + 独立协议包；当前 `0.5.5`。
- **加密**：载荷级端到端加密，中继只见 `base64(nonce ‖ secretbox)`；每会话 PSK；配对码由中继签发，扫码即认领。
- **配对**：主机状态栏 pill 展示小程序码；主机 token 只以环境变量名形式存在配置里。
- **可靠性**：中继离线缓存、断线重连、幂等窗口、协议版本闸；`@dsh-remote/protocol` 把帧、载荷、错误码、能力 id 做成纯函数包。
- **优点**：把「服务端零知识」做得很彻底（连中继构建产物里都不含密码学实现，有测试锁住）；配对 UX 极简；协议包可独立复用。
- **与本需求的差距**：仍是「两端常连中继 + 事件流」；没有单独的隧道 RPC / 多路复用；多控制端与撤销模型未在公开文档中展开。

**可借用**：密封记录格式、扫码配对、离线队列与幂等、`protocol` 包的分层方式（frames / payloads / limits / errors / negotiate）。

### 4.3 MoonlitDropOfBlood/dsh-remote-control（DSH Host API 映射最细）

- **形态**：DSH 插件 + 中继 + HarmonyOS App；当前 `1.1.6`。
- **加密**：配对 `secret` 经 HKDF-SHA256 派生 AES-256-GCM 密钥；每帧 `iv‖ct‖tag`，AAD 绑定发送方 role 与 seq；v1.1.3 增加「会话纪元」（持久化单调递增）+ 对端 `sid` 钉扎，防跨会话重放。
- **可靠性**：中继离线缓存 256 帧 / 24h，`urgent` 帧优先补发；同角色新连接顶替旧连接。
- **审批**：`approval/request` 瀑布拦截，手机超时/断线一律 `next()` 放行给桌面答案器（fail-open），绝不把手机变成任务单点。
- **价值**：其 `docs/PROTOCOL.md` 附录记录了 2026-10 实测的 DSH Host API 事实（`sessionController`、`session/event`、`workspaceRegistry`、`approval/request`、`user-questions/request`、模型/权限目录），可直接作为本设计受控端适配层的实现参考。
- **与本需求的差距**：常连 + 静态 PSK 派生，无每连接前向保密；无隧道 RPC；单控制端模型。

**可借用**：Host API 映射、审批瀑布语义、会话纪元/去重、离线补发上限。

### 4.4 yeerock/dsh-rc（反例：可信中继）

- **形态**：自托管 edge + 桌面 agent + DSH 插件；浏览器访问 `https://edge/d/<device>/`，edge 代理**未修改的 DSH Web UI**。
- **优点**：功能 parity 最好（原生 UI 即客户端），单出站 WSS，NAT 友好；有完整的 mux、流控、优先级调度与压测数据。
- **关键差异**：README 明确说明 edge **终止 TLS、能看到代理明文**，是 trusted relay，不是 E2EE。这与本设计「服务端不可解密、不可查看会话内容」的硬约束冲突，因此只借鉴其「单连接多路复用 + 流控 + 原生 UI」的工程手法，不采用其信任模型。

### 4.5 通用标准与成熟构件

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

### 4.6 结论

- 调研的现有方案多采用「常连 + 固定中继」的设计思路，尚未看到以「邮箱式离线投递 + 按需隧道 + 零知识服务端 + 三方开放」为核心取向的完整方案。
- 现有方案普遍要求常驻中继与 WebSocket，缺少一种能在「HTTP 请求-响应 + 关系型数据库」这种最小依赖上落地的一致性等级；本方案以 Lite 一致性等级补足这一空白（见 [server-design.md](./server-design.md) §1.6–§1.11）。
- 本方案的设计思路是：不发明密码学，只把成熟构件组合成明确的线协议；用一致性等级（L0/L1/L2）定义「哪些能替换、替换后如何互操作」，而非强制单一的部署形态。

## 5. 总体架构

### 5.1 角色与组件

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

> Lite 部署没有「数据面」一列：所有交互都走控制面的短轮询，复杂操作降级为指令 + 快照（见 [server-design.md](./server-design.md) §1.7–§1.8）。图中 WSS 隧道是 Full Relay 的能力，不是协议的强制要求。

### 5.2 控制面 / 数据面分离（借鉴 Tailscale + DERP）

- **控制面只做三件事**：证明「你是谁」、记录「你在不在」、搬运「密封的小消息」。
- **数据面只在需要时建立**：隧道是短时的（默认 5 分钟，可续），关闭后服务端不保留任何会话状态。
- **两条路径共用同一套身份与绑定**：不会出现「心跳里是 A、隧道里是 B」的错配；隧道握手必须绑定 `binding_id` 与双方设备 id。
- **服务端可水平扩展**：心跳/邮箱是无状态 API + 共享存储；隧道节点按 `tunnel_id` 哈希路由，状态放共享缓存。

### 5.3 两种交互模式与选择矩阵

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

### 5.4 信任边界与不变量

| 不变量 | 含义 | 违反即拒绝 |
| --- | --- | --- |
| I1 | 服务端不持有任何能解密业务载荷的密钥 | 服务端代码/配置中出现内容私钥 |
| I2 | 指令必须由已绑定控制端的私钥认证 | HPKE Auth 失败 / 绑定不存在 |
| I3 | 隧道双方必须固定对方身份公钥 | Noise 握手对端静态公钥与绑定不符 |
| I4 | 重放、过期、跨绑定移植的指令必须失败 | 计数器/时间/`binding_id` 校验失败 |
| I5 | 服务端只能影响可用性，不能影响完整性 | 任何「服务端说这是 A 发的」都不被采信 |
| I6 | 受控端的本地策略高于远端指令 | 策略拒绝时返回 `policy_denied`，不执行 |

## 6. 设计取舍速查（ADR）

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

