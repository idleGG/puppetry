# AGENTS.md — Puppetry 项目

本文件是 Puppetry 仓库的 agent 工作说明，描述项目结构、模块职责与维护约定。协议规范见 `docs/spec/`，受控端插件的说明见 `src/dsh-puppet/`。

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
    designs/                 # 控制端（Puppeteer）UI 设计稿
  src/
    dsh-puppet/              # 受控端插件（Puppet，npm 包）
```

## 关键约定

### 功能模块

- **`src/dsh-puppet/`** — 受控端插件。改动后需完全重启 DSH（HMR 不重新 import 插件模块）；更新/发布流程见 [src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md](src/dsh-puppet/docs/UPDATE-AND-PUBLISH.md)。受控端插件只做出站连接，不需要公网 IP。

### 规范文档

- 协议规范拆分在 `docs/spec/` 下（`architecture` / `identity-pairing` / `e2e-encryption` / `message-format` / `interaction-flow` / `field-dictionary` / `error-code` / `server-design` / 插件与安全等）。
- 修改协议时，同步更新 `docs/spec/README.md` 的目录与各文档内部的交叉引用。

## 代码约定（跨模块）

- 协议规范的规范性内容（[identity-pairing.md](docs/spec/identity-pairing.md)、[e2e-encryption.md](docs/spec/e2e-encryption.md)、[message-format.md](docs/spec/message-format.md)、[server-design.md](docs/spec/server-design.md)、[plugin-framework.md](docs/spec/plugin-framework.md)）实现方必须一致；[agent-plugin.md](docs/spec/agent-plugin.md)、[controller-plugin.md](docs/spec/controller-plugin.md) 为实现参考。
- 不提交密钥、日志、`node_modules`、构建产物到仓库。
