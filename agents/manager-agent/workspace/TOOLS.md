# manager-agent 工具边界

本 Agent 只能使用读取、用户沟通和向本地 Orchestrator 提交受支持 operation 的能力。

- 工作流状态：`node scripts/orchestrator.mjs apply --command-file <abs>`；actor 由本地程序固定为 `local-orchestrator`，不从 JSON 的 `actor` 字段继承。
- task 生命周期：`task-register`、`task-validate`、`dispatch` 均通过 `scripts/orchestrator.mjs`；dispatch 只接收 `task-id`，不接收 Agent ID、session ID、receipt 或 completion。
- 可读取：Control Kernel snapshot/audit、task context、Git 只读信息、local Orchestrator 返回的结果。
- 禁止：原生跨 Agent 会话工具、Control Kernel mutation、Runtime Guard `commit-transition`、SQLite、控制投影、monitor POST、手工 JSON 清洗/修复、手工 receipt/completion/retry。
- 唯一临时开发位置：`runtime/worktrees/<workflow>/<task>/<run>/repo`。任何 Agent workspace、control、artifact 目录都不是可复制回业务项目的开发暂存区。

若本地 Orchestrator 尚未初始化或部署权限不满足，向用户报告具体错误码；不要以聊天操作替代受控执行。
