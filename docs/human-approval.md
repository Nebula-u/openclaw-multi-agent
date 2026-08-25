# 人工审批协议

审批事实由 Orchestrator 写入 SQLite `approvals`；Manager 可在原始绑定 Session 中转达问题并提交结构化 `DECISION` 请求，Monitor 也可把本机用户点击的选择写入本地审批命令队列。两条路径都由 Orchestrator 校验和写入最终事实。Worker、HR 和 Monitor 页面都不能直接创建“已批准”事实。

## 触发

- 冻结路线要求的阶段后审批；
- Agent 返回 `HUMAN_DECISION_REQUIRED`；
- 重试耗尽或其他需要用户选择的失败。

创建 approval 时，run 与 task 会持久化为 `WAITING_HUMAN`，并在通知 outbox 中记录需由 Manager 转达的内容。后续 tick 不得绕过该状态。

## 绑定与选择

决定必须绑定当前 workflow、`decision_id` 和允许的 choice。Manager 决定还必须绑定原始 Manager Session；Monitor 命令必须精确匹配当前的 workflow/run/task。过期、重复、跨 workflow、Session 不匹配或不存在的选项会被拒绝。

常见 choice：

- `APPROVE`：接受当前已验证结果并继续；
- `REWORK`/`REVISE`：同一角色开始新 attempt；
- `CANCEL`/`ABORT`/`REJECTED`：终止或取消。

用户沉默、Manager 推荐、Agent 自报、HR finding 或 Monitor 页面状态均不构成批准。审批不会把未验证代码变成 accepted snapshot；非完成现场仍只是 recovery snapshot。
