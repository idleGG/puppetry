# 消息格式与控制面/数据面协议

> 前置阅读：[e2e-encryption.md](./e2e-encryption.md)；完整顺序见 [README.md](./README.md)。

## 1. 控制面协议（心跳 + 邮箱）

「邮箱」（mailbox）在本协议中指服务端为每个设备维护的待投递加密消息队列（定义见 [architecture.md](./architecture.md) 摘要）：控制端把加密指令投递到受控端的邮箱，受控端在下一次心跳时取走并执行，再回传加密结果。本章规定这一「心跳 + 邮箱」控制面的全部端点、消息结构与可靠性语义。

### 1.1 心跳请求

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
  "models": {                          // 受控端可用模型，按 provider 分组（明文，同 caps/limits 非敏感）
    "default": { "provider": "deepseek", "model": "deepseek-chat" },
    "groups": [
      { "id": "deepseek", "name": "DeepSeek", "models": [
        { "id": "deepseek-chat", "name": "DeepSeek Chat" },
        { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner" }
      ] }
    ]
  },
  "digest": { "epoch": 3, "rev": 57, "hash": "sha256:...", "count": 12 },
  "active": { "running": 1, "tunnel": null },
  "health": { "cpu": 0.18, "mem": 0.42, "disk_free": 123456789012 },
  "bindings": { "count": 2, "epoch": 5 },
  "acks": [ { "command_id": "cmd_...", "state": "done" } ],
  "resync": [ { "binding_id": "bd_...", "after_ctr": 41 } ]
}
```

### 1.2 心跳响应

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
  "pairings": [{                     // 扫码邀约，见 [identity-pairing.md](./identity-pairing.md)；服务端只搬运密文
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

### 1.3 会话摘要同步（Lite 发 prompt 的基础）

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
- **发 prompt**：控制端对已有会话 `POST /v1/agents/{id}/commands` 提交 `session.prompt` 指令（HPKE Auth 信封），受控端心跳取回执行后 `POST /v1/commands/{id}/result` 回传 `{accepted, turn_id}`；控制端轮询 `GET /v1/commands/{id}` 取结果（见 §1.4）。
- **本地清理**：控制端在浏览器 IndexedDB 只保留最近 `n` 个会话 × 每会话 `m` 条消息，超过阈值的消息定期清理（阈值可在控制端配置）。
- 心跳里只有 hash，不传标题/消息；服务端只存 blob，无法做内容索引。
- 较复杂操作（新建工作区、翻看更久历史）需走 `session.create` / `session.page` 等受控端指令或隧道，不在本摘要窗口内（见 [server-design.md](./server-design.md) / [agent-plugin.md](./agent-plugin.md)）。

### 1.4 指令生命周期

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

### 1.5 长轮询与延迟优化

纯心跳的指令延迟 = 心跳间隔（默认 30s，最坏 30s）。为了让「发一句话」接近即时，同时不引入常连：

1. **交互态长轮询**：控制端打开某个会话/刚提交指令时，Agent 切到 `POST /v1/agent/hb?wait=25`；服务端在没有指令时挂起最多 25s，有指令立即返回。
2. **邮箱唤醒**：Agent 处于长轮询时，新指令直接完成该请求；否则等下一次心跳。
3. **配对/隧道窗口**：Agent 展示配对码或刚收到 tunnel offer 时，临时切长轮询 2 分钟。
4. **空闲回退**：无交互 2 分钟后回到 30s 心跳；电池/流量友好。

> 这不违反「简单操作不必建立持续性长连接」：长轮询仍是请求-响应，服务端不维护 per-connection 会话状态；只是把「等待」放在一次 HTTP 请求里。

**Lite 不提供长轮询**：`features.long_poll=false`，Agent 按 `heartbeat.min_ms/max_ms` 固定间隔发心跳；控制端提交指令后按 1s → 2s → 5s → 10s 退避拉取结果，前台时最长 30s 放弃并提示「已排队，稍后通知」。这让单次请求的执行时间保持在共享主机允许的范围内。

## 2. 数据面协议（按需隧道）

### 2.1 建立流程

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
- 隧道是 **L2 能力**：Lite Relay 不提供 WSS。控制端收到 `tunnel_unavailable` 后按 [server-design.md](./server-design.md) 改用快照拉取，或切换到外部 relay（Hybrid），不对同一 Lite 端点反复重试。

### 2.2 外层帧（服务端可见）

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

### 2.3 内层多路复用（Noise 明文内）

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

### 2.4 断线、恢复与关闭

| 场景 | 行为 |
| --- | --- |
| 网络切换 | 隧道断开；控制端重新申请；不自动重放「结果未知」的 mutation |
| 服务端节点迁移 | `GOAWAY` → 双方在 5s 内重连同一 `tunnel_id`（ticket 未过期） |
| 短暂断线 | 服务端为每个方向缓存 ≤ 256 KiB / 60s；重连带 `last_recv_seq` 续传；超出则 `RESET` |
| 空闲 | 90s 无帧关闭；可由任一方 `PING` 续命 |
| 主动关闭 | `CLOSE {code:"normal"}`；服务端释放配对状态 |
| 协议错误 | `CLOSE {code:"protocol_error"}`，记录审计（不含载荷） |

