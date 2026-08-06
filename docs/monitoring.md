# Supervisor Core 与 Monitor API

## 当前能力

Supervisor Core 是宿主机原生 Node.js 服务。它读取 `control.db` 权威状态，通过只读 snapshot
提供 workflow/task/dispatch 数据，并通过 SSE 推送增量。人工监督请求经过 token 校验后调用
Control Kernel supervision repository，不能直接修改 workflow/task 状态。

启动前检查：

```powershell
npm run supervisor:check
```

启动：

```powershell
$env:MONITOR_TOKEN = '<local-random-token>'
npm run supervisor:start
```

启动后直接双击打开 `monitor/ui/index.html`，填写 Supervisor 启动时输出的本地 token，然后点击
“连接”。页面本身不需要 `npm install`、构建命令或静态文件服务器。

默认地址为 `http://127.0.0.1:4310`。也可以通过 `MONITOR_PORT`、`MONITOR_HOST`、
`OPENCLAW_RUNTIME_ROOT` 或 `MONITOR_CONFIG_PATH` 覆盖；示例配置见
`config/monitoring.example.json`。

## API

- `GET /api/health`
- `GET /api/workflows`
- `GET /api/workflows/:workflowId/snapshot`
- `GET /api/workflows/:workflowId/events?after=<seq>&limit=<n>`
- `GET /api/workflows/:workflowId/stream?after=<seq>&token=<token>`
- `GET /api/tasks/:taskId`
- `GET /api/tasks/:taskId/activity`
- `GET /api/agents/:agentId/activity`
- `GET /api/supervision?status=<status>`
- `POST /api/activity`
- `POST /api/supervision/request`

SSE 先发送当前 snapshot，再回放保留窗口内的增量事件。客户端可以使用 `Last-Event-ID` 或
`after` 恢复。服务每两秒重新读取控制快照，文件通知不是正确性的必要条件。

## 安全边界

- 服务只接受 loopback 连接。
- 默认只允许静态 HTML 的 `Origin: null`。
- SSE 和所有写请求必须携带本地 token。
- 未知 Origin、非 loopback 来源和超限 body 失败关闭。
- 服务不读取 thinking，不向浏览器发送完整 prompt 或原始 session。

## Activity 与兜底采集

Agent 在环境提供 `MONITOR_URL` 和 `MONITOR_TOKEN` 时，可以把符合
`contracts/agent-activity.schema.json` 的文件发送到：

```powershell
node scripts/monitor-core/emit-activity.mjs --file <activity.json>
```

显式 activity 是高置信度主信号。Supervisor Core 同时增量尾读与当前 dispatch 绑定的
OpenClaw 主 session JSONL，并观察 task 声明的结构化输出；它们只生成中等置信度兜底事件。
Tailer 跳过 trajectory、thinking 和半行，按 byte offset 持久化 cursor；Artifact Watcher 默认
只发送文件类型、大小、mtime 和哈希等元数据。

所有活动在写入 `runtime/monitor/monitor.db` 前执行递归脱敏和长度限制。该数据库可以删除后
重建，不能用于修复 `control.db`。

## Dashboard

静态看板提供：

- Control Kernel、同步时间和 workflow/Agent/等待/监督总览。
- 13 阶段 phase rail。
- task、dispatch、session、attempt 卡片。
- Agent relay 视图。
- SSE live feed 和断线恢复。
- task activity 详情。
- 受 token 保护的人工 NUDGE 请求。

token 只保存在当前浏览器 sessionStorage；API 地址保存在 localStorage。页面关闭不会停止
Supervisor Core 或 Watchdog。

## 健康状态与 Watchdog shadow

Health Classifier 综合 task、dispatch、lease、显式 activity、session 和 artifact 事件，输出：

`NOT_STARTED`、`STARTING`、`RUNNING`、`WAITING_CHILD`、`WAITING_HUMAN`、`BLOCKED`、
`STALE`、`POSSIBLY_STALLED`、`COMPLETED`、`FAILED`、`LOST`、`UNKNOWN`。

默认阈值在 `config/monitoring.example.json` 中。`lease_deadline` 过期只作为核查证据，不直接
判定 LOST。未完成的 `TOOL_STARTED` 在工具宽限时间内保持 RUNNING，WAITING/BLOCKED 不触发
普通催办。

Watchdog 默认启用 shadow mode：同一 task/run/冷却窗口只写一个 `watchdog.shadow_action`
遥测事件，展示如果启用会创建的 NUDGE 请求，但不写 supervision request、不唤醒 manager。
