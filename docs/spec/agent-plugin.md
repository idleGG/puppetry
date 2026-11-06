# 受控端（Agent）插件设计

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

## 9. 受控端（Agent）插件设计

> 本章为**实现参考**（说明性）：描述受控端参考实现（DSH 插件）的组织方式与内部接口，非协议规范；受控端需要遵守的协议要求见 §4–§8。

### 9.1 在 DSH 中的形态

- 一个 DSH **host bundle**：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入插件；可选 `dsh.client` 提供设置页/配对二维码。
- 兼容门：`engines.dsh` 与 peerDependencies 使用双段范围（参考社区插件的做法），否则会被静默禁用。
- 安装：`dsh plugin --profile <profile> add <pkg>`；改代码后需完全重启（HMR 只热更配置，不重新 import）。

### 9.2 模块划分

```
src/
  index.ts            # 插件入口：读配置、装配、注册命令/设置页
  identity.ts         # 密钥生成/加载、keychain、agent_id
  enroll.ts           # 设备注册、DPoP / Puppetry1-Sig、token 刷新
  pairing.ts          # QR/短码、Noise XXpsk3 / 配对邮箱、BindingRecord
  heartbeat.ts        # 定时器、长轮询、退避、server_time 偏移
  mailbox.ts          # 解密指令、去重、计数器、结果回传
  tunnel.ts           # Noise IK、mux、RPC 分发、流控（L2）
  snapshot.ts         # 环形事件缓冲、快照上传（Lite）、session.snapshot 响应
  capability.ts       # 读取 server/info，决定长轮询/隧道/轮询策略
  adapter/            # Host Adapter（DSH API 映射）
  policy.ts           # scope、allowed_roots、远程审批开关、限速
  audit.ts            # 本地审计（谁在何时做了什么）
  ui/                 # 设置页、配对二维码、状态 pill
```

### 9.3 Host Adapter 接口

```ts
export interface PuppetAgentHost {
  readonly info: AgentInfo;

  listSessions(opts?: { includeArchived?: boolean }): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  getHistory(id: string, opts: { beforeSeq?: number; limit?: number }): Promise<HistoryPage>;

  createSession(input: CreateSessionInput): Promise<SessionSummary>;
  prompt(input: PromptInput): Promise<PromptReceipt>;
  cancel(sessionId: string): Promise<boolean>;
  rename(sessionId: string, title: string): Promise<void>;
  archive(sessionId: string, opts?: { stop?: boolean }): Promise<void>;

  subscribe(sessionId: string, afterSeq: number, cb: (e: SessionEvent) => void): Unsubscribe;
  capabilities(): Promise<HostCapabilities>;
  environment(): Promise<EnvironmentInfo>;

  createProject?(input: ProjectInput): Promise<ProjectInfo>;
  respondApproval?(askId: string, decision: ApprovalDecision): Promise<boolean>;
  respondQuestion?(askId: string, answers: AnswerMap): Promise<boolean>;
}
```

**DSH API 映射参考**（来自社区 2026-10 实测，可能随版本变化；实现时应做能力探测与降级）：

| Adapter 方法 | DSH 侧 | 备注 |
| --- | --- | --- |
| `listSessions` | `sessionController.list({}, signal)` + `projections` 拼标题 | list 不含 title，需投影 |
| `getHistory` | `sessionController` 历史/投影 + `session/event` | 含 `steps`、`reasoning` |
| `createSession` | `sessionController.create({cwd, agentPreset})` | 创建后再 rename/selectModel |
| `prompt` | `sessionController.prompt({requestId, sessionId, mode:'queue', content:[{type:'text',text}]})` | 繁忙时按宿主 `busyEnter` 策略 |
| `cancel` | `sessionController.cancel(sessionId)` | — |
| `archive` | `workspaceRegistry.archiveSession(id, {stopActivity})` | 运行中归档可能被拒绝 |
| `subscribe` | `ctx.on('session/event', (session, event) => …)` | `tool/call`、`tool/result`、`assistant/message` 等 |
| `respondApproval` | `approval/request` 瀑布答案器 | 返回 `allowed-once/rejected/cancelled/unavailable` |
| `respondQuestion` | `user-questions/request` 瀑布 | answers 结构随宿主 |
| `capabilities` | `agentPresets` / `permissionPresets` / `modelCatalog` | 空目录则隐藏对应 UI |
| `environment` | `os`/`process` + DSH 版本 + PATH 探测 | 采样需限频 |

> 关键点：**远端指令最终仍以「用户 prompt」进入 DSH 会话**，沿用该会话的 permission preset 与工具审批；远控插件不绕过 DSH 的权限系统。

### 9.4 本地策略与审批

```yaml
policy:
  allowed_controllers: [bd_...]        # 缺省=全部已绑定
  scopes: [presence, session.list, session.prompt, session.read]
  allowed_roots: ["D:/work", "D:/projects"]
  remote_approval: false               # 默认关闭：审批只在 PC 上做
  require_local_confirm: ["project.create", "danger-full-access"]
  max_commands_per_min: 20
  quiet_hours: "23:00-08:00"           # 静默期只读
```

审批语义（必须 fail-open 到本地，不能 fail-closed 卡死任务）：

- 手机在线且 `remote_approval=true` 且 binding 有 `approval.respond` → 转发给手机，等待 ≤120s。
- 超时/断线/手机拒绝通道异常 → `next()` 交还桌面答案器。
- 高危操作（`danger-full-access`、写系统目录、执行任意命令）→ 强制本地确认，手机只能看到提示。
- 所有远端审批动作写本地审计（ask_id、决定、来源、耗时）。

### 9.5 生命周期

| 事件 | 行为 |
| --- | --- |
| DSH 启动 | 加载密钥 → 注册/刷新 token（Lite 无 token）→ 首次心跳 → 恢复未完成指令（按 ctr 去重） |
| 进程重启 | `boot_id` 变化；服务端可识别「同一设备的新实例」，清理旧长轮询 |
| 休眠/唤醒 | 心跳失败 → 指数退避（1s→60s，full jitter）；唤醒后立即心跳 |
| 网络切换 | 心跳/隧道各自重连；隧道不迁移，重建即可 |
| 多实例 | 文件锁（state dir）拒绝第二个 Agent，避免双心跳/双执行 |
| 服务端为 Lite | 心跳按 `server/info.heartbeat` 定时；不尝试长轮询/隧道；配对走配对邮箱；流式走快照上传/拉取 |
| 撤销 | 收到 `bindings.revoked` → 删除本地绑定 → 拒绝该控制端所有指令 |
| 卸载 | 删除本地密钥与状态（可选保留审计） |

### 9.6 密钥存储

- 优先 OS keychain；不可用时退化为 `0600` 文件 + 明确警告（Windows 上 chmod 只切只读位，需显式提示）。
- 私钥不写日志、不进崩溃转储、不出现在 argv。
- 配对二维码含 psk，渲染后不落盘；提供「重新生成/隐藏」。

