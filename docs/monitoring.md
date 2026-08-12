# Supervisor Core 与只读 Monitor

Supervisor 是本机 Node.js 服务：Control DB 提供 workflow/task 状态，session tailer 只读取已登记 dispatch 的 OpenClaw session，artifact watcher 观察本地已发布产物，health classifier 计算健康状态。三者均是本地代码；Agent 和网页用户都不写 telemetry 或控制状态。

启动：

```powershell
npm run supervisor:check
npm run supervisor:start
```

静态页 `monitor/ui/index.html` 保留 workflow 阶段、task 状态、负责 Agent 与健康状态，并增加持久会话控制台：左侧列出 package 清单和 session 根目录中发现的全部 Agent（包括未激活和已结束），右侧选择 session 后显示最多 500 条完整 user/assistant 文本。session 元数据可显示状态、模型和 token 统计；正文不会展示 thinking、推理块、工具调用、工具结果、命令、prompt、凭据或 artifact 绝对路径，也没有催办、暂停、重试、消息或取消控件。

公开 API 全为只读：

- `GET /api/health`
- `GET /api/client-config`
- `GET /api/workflows`
- `GET /api/workflows/:workflowId/snapshot`
- `GET /api/workflows/:workflowId/stream?after=<seq>`
- `GET /api/tasks/:taskId`
- `GET /api/agents`（全部已创建 Agent，包括未激活和已结束）
- `GET /api/agents/:agentId/sessions`（持久 session 索引）
- `GET /api/agents/:agentId/sessions/:sessionId/messages`（仅 user/assistant 安全文本）

服务仅接受 loopback 和允许的 Origin。Monitor telemetry 数据库可删除后由本地采集器重建，不能用于恢复或修改 `control.db`；Agent/session 对话直接读取 OpenClaw 持久 session 文件，因此即使没有 workflow dispatch 归属，已创建 Agent 及其历史 session 仍能显示。
