# Puppetry：DSH 远程控制方案与协议设计

> 版本：0.1（设计草案） · 日期：2026-10-30 · 适用：DeepSeek Harness 0.2.x
> 定位：一份可被第三方分别实现「控制端 / 服务端 / 受控端」的开放协议 + 插件框架。
> 阅读约定：第 4–8、11 章为**规范性**内容（实现方必须一致，其中 §8.8–8.13 为 Lite 参考实现示例）；第 9、10 章为**实现参考**（说明性，非协议规范）；其余章节为设计说明与取舍。
> 第 2 章对现有项目的描述基于其公开 README/协议文档（2026-10-30 检索），版本与行为可能随项目演进而变化。

## 目录

协议规范原为一整份 `puppetry-framework.md`，现按主题拆分为以下文档（章节号沿用原文档，便于交叉引用）：

| 文档 | 内容（对应原章节） |
| --- | --- |
| [architecture.md](./architecture.md) | 命名约定、摘要、目标与约束、现有方案调研、总体架构、设计取舍（ADR） |
| [identity-pairing.md](./identity-pairing.md) | §4 身份、配对与授权（密钥、注册、扫码/短码/手工配对、BindingRecord、撤销与轮换） |
| [e2e-encryption.md](./e2e-encryption.md) | §5 端到端加密设计（套件、HPKE 信封、Noise 隧道、元数据密封、重放与时钟） |
| [message-format.md](./message-format.md) | §6 控制面协议（心跳、指令、长轮询）+ §7 数据面协议（帧、多路复用、断线恢复） |
| [field-dictionary.md](./field-dictionary.md) | 字段字典：端点总览、RPC 方法、事件、数据模型、Lite 数据模型、指令目录 |
| [error-code.md](./error-code.md) | §6.7 错误码 |
| [interaction-flow.md](./interaction-flow.md) | 附录 B 一次完整交互示例 + 各交互流程索引 |
| [server-design.md](./server-design.md) | §8 服务端设计（组件、零知识、滥用防护、部署形态、Lite 实现与清单） |
| [agent-plugin.md](./agent-plugin.md) | §9 受控端（Agent）插件设计（实现参考） |
| [controller-plugin.md](./controller-plugin.md) | §10 控制端（Controller）插件设计（实现参考） |
| [plugin-framework.md](./plugin-framework.md) | §11 开放插件框架（包布局、manifest、一致性等级、版本兼容） |
| [security.md](./security.md) | §12 安全分析 |
| [roadmap.md](./roadmap.md) | §13 落地路线 |
| [references.md](./references.md) | §14 参考资料 |

> 说明：原「附录 D：应用场景展望（Muse 类个人助理）」已迁移到仓库根目录的 [README.md](../../README.md)。
