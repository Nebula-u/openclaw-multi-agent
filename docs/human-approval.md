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
- `RETRY_SAME_AGENT`：仅在 `TASK_RETRY_EXHAUSTED` 审批中使用；用户确认后为同一 Agent 增加一个新的三次完整任务重试批次，并使用新 attempt、Session 和 worktree；
- `REWORK`/`REVISE`：同一角色开始新 attempt；
- `CANCEL`/`ABORT`/`REJECTED`：终止或取消。

用户沉默、Manager 推荐、Agent 自报、HR finding 或 Monitor 页面状态均不构成批准。审批不会把未验证代码变成 accepted snapshot；非完成现场仍只是 recovery snapshot。

## JSON 修复与完整任务重试

结构化 result 的 JSON 解析、必填字段、类型、枚举、格式或身份字段校验失败时，Orchestrator 先在原 Session 内最多发起两次固定模板的 JSON 重生成。提示会列出确切字段错误；Agent 只返回完整 JSON，宿主从 OpenClaw JSON stdout 提取并原子写回 result。该过程复用同一 task attempt、Session、worktree 和 execution lease，不重新执行任务，也不消耗完整任务重试次数。

每份被拒绝的 raw、诊断和修复提示按 task attempt 分目录保留。两次 JSON 重生成仍失败，或失败不属于 JSON 契约问题时，才进入下一次完整任务 attempt；完整 attempt 使用新 Session 和新 worktree。

完整任务重试耗尽后，系统不再留下 `pending_approval = null` 的裸 `HOLD`，而是创建 `TASK_RETRY_EXHAUSTED` 绑定审批。用户可在 Monitor 的“确认／拒绝／其他”卡片中选择，也可在原 Manager 对话中明确授权后由 Manager 提交相同 `decision_id` 和 choice。Manager 不能直接派发 Agent 或重置次数。
