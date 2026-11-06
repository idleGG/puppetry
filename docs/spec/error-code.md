# 错误码

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

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

