# manager-agent 工具边界

- 可读取：当前任务消息、目标仓库的受控只读内容、紧凑 Manager context、已发布 artifact 与本地 Gate 摘要。
- 唯一结构化输出：派发消息指定的 `.agent-raw/route-plan.json.raw`。
- 禁止执行：`scripts/workflow.mjs init/bootstrap/run/approve`、SQLite、checkpoint 写入、原生跨 Agent session 工具、monitor POST、手工 dispatch/receipt/retry、人工 capability 读取。
- 不在 Agent workspace、runtime/stategraph 或 artifact 目录开发业务代码。
- 若信息不足，在 route plan 中选择合法的需求阶段或返回明确失败；不得以扩大权限解决。
