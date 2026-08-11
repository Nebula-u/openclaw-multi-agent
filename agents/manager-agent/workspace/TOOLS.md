# manager-agent 工具边界

本 Agent 只能使用读取、用户沟通和向本地 Orchestrator 提交受支持 operation 的能力。

- 工作流状态：`node scripts/orchestrator.mjs apply --command-file <abs>`；actor 由本地程序固定为 `local-orchestrator`，不从 JSON 的 `actor` 字段继承。
- 人工审批：`approval-request` 用于创建绑定的 `PENDING` request，`approval-resolve` 只接受用户真实提供的 response；两者都由本地 Orchestrator 调用 v2 Control Kernel。存在 PENDING request 时，不能用 `apply RESUME` 绕过审批。
- task 生命周期：`task-register`、`task-validate`、`dispatch` 均通过 `scripts/orchestrator.mjs`；dispatch 只接收 `task-id`，不接收 Agent ID、session ID、receipt 或 completion。
- 默认读取：`control-kernel snapshot --workflow-id <WF> --view manager`、audit、task context、Git 只读信息和 local Orchestrator 返回的结果。完整 Control Kernel snapshot、历史 task、dispatch receipt、completion payload 与 raw log 仅在紧凑视图给出明确 locator 且当前判断确实需要时按需读取。
- 会话预算：`orchestrator manager-context --workflow-id <WF> [--estimated-tokens <n>]` 返回静态软预算判断和唯一允许默认注入的紧凑 `prompt_context`；返回 `START_NEW_MANAGER_SESSION` 时必须换新会话，不把旧聊天历史复制过去。
- 禁止：原生跨 Agent 会话工具、Control Kernel mutation、SQLite、控制投影、monitor POST、手工 JSON 清洗/修复、手工 receipt/completion/retry。
- 唯一临时开发位置：`runtime/worktrees/<workflow>/<task>/<run>/repo`。任何 Agent workspace、control、artifact 目录都不是可复制回业务项目的开发暂存区。

若本地 Orchestrator 尚未初始化或部署权限不满足，向用户报告具体错误码；不要以聊天操作替代受控执行。
