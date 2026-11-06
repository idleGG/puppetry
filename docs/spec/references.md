# 参考资料

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

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

