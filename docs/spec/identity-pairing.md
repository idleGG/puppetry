# 身份、配对与授权

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

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

