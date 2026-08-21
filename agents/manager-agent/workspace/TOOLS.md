# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact 与本地 Gate 摘要。
- 唯一结构化输出：派发消息指定的 `.agent-raw/route-plan.json.raw`。
- 禁止执行：SQLite/Control Kernel 写入、snapshot restore/revert、原生跨 Agent session 工具、Monitor POST、手工 dispatch/receipt/retry 或绕过 schema 的人工决定写入。
- 允许执行只读的 `node scripts/orchestrator-cli.mjs validate-request ...`，仅用于在写入 `.orchestrator/requests/` 前验证完整 Manager request；不得用它执行 `scan`、`run` 或通知重试。通知重试由 Node Orchestrator 按单条 notification ID 控制。
- 不在 Agent workspace、Control Kernel runtime 或 artifact 目录开发业务代码。
- 若信息不足，在 route plan 中选择合法的需求阶段或返回明确失败；不得以扩大权限解决。
