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
- `GET /api/supervision?status=<status>`
- `POST /api/supervision/request`

SSE 先发送当前 snapshot，再回放保留窗口内的增量事件。客户端可以使用 `Last-Event-ID` 或
`after` 恢复。服务每两秒重新读取控制快照，文件通知不是正确性的必要条件。

## 安全边界

- 服务只接受 loopback 连接。
- 默认只允许静态 HTML 的 `Origin: null`。
- SSE 和所有写请求必须携带本地 token。
- 未知 Origin、非 loopback 来源和超限 body 失败关闭。
- 服务不读取 thinking，不向浏览器发送完整 prompt 或原始 session。

