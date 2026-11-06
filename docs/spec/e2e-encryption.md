# 端到端加密设计

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

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

