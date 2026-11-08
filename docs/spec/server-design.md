# 服务端设计

> 前置阅读：[message-format.md](./message-format.md)；完整顺序见 [README.md](./README.md)。

## 1. 服务端设计

### 1.1 组件

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

### 1.2 零知识如何被「工程保证」

1. **协议层**：服务端只接收 `envelope`/`blob` 字段，schema 里没有 `plaintext` 字段；解析器拒绝未知字段。
2. **代码层**：server 构建产物不依赖任何 AEAD/HPKE/Noise 解密实现；CI 用静态检查 + 依赖白名单锁住。
3. **存储层**：数据库列名 `*_blob`/`*_ct`；备份加密；日志脱敏（不打印 payload，只打印长度与 hash）。
4. **运维层**：生产环境禁止抓包落盘；审计只记「谁在何时对哪个设备做了什么」。
5. **可选**：机密计算/TEE 或自托管，进一步降低「服务端被攻破」的信任成本。

### 1.3 开放/公共服务的滥用防护

- 每设备：邮箱 1000 条 / 24h，指令 60 条/分钟，隧道 8 MiB/s。
- 每 IP/ASN：注册 10 个设备/天，配对 20 次/小时，失败配对指数退避。
- 信封大小上限：指令 64 KiB、结果 256 KiB、摘要 256 KiB、事件 64 KiB。
- 隧道：每设备 4 条并发，单条 5 分钟，空闲 90s 关闭。
- 公开服务器可要求「邀请码/工作量证明/邮箱验证」之一，按部署方策略。
- **Lite 部署**使用更小限额（每设备 120 req/min、每次心跳 ≤16 条且总 ≤128 KiB、结果 ≤64 KiB、摘要 ≤128 KiB），见 §1.11；限额是协议可协商项，不是硬编码。

### 1.4 部署与伸缩（Full Relay）

- 无状态 API + 关系型数据库（主从）+ 内存缓存（presence/长轮询唤醒/限流）。
- 隧道节点按 `tunnel_id` 哈希到固定节点；节点间用共享缓存发布订阅完成「双方到齐」通知。
- 多地域：控制端与 Agent 各自就近接入；隧道必须落在同一节点（用 DNS/Anycast + 一致性哈希）。
- 灾备：邮箱与摘要持久化；隧道状态可丢（重建即可）。
- Lite 的部署模型完全不同，见 §1.6–§1.11。

### 1.5 服务端插件 SPI（第三方定制）

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

### 1.6 部署形态：Full Relay / Lite Relay / Hybrid

| 形态 | 运行环境 | 等级 | 隧道 | 长轮询 | 推送 | 典型场景 |
| --- | --- | --- | --- | --- | --- | --- |
| **Full Relay** | VPS/容器，常驻数据面，关系型数据库/内存缓存 | L0–L2 | WSS | 支持 | APNs/FCM/WebPush | 生产、多用户、低延迟 |
| **Lite Relay** | 受限托管环境（如共享虚拟主机），关系型数据库 | L0–L1 | 无 | 不支持 | 可选 webhook | 个人、小团队、资源受限环境 |
| **Hybrid** | Lite 控制面 + 外部 WSS relay 数据面 | L0–L2 | 外部 | 不支持 | 可选 | 想保留流式但不想自建全套 |

核心原则：**L1 的语义只依赖四样东西**——HTTP/1.1 请求-响应、一个支持事务的关系型数据库、Ed25519 验签、HTTPS。它不要求 WebSocket、内存队列、消息队列、常驻进程或可靠定时任务。L2（隧道）才允许要求这些。

**Full Relay 的能力与特性**（对应 L2）：

| 能力 | 说明 |
| --- | --- |
| 实时流 | 隧道内 `session.attach` / `assistant.delta` / `tool.call` 等事件实时推送（[message-format.md](./message-format.md)） |
| 环境实时观测 | `env.watch` 周期采样推送（[field-dictionary.md](./field-dictionary.md)） |
| 长轮询 | `POST /v1/agent/hb?wait=25` 让指令延迟接近 RTT（[message-format.md](./message-format.md)） |
| 主动推送 | APNs/FCM/WebPush 唤醒控制端（只推事件 id，不推内容） |
| 多控制端实时协同 | 多个控制端可同时订阅同一会话的事件流 |
| 横向扩展 | 无状态 API + 隧道节点按 `tunnel_id` 哈希；多地域就近接入（§1.4） |
| 节点迁移 | 隧道 `GOAWAY` → 5s 内重连同一 `tunnel_id`（[message-format.md](./message-format.md)） |
| 断线续传 | 每方向缓存 ≤256 KiB/60s，`last_recv_seq` 续传（[message-format.md](./message-format.md)） |

Full Relay 面向「低延迟、流式、多用户」场景；Lite 面向「低依赖、个人/小团队」场景。二者使用同一套身份、信封与 L0/L1 语义，通过能力发现（`/.well-known/puppetry`）自动切换，部署方无需修改两端实现。

### 1.7 Lite Relay：目标环境与能力边界

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

### 1.8 Lite 协议增量（必须实现）

#### 1.8.1 每请求签名 `Puppetry1-Sig`

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

#### 1.8.2 配对邮箱（替代配对隧道）

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

#### 1.8.3 流式降级：快照上传 + 增量拉取

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

成本：一个活跃 turn 约 1 次上传/秒 + 1 次拉取/2 秒；个人站点可接受，多用户共享主机需要限额（见 §1.11）。**为什么不复用指令**：指令要等心跳（15–30s），做不到 2s 级；快照上传/拉取是独立短请求，不等心跳。

Agent 仍保留环形缓冲（512 条 / 256 KiB / 10 分钟），用于 `session.snapshot` 的 gap 恢复与断线补看；事件 schema 与隧道事件完全一致，UI 渲染逻辑可复用。

#### 1.8.4 指令化的复杂操作

Lite 把一部分原本走隧道的操作改成「指令 + 本地确认 + 结果」：

| 指令 | 载荷 | 本地确认 | 说明 |
| --- | --- | --- | --- |
| `session.create` | `{cwd?, title?, preset?, permission?, model?}` | 可选（默认允许，受 `allowed_roots` 限制） | 创建成功返回 `session_id` |
| `project.create` | `{path, git?, template?}` | **必须** | 默认关闭；路径必须在 `allowed_roots` 下 |
| `env.info` | `{}` | 否 | 一次性快照；受心跳间隔限制（15–30s） |
| `session.snapshot` | `{session_id, after_seq?}` | 否 | gap 恢复/全量环形缓冲；不是主路径 |

`project.create` 的确认在 PC 端弹出（DSH 通知/插件 UI），远端等待 ≤120s；超时/无人在场 → `policy_denied`。这样既保留「复杂操作需要人在场」的安全语义，又不要求 WebSocket。

#### 1.8.5 隧道不可用时的返回

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

### 1.9 Lite 参考实现示例（以 PHP 为例）

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

### 1.10 Lite 的限制、失败模式与安全

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

### 1.11 Lite 参考实现部署清单（PHP 示例）

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

