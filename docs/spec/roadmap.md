# 落地路线

> 前置阅读：[architecture.md](./architecture.md)；完整顺序见 [README.md](./README.md)。

## 1. 落地路线

| 阶段 | 目标 | 交付 |
| --- | --- | --- |
| M0（2–3 周） | 打通「看状态 + 发 prompt」 | `protocol` + Agent 心跳/邮箱 + Relay L1 + Web 控制端 |
| M1（2 周） | 配对与 E2EE 完整 | QR/短码、HPKE 信封、密封摘要、撤销 |
| M1.5（1–2 周） | **轻量部署可用** | PHP `relay-lite`（L1）+ 配对邮箱 + 快照上传/拉取 + 部署清单 |
| M2（3 周） | 复杂操作 | WSS 隧道、Noise、mux、`session.attach`、`env.watch`、`project.create` |
| M3（2 周） | 多端与生产化 | 多控制端、轮换、推送、审计、一致性套件、移动端 |
| M4（可选） | 体验与规模 | WebRTC P2P、附件分块、联邦/多地域 |

**受控端参考实现**：本工作区的 `dsh-puppet/` 已按本文的 L1（心跳 + 指令邮箱）实现了一版可安装的 DSH 插件：Ed25519/X25519 身份、`Puppetry1-Sig` 每请求签名、HPKE Auth 指令/结果、扫码/拷贝 token 邀约绑定（[identity-pairing.md](./identity-pairing.md)）、`session.snapshot` 降级、保持唤醒（Windows/macOS/Linux）以及本机设置页（`/puppet-settings`）。它把密封摘要的退化模式简化为 `mode:"summary"`（不含标题），并把手工导入 BindingRecord 保留为离线/救援路径。

**建议先做的三个验证**：

1. 用假 Server 跑通「心跳 → 指令 → 结果」闭环，确认 30s/长轮询两种延迟可接受。
2. 用 RFC 9180 向量验证 HPKE Auth 在 WebCrypto、移动端等不同平台的互操作。
3. 用真实 DSH Host 验证 `session.prompt` 的「受理即返回 + 事件流」语义，避免把长任务阻塞在指令结果里。
4. 用一台资源受限的主机跑通 Lite：签名心跳、配对邮箱、指令往返、快照上传/拉取，确认受限执行时间与定时任务约束下都稳定。

