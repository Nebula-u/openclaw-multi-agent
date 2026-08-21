# Context Manifest 与规则传递

Orchestrator 为每个 task/attempt 生成不可变 `context-manifest.json`。它是本轮输入清单，不是 workflow 状态或事件日志。

## 内容

- workflow/task/run/Agent/attempt；
- target repository、worktree、artifact root；
- input commit 与 route hash；
- Agent 角色规则和共享规则副本；
- 原始用户请求及其他任务输入的路径和 SHA-256；
- 期望的 raw output 路径。

manifest SHA 写入任务消息，Agent result 必须原样返回。输入必须是普通非 symlink 文件，并位于宿主允许的目录。Agent 只能写授权 worktree 和 `.agent-raw`/日志路径，不能修改 manifest、规则副本或最终 output。

## 状态与 Session

当前 workflow 事实位于 SQLite，不从 manifest 或 Session 回放。OpenClaw Session 保存聊天历史；snapshot 将 Session 与真实 Git 修改关联。HR 使用这两个定位生成每 Session 的最小 dossier，但不会把用户全文、工具输入输出或 manifest 中的完整上下文再交给 HR。

manifest 或输入 SHA 不匹配时，结果接收失败并保留 failure receipt/recovery snapshot。下一 attempt 重新生成清单，不覆盖之前的 artifact。
