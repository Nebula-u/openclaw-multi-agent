# Supervisor Core 与只读 Monitor

Supervisor 是本机 Node.js 服务：Control DB 提供 workflow/task 状态，session tailer 只读取已登记 dispatch 的 OpenClaw session，artifact watcher 观察本地已发布产物，health classifier 计算健康状态。三者均是本地代码；Agent 和网页用户都不写 telemetry 或控制状态。

启动：

```powershell
npm run supervisor:check
npm run supervisor:start
```

静态页 `monitor/ui/index.html` 只显示 workflow 阶段、task 状态、负责 Agent、健康状态和脱敏的 Agent 用户可见对话。不会展示 thinking、推理块、工具调用、命令、prompt、token、凭据、artifact 绝对路径或 session ID，也没有催办、暂停、重试、消息或取消控件。

公开 API 全为只读：

- `GET /api/health`
- `GET /api/client-config`
- `GET /api/workflows`
- `GET /api/workflows/:workflowId/snapshot`
- `GET /api/workflows/:workflowId/stream?after=<seq>`
- `GET /api/tasks/:taskId`
- `GET /api/tasks/:taskId/activity`（仅用户安全对话）
- `GET /api/agents`（全部已创建 Agent，包括未激活和已结束）
- `GET /api/agents/:agentId/sessions`（持久 session 索引）
- `GET /api/agents/:agentId/sessions/:sessionId/messages`（仅 user/assistant 安全文本）

服务仅接受 loopback 和允许的 Origin。Monitor 数据库可删除后由本地采集器重建，不能用于恢复或修改 `control.db`。没有 dispatch 的 OpenClaw 会话不会被归属到 workflow，因此不会出现在看板中。
