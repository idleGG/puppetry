# 字段字典：端点、方法、事件、数据模型与指令

> 速查文档，可按需查阅；完整顺序见 [README.md](./README.md)。

## 1. 端点总览

| 方法 | 路径 | 认证 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/v1/devices/enroll` | 设备自签 | 注册，换取令牌 |
| `POST` | `/v1/devices/token` | refresh + DPoP | 轮换 access token |
| `POST` | `/v1/pairings` | Agent | 创建配对窗口 |
| `POST` | `/v1/pairings/{id}/join` | Controller | 加入配对 |
| `POST` | `/v1/pairings/{id}/invitation` | Controller | 提交加密绑定邀约（扫码，[identity-pairing.md](./identity-pairing.md)） |
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

> `/v1/tunnels/*` 只有 Full Relay 提供。Lite 对隧道申请返回 `501 tunnel_unavailable`，可在错误体里带 `alternate_relay`（外部数据面地址），控制端据此走 [server-design.md](./server-design.md) 的降级路径或切换外部 relay。

## 2. RPC 方法（Controller → Agent）

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

错误沿用 JSON-RPC 2.0 错误对象，`data.code` 使用[error-code.md](./error-code.md)同一套错误码。

## 3. 事件（Agent → Controller，流内）

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

## 4. 数据模型（只存元数据/密文）

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

## 5. Lite 的最小数据模型与队列算法

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

## 6. 指令目录（v1）

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

> **Lite 允许的指令子集**：`agent.ping`、`session.prompt`、`session.cancel`、`session.rename`、`session.archive`、`approval.respond`、`question.respond`、`session.create`、`session.snapshot`、`env.info`；`project.create` 需 PC 本地确认且默认关闭。`session.snapshot` 用于 gap 恢复/全量补偿；Lite 的流式主路径是**快照上传 + 增量拉取**（[server-design.md](./server-design.md)），不是指令轮询。

