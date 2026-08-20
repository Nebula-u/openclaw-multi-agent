# Agent 可观测性与监督实施基线

日期：2026-08-06  
分支：`docs/monitor-plan-static-html`

## 已有控制能力

- Node.js `v24.18.0`，支持当前项目使用的内置 `node:sqlite`。
- Control Kernel v2 已有 workflow、immutable workflow event、command idempotency、task、run、
  dispatch intent/outbox/receipt、completion ingest、projection、audit 和 recover。
- 当前 `npm test` 通过：Runtime Guard 5 通过；Agent JSON 12 通过；runtime bundle
  3 通过；Control Kernel 30 通过；Monitor 26 通过；安装验证 4 通过。旧迁移测试已删除。

## OpenClaw 实测接口

版本：`OpenClaw 2026.7.1-2`。

`openclaw agent` 支持：

- `--agent <id>` 指定 Agent。
- `--session-id <id>` 和 `--session-key <key>` 定位既有 session。
- `--message` / `--message-file` 发送消息。
- `--json` 返回机器可读结果。
- `--timeout` 设置调用超时。

这可以作为 Manager Wake Adapter 的外部调用基础，但调用成功仍必须写 durable receipt；响应
不确定时先查询 session，不能直接重复发送。

`openclaw sessions` 支持按 Agent、活跃时间和数量列出 session，并提供 JSON 输出、tail 和
redacted trajectory export。当前 CLI 没有仓库内可直接调用的 `sessions_send` JavaScript API，
因此第一版适配器使用可注入 command runner 包装 CLI，测试中使用 fake adapter。

## Session 文件格式探测

实测目录：`%USERPROFILE%/.openclaw/agents/<agent-id>/sessions/`。

主 session JSONL 的已确认记录类型和字段仅记录结构，不记录内容：

| type | 顶层字段 | 相关子字段 |
|---|---|---|
| `session` | `cwd,id,timestamp,type,version` | 无 |
| `model_change` | `id,modelId,parentId,provider,timestamp,type` | 无 |
| `thinking_level_change` | `id,parentId,thinkingLevel,timestamp,type` | 无 |
| `custom` | `customType,data,id,parentId,timestamp,type` | 按 customType 处理 |
| `message` | `id,message,parentId,timestamp,type` | `role,content,timestamp`，tool result 另有 `toolCallId,toolName,isError` |

Tailer 只消费已绑定 dispatch/session 的主 `.jsonl`，跳过 `.trajectory.jsonl`、reset 备份和
thinking 内容；遇到半行时保留 cursor，等待下一轮补齐。

## 当前阻断与实施门槛

- Manager 编排的 Control Kernel、固定 `agentId`、统一派发入口和审批边界已代码化；仍需在真实 Gateway 上补充完整 workflow 演练。
- 自动监督只能先以 shadow mode 运行。
- Wake Adapter 默认关闭；只有配置显式开启、Control Kernel audit 通过并且请求已进入 durable
  outbox 时才允许调用真实 CLI。
- 受控 retry 不由 Watchdog 直接执行，只创建 `RETRY_REVIEW` 请求交给 manager。

