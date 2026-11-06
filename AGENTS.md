# AGENTS.md — Puppetry 项目

本文件是 Puppetry 仓库的 agent 工作说明，描述项目结构、各模块职责与维护约定。更细的协议规范见 `docs/spec/`，各功能模块的说明见各自目录。

## 项目概述

Puppetry 是 DeepSeek Harness（DSH）的远程控制方案，由三个可独立替换的角色构成：

- **控制端 Puppeteer**：Web / 移动 / CLI，持有用户设备密钥。
- **服务端 Thread**：公网零知识中继，只转发密文与元数据。
- **受控端 Puppet**：装在 PC 上 DSH 进程里的插件（即 `src/dsh-puppet`）。

协议规范、三端架构、E2EE 设计与安全边界见 [docs/spec/README.md](docs/spec/README.md)。

## 目录结构

```text
Puppetry/                    # 本仓库根（git 仓库）
  README.md                  # 项目总览 + 应用场景展望
  AGENTS.md                  # 本文件
  docs/
    spec/                    # 协议规范（拆分后的多份文档）
    designs/                 # UI 设计稿
  src/
    dsh-puppet/              # 受控端插件（Puppet，npm 包）
    un-halt.com/             # 站点公开根目录（docroot）——独立 git 仓库，见下
```

## 关键约定

### Git 边界

- 本仓库（`Puppetry`）是一个 git 仓库，**排除 `src/un-halt.com/`**。
- `src/un-halt.com/` 使用**独立**的 git 仓库跟踪（站点项目与协议/插件分离管理）。
- 修改 `src/un-halt.com/` 前，先读它的 [AGENTS.md](src/un-halt.com/AGENTS.md) 与其 `.agents/skills/` 下的 Skill。

### 功能模块

- **`src/dsh-puppet/`** — 受控端插件。改动后需完全重启 DSH（HMR 不重新 import 插件模块）；更新/发布流程见 [src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md](src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md)。
- **`src/un-halt.com/`** — 站点 + Thread Lite 服务端 + Web 控制端。站点公开根目录即此目录本身；部署/维护分别用它的两个 Skill（`un-halt-site-deploy`、`unhalt-site-maintenance`）。

### 规范文档

- 协议规范拆分在 `docs/spec/` 下（`architecture` / `identity-pairing` / `e2e-encryption` / `message-format` / `interaction-flow` / `field-dictionary` / `error-code` / `server-design` / 插件与安全等）。
- 修改协议时，章节号沿用原文档编号，并同步更新 `docs/spec/README.md` 的目录（如拆分边界变化）。

### 部署与维护

- 站点变更的部署走 `src/un-halt.com/.agents/skills/un-halt-site-deploy`（`--target preview` / `--target production`）；production 为覆盖式发布，执行前需经用户确认。
- 站点功能变更按 `src/un-halt.com/.agents/skills/unhalt-site-maintenance` 的约束，完成后同步更新其 SKILL.md。
- 插件发布走 npm / GitHub（见 UPDATE-AND-PUBLISH.md）；受控端插件不需要公网 IP。

## 代码约定（跨模块）

- 协议规范的规范性内容（§4–8、§11）实现方必须一致；§9、§10 为实现参考。
- 站点 PHP 按 PHP 5.6+ 兼容编写（`lib` 用 `array()` 语法）；Thread 模块需 PHP 7.4+ 且启用 `sodium`、`pdo_mysql`。
- 所有 HTML 输出必须 `htmlspecialchars(..., ENT_QUOTES, 'UTF-8')` 转义；JSON 走统一响应函数。
- 不提交密钥、日志、`node_modules`、构建产物到仓库。
