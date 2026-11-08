# Puppetry：DSH 远程控制方案与协议设计

> 版本：0.1（设计草案） · 日期：2026-10-30 · 适用：DeepSeek Harness 0.2.x
> 定位：一份可被第三方分别实现「控制端 / 服务端 / 受控端」的开放协议 + 插件框架。
> 阅读约定：`identity-pairing`、`e2e-encryption`、`message-format`、`server-design`、`plugin-framework` 为**规范性**内容（实现方必须一致，其中 `server-design` 的 Lite 部分为参考实现示例）；`agent-plugin`、`controller-plugin` 为**实现参考**（说明性，非协议规范）；其余为设计说明与取舍。
> 第 4 章对现有项目的描述基于其公开 README/协议文档（2026-10-30 检索），版本与行为可能随项目演进而变化。

## 推荐阅读顺序

以下为各模块的推荐阅读顺序：

| 顺序 | 文档 | 内容 |
| --- | --- | --- |
| 1 | [architecture.md](./architecture.md) | 命名约定、摘要、目标与约束、现有方案调研、总体架构、设计取舍（ADR） |
| 2 | [identity-pairing.md](./identity-pairing.md) | 身份、配对与授权（密钥、注册、扫码/短码/手工配对、BindingRecord、撤销与轮换） |
| 3 | [e2e-encryption.md](./e2e-encryption.md) | 端到端加密设计（套件、HPKE 信封、Noise 隧道、元数据密封、重放与时钟） |
| 4 | [message-format.md](./message-format.md) | 控制面协议（心跳、指令、长轮询）+ 数据面协议（帧、多路复用、断线恢复） |
| 5 | [server-design.md](./server-design.md) | 服务端设计（组件、零知识、滥用防护、部署形态、Lite 实现与清单） |
| 6 | [agent-plugin.md](./agent-plugin.md) | 受控端（Agent）插件设计（实现参考） |
| 7 | [controller-plugin.md](./controller-plugin.md) | 控制端（Controller）插件设计（实现参考） |
| 8 | [plugin-framework.md](./plugin-framework.md) | 开放插件框架（包布局、manifest、一致性等级、版本兼容） |
| 9 | [security.md](./security.md) | 安全分析 |
| 10 | [roadmap.md](./roadmap.md) | 落地路线 |
| 11 | [field-dictionary.md](./field-dictionary.md) | 字段字典：端点总览、RPC 方法、事件、数据模型、Lite 数据模型、指令目录（速查） |
| 12 | [error-code.md](./error-code.md) | 错误码（速查） |
| 13 | [interaction-flow.md](./interaction-flow.md) | 各交互流程索引 + 一次完整交互示例 |
| 14 | [references.md](./references.md) | 参考资料 |

## 目录（按文档）

| 文档 | 章节 |
| --- | --- |
| [architecture.md](./architecture.md) | §1 命名约定 · §2 摘要 · §3 目标非目标约束 · §4 现有方案调研 · §5 总体架构 · §6 设计取舍速查 |
| [identity-pairing.md](./identity-pairing.md) | §1 身份配对授权（§1.1 密钥标识 · §1.2 设备注册 · §1.3 配对 · §1.4 BindingRecord · §1.5 撤销轮换） |
| [e2e-encryption.md](./e2e-encryption.md) | §1 端到端加密（§1.1 套件 · §1.2 HPKE 信封 · §1.3 Noise 隧道 · §1.4 元数据密封 · §1.5 重放时钟 · §1.6 服务端可见性） |
| [message-format.md](./message-format.md) | §1 控制面协议 · §2 数据面协议 |
| [server-design.md](./server-design.md) | §1 服务端设计（§1.1–§1.11，含 Lite） |
| [agent-plugin.md](./agent-plugin.md) | §1 受控端插件设计 |
| [controller-plugin.md](./controller-plugin.md) | §1 控制端插件设计 |
| [plugin-framework.md](./plugin-framework.md) | §1 开放插件框架 |
| [security.md](./security.md) | §1 安全分析 |
| [roadmap.md](./roadmap.md) | §1 落地路线 |
| [field-dictionary.md](./field-dictionary.md) | §1 端点总览 · §2 RPC 方法 · §3 事件 · §4 数据模型 · §5 Lite 数据模型 · §6 指令目录 |
| [error-code.md](./error-code.md) | §1 错误码 |
| [interaction-flow.md](./interaction-flow.md) | §1 流程索引 · §2 完整交互示例 |
| [references.md](./references.md) | §1 参考资料 |
