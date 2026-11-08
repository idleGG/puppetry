# Puppetry

DSH（DeepSeek Harness）的远程控制方案与开放协议：把「用手机或网页远程管理 PC 上的 DSH」拆成三个可独立替换的角色，并用一套零知识的线协议把它们接起来。

| 角色 | 中文 | 名称 | 职责 |
| --- | --- | --- | --- |
| Controller | 控制端 | **Puppeteer** | 用户触达面（Web / 移动 App / CLI），持有用户设备密钥 |
| Server / Relay | 服务端 | **Thread** | 公网可达的零知识中继，只转发密文与元数据，不持有内容密钥 |
| Agent | 受控端 | **Puppet** | 运行在 PC 上、装进 DSH 进程的插件，持有会话访问能力与设备私钥 |

核心机制：**消息邮箱 + 心跳捎带**（简单操作无需常连）、**复杂操作按需开隧道**（WSS + Noise，Lite 降级为快照拉取）、**端到端加密分两层**（异步用 HPKE Auth，隧道用 Noise IK）。

## 目录结构

```
.
├── README.md                 # 本文件（项目总览 + 展望）
├── AGENTS.md                 # agent 工作说明
├── docs/
│   ├── spec/                 # 协议规范（拆分后的多份文档）
│   └── designs/              # 控制端（Puppeteer）UI 设计稿
└── src/
    └── dsh-puppet/           # 受控端插件（Puppet）
```

- 协议规范：见 [docs/spec/README.md](docs/spec/README.md)。
- 受控端插件：见 [src/dsh-puppet/README.md](src/dsh-puppet/README.md)。

## 快速开始

```bash
# 本地开发安装受控端插件（link）
dsh plugin --profile <profile> add link:/path/to/src/dsh-puppet
```

安装后**完全退出并重开 DSH**。详细安装、更新、发布与公网部署见 [src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md](src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md)。

## 项目展望：应用场景（Muse 类个人助理）

> 本节为**说明性**内容。它描述在 Puppetry 三端模型之上，把「集中式常驻 agent 服务（Muse 类）」分散到用户自己的固定 PC 端的应用形态与可能场景。该形态超出当前 L1 参考实现（`dsh-puppet` + Lite Relay）的范围，依赖 L2 隧道、主动推送与任务模型等演进（见协议规范 [server-design.md](docs/spec/server-design.md) 与 [plugin-framework.md](docs/spec/plugin-framework.md)）。

### 形态定位

Muse 类产品（[Meta Muse 等](https://gadgetsnow.indiatimes.com/featured/meta-muse-explained-the-cloud-pc-behind-its-24/7-agent/amp_articleshow/133954455.cms)）的核心形态是：**一台 24/7 常驻、可跨应用操作、能自主拆解并执行任务的「云端 AI 虚拟机」**，用户通过手机/网页随时触达。Puppetry 天然支持把它「去云端化」：

| 角色 | Muse 形态 | Puppetry 对应形态 |
| --- | --- | --- |
| 常驻执行环境 | 云端 AI 虚拟机（供应商托管） | **受控端**：用户自己的固定 PC（只出站连接、数据不出本地） |
| 触达面 | 官方 App / 网页 | **控制端**：基于控制端能力封装的个人助理界面 |
| 消息与协作通道 | 供应商后端 | **服务端**：零知识中继（只转发密文；完整形态含 WSS 隧道与推送） |

这一形态的核心价值：**拿到 Muse 的「全天候自主 agent」体验，但运行环境与数据都在用户自己的机器上**；服务端即使被攻破，也只能看到连接元数据与密文，不掌握任何内容或密钥（协议规范 [e2e-encryption.md](docs/spec/e2e-encryption.md) 的零知识边界在此场景下价值最大）。

### 可能应用场景（展望）

| 场景 | 受控端（PC 上常驻 agent） | 控制端（用户触达） |
| --- | --- | --- |
| 全天候研发助手 | 持续运行 DSH：修 bug、跑测试、管项目、盯 CI | 手机实时看进度、下新任务、审批关键操作 |
| 个人情报 / 日报 | 定时抓取 RSS/邮件/行情，汇总成简报 | 推送摘要、按需看全文 |
| 长期项目管家 | 维护跨会话任务队列与记忆，自动推进 | 查看任务看板、调整优先级 |
| 定时运维 / 巡检 | 定时检查服务/磁盘/日志，异常自愈 | 收告警通知、确认处置 |
| 待办与决策外包 | 把「订票 / 比价 / 整理资料」拆成多步任务执行 | 发目标、中途确认、收结果 |
| 多设备一致会话 | 同一 agent 身份与记忆，多台 PC / 多控制端共享 | 换设备无缝接续 |

### 相对当前协议的能力缺口

按「已具备 / 规范已定义未实现 / 需新增」三档：

| 能力 | 状态 |
| --- | --- |
| 常驻、多控制端、E2EE、离线排队、工具 / 审批 | ✅ 已具备（L0 / L1） |
| 实时流、实时对话、事件推送 | ⚠️ 规范已定义（L2 隧道见 [architecture.md](docs/spec/architecture.md)，长轮询与推送见 [message-format.md](docs/spec/message-format.md)），实现待补 |
| 任务生命周期（进度 / 产物 / 取消） | ❌ 需在信封明文新增 `task.*` 指令层 |
| 调度 / 触发器（cron 类） | ❌ 需新增 `schedule.*` 指令层（受控端本地调度） |
| 跨会话记忆 | ⚠️ 主要落在受控端（DSH 侧），协议需暴露 `memory.*` 资源 |
| 附件 / 文件 | ❌ 已在 [architecture.md](docs/spec/architecture.md) 预留 v2（分块 + 隧道直传） |

### 演进路径

1. **M2 实时化**：实现 L2 隧道（WSS + Noise IK + mux），打通实时流 / 实时对话 / 事件通知——这是从「远程控制台」到「个人助理」的分水岭。
2. **M3 任务化**：信封明文新增 `task.*` / `schedule.*` / `memory.*`；受控端加任务状态机与调度器。
3. **M4 体验化**：服务端 Web Push、控制端通知 UI、附件分块（v2）。
4. 全程保持能力协商：Lite 继续可部署，控制端 / 受控端按 `features`（`tunnel` / `long_poll` / `push`）自动降级（见 [server-design.md](docs/spec/server-design.md)、[plugin-framework.md](docs/spec/plugin-framework.md)）。

### 形态边界与代价

- **PC 常驻 ≠ 云端 24/7**：关机 / 睡眠 / 断电会中断。已有 keep-awake，可再加 WoL / 定时开关，但可靠性仍低于托管 VM——这是自托管的固有取舍。
- **服务端需升级**：Lite 只能承载 L1；「完整形态」需 Hybrid / Full Relay（外挂常驻数据面做隧道与推送），受限托管环境无法胜任，需具备常驻数据面的环境。
- **权限仍以本地授权为准**：个人助理形态会放大「自主执行」的风险面，`scope`、`allowedRoots`、本地确认 / 审批瀑布（见 [agent-plugin.md](docs/spec/agent-plugin.md)）比在远程编码场景更关键。

## License

MIT
