# 交互流程

> Puppetry 协议规范章节（原 `puppetry-framework.md` 拆分）。目录与阅读约定见 [README.md](./README.md)。章节号沿用原文档，便于交叉引用。

## 各交互流程索引

Puppetry 的主要交互流程分布在多个章节中，此处汇总索引，正文以各自章节为准：

| 流程 | 定义章节 | 文档 |
| --- | --- | --- |
| 设备注册（Proof of Possession） | §4.2 | [identity-pairing.md](./identity-pairing.md) |
| 扫码 / 短码 / 手工导入配对 | §4.3 | [identity-pairing.md](./identity-pairing.md) |
| 撤销与密钥轮换 | §4.5 | [identity-pairing.md](./identity-pairing.md) |
| 心跳与指令生命周期 | §6.4–6.6 | [message-format.md](./message-format.md) |
| 隧道建立、断线与恢复 | §7.1、§7.6 | [message-format.md](./message-format.md) |
| 端到端完整示例 | 附录 B（本文） | — |

## 附录 B：一次完整交互示例

```
1. Agent 心跳（30s 周期）
   POST /v1/agent/hb  → 200 {next_hb_ms:30000, commands:[]}

2. Controller 发 prompt
   POST /v1/agents/ag_x/commands
   {command_id:"cmd_01", binding_id:"bd_01", envelope:"...", exp:...}
   ← 202 {state:"queued"}

3. Agent 下一次心跳（或长轮询）
   ← 200 {commands:[{id:"cmd_01", envelope:"...", ...}]}
   Agent: HPKE open → ctr 校验 → scope 校验 → sessionController.prompt(...)
   → POST /v1/commands/cmd_01/result {envelope:"...", state:"done"}

4. Controller 拉取
   GET /v1/commands/cmd_01 → 200 {state:"done", envelope:"..."}
   解密 → {accepted:true, turn_id:"t_9"}

5. 想看实时输出 → 申请隧道
   POST /v1/tunnels {agent_id, purpose:"session.attach"} → 201
   Controller WSS + Agent WSS → Noise IK → session.attach → assistant.delta...
```

