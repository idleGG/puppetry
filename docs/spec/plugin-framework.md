# 开放插件框架

> 前置阅读：[architecture.md](./architecture.md)；完整顺序见 [README.md](./README.md)。

## 1. 开放插件框架

### 1.1 包布局

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

### 1.2 插件清单（manifest）

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

### 1.3 一致性等级

| 等级 | 必须实现 | 可以省略 | 可用部署 |
| --- | --- | --- | --- |
| **L0 Presence** | 注册、心跳、presence、摘要 rev/hash | 指令、隧道 | Lite / Full |
| **L1 Mailbox** | L0 + 指令邮箱、结果、幂等、E2EE 信封 | 隧道 | Lite / Full |
| **L2 Tunnel** | L1 + WSS 隧道、Noise、mux、RPC、事件流 | WebRTC、推送 | Full / Hybrid |
| **L3 Extended**（v2） | 推送、多控制端轮换、WebRTC P2P、附件 | — | Full / Hybrid |

服务端在 `/.well-known/puppetry` 声明等级；控制端按等级降级 UI（例如 L1 时隐藏「新建项目」，改用指令或禁用）。

> **Lite 的目标就是 L1**：它不追求 L2，而是把 L1 做到「任何具备 HTTP + 关系型数据库的环境都能部署」。L2 仍由 Full Relay 或 Hybrid 的外部数据面承担。

### 1.4 版本与兼容

- URL 带主版本：`/v1/`；新增可选字段/新方法不升主版本，靠 `caps` 协商。
- 破坏性变更：升 `/v2/`，三端并行支持至少一个版本周期。
- 禁止静默降级：套件、协议版本不在白名单 → 明确报错。
- 协议包冻结帧名/字段名；改既有形状 = 破坏性变更。

### 1.5 测试与一致性

- **测试向量**：HPKE（RFC 9180 官方向量）、Noise IK golden vector、信封 AAD、摘要密封、绑定签名。
- **一致性套件**：假 Server + 真 Agent + 真 Controller，覆盖：注册、配对、心跳、指令、重放、过期、撤销、隧道、流控、断线。
- **L1-Lite 套件**：用 Lite 参考实现 + 关系型数据库，覆盖 `Puppetry1-Sig`、配对邮箱、ack 驱动队列、快照上传/拉取、机会式 GC；断言「无 WebSocket/内存队列也能通过 L1」。
- **模糊测试**：信封解析、CBOR、帧长度、隧道 mux。
- **安全测试**：服务端无解密路径的静态检查；日志不含 payload 的断言。

