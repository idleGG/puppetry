# 控制端（Controller）插件设计

> 前置阅读：[server-design.md](./server-design.md)；完整顺序见 [README.md](./README.md)。

## 1. 控制端（Controller）插件设计

> 本章为**实现参考**（说明性）：给出控制端 SDK 分层与页面状态机的组织建议，供实现方参考，非协议规范；控制端需要遵守的协议要求见 [identity-pairing.md](./identity-pairing.md)–[server-design.md](./server-design.md)。

### 1.1 分层

```
@thread/client-core     # 无 UI：密钥、配对、HTTP、HPKE、Noise、状态机
@thread/client-web      # Web UI（React/Svelte 均可）
@thread/client-mobile   # React Native / Flutter / 原生壳
@thread/client-cli      # 终端
```

`client-core` 只依赖标准 WebCrypto/Node crypto；UI 层不接触密钥材料，只拿「已解密的事件/会话」。

### 1.2 页面与状态机

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

### 1.3 推送与后台

- 注册 token：`POST /v1/push/register {provider, token}`。
- 服务端只推「有结果 / 有审批 / 任务结束」的事件 id，不推内容。
- App 收到后短连拉取 inbox → 解密 → 本地通知（通知文案通用，避免锁屏泄露）。
- 后台不保持隧道；回到前台再按需开。
- **Lite 没有服务端推送**：前台轮询 `inbox` 或在快照拉取里捎带状态；需要唤醒时，可由 Agent 直接调用外部推送服务（ntfy/Bark/Telegram），只发「有审批/有结果」与一个事件 id，不发内容。

### 1.4 Web 端限制

- 浏览器密钥存 IndexedDB + WebCrypto（尽量非导出）；清缓存 = 丢密钥 = 需重新配对。
- 不建议在共享浏览器上配对；提供「本次会话临时密钥」选项（关闭标签即失效）。
- 移动端优先用 Secure Enclave/Keystore；Web 作为便利层，安全等级在 UI 中明示。

