# manager-agent 工具边界

本 Agent 只能使用读取、用户沟通和向本地 Orchestrator 提交受支持 operation 的能力。

- 工作流状态：`node scripts/orchestrator.mjs apply --command-file <abs>`；actor 由本地程序固定为 `local-orchestrator`，不从 JSON 的 `actor` 字段继承。
- 人工审批：`approval-request` 用于创建绑定的 `PENDING` request，`approval-resolve` 只接受用户真实提供的 response；两者都由本地 Orchestrator 调用 v2 Control Kernel。存在 PENDING request 时，不能用 `apply RESUME` 绕过审批。
- task 生命周期：`task-register`、`task-validate`、`task-retry`、`dispatch`、`dispatch-reconcile` 均通过 `scripts/orchestrator.mjs`；`task-retry` 对 FAILED/LOST/NEEDS_REWORK 创建新 attempt、run 和路径，不能重派旧 run；dispatch 只接收 `task-id`，不接收 Agent ID、session ID、receipt 或 completion；reconcile 只接收 Orchestrator 返回的原始 `dispatch-id`。
- 默认读取：`control-kernel snapshot --workflow-id <WF> --view manager`、audit、task context、Git 只读信息和 local Orchestrator 返回的结果。完整 Control Kernel snapshot、历史 task、dispatch receipt、completion payload 与 raw log 仅在紧凑视图给出明确 locator 且当前判断确实需要时按需读取。
- 会话预算：`orchestrator manager-context --workflow-id <WF> [--estimated-tokens <n>]` 返回静态软预算判断和唯一允许默认注入的紧凑 `prompt_context`；返回 `START_NEW_MANAGER_SESSION` 时必须换新会话，不把旧聊天历史复制过去。
- 禁止：原生跨 Agent 会话工具、Control Kernel mutation、SQLite、控制投影、monitor POST、手工 JSON 清洗/修复、手工 receipt/completion/retry。
- `dispatch` 返回 `STARTED` 后立即停止当前轮次；不等待、不使用 sleep/轮询、不直接执行 `openclaw.cmd`。人工批准的恢复只通过 `dispatch-reconcile`；若返回 `RECOVERY_REQUIRED`，不得把 session 文本或残留 artifact 当作 completion，必须报告并重新建立受控 run，不得跳过后续 Agent、Gate 或 Release 阶段。
- Supervisor Core 会在 durable `process-result.json` 出现后自动 reconcile 并推进确定性 Graph turn；Manager 只在 `NEEDS_TASK`、`HOLD` 或 `FAILED` 的幂等 supervision request 到达时继续工作，不自行周期轮询。
- 唯一临时开发位置：`runtime/worktrees/<workflow>/<task>/<run>/repo`。任何 Agent workspace、control、artifact 目录都不是可复制回业务项目的开发暂存区。

若本地 Orchestrator 尚未初始化或部署权限不满足，向用户报告具体错误码；不要以聊天操作替代受控执行。
