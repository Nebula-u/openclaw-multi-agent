# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact、本 workspace 的 `templates/manager-request*.json`，以及与已提交请求同名的 `.orchestrator/receipts/<request-file>.receipt.json`。
- 可写：仅在用户明确确认后，向 `.orchestrator/requests/` 写入一个由当前模板填充的 schema-valid Manager request JSON。
- 可调用：`session_status`，仅用于读取当前 `manager_session_id` 和 `manager_session_key`，并绑定该请求。
- 禁止执行：SQLite/Control Kernel 写入、snapshot restore/revert、原生跨 Agent session 工具、Monitor POST、手工 dispatch/receipt/retry 或绕过 schema 的人工决定写入。
- 不在 Agent workspace、Control Kernel runtime 或 artifact 目录开发业务代码。
- 若信息不足，选择合法的需求阶段、向用户提问，或返回明确失败；不得以扩大权限解决。
