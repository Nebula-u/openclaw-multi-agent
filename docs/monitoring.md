# Node.js StateGraph Monitor

Monitor 后端为 `monitor/main.mjs`，与项目运行时使用同一 Node.js 技术栈。它不依赖 Java、Servlet 或应用服务器代理。

## 启动

```powershell
npm run monitor:start
# 或指定端口
pwsh -NoProfile -File scripts/start-monitor.ps1 -Port 4319
```

```bash
OPENCLAW_PROJECT_ROOT=/absolute/project/path \
OPENCLAW_RUNTIME_ROOT=/absolute/project/path/runtime \
MONITOR_PORT=4319 \
bash scripts/start-monitor.sh
```

启动成功会输出 `service=stategraph-monitor`、`backend=node`、监听地址和 dashboard 路径。打开 `monitor/ui/index.html`。

## 数据源

Monitor 通过 StateGraph runtime 读取最新 checkpoints，并执行事件链 audit。telemetry 数据库只保存会话游标、脱敏活动、artifact 签名和健康分类；它不能反向推进 workflow。

公开 workflow 标识为 `stategraph-checkpoint-v1`，source 为 `LANGGRAPH_CHECKPOINTS`。

## 只读 API

- `GET /api/health`
- `GET /api/client-config`
- `GET /api/workflows`
- `GET /api/workflows/:id/snapshot`
- `GET /api/workflows/:id/stream`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/activity`
- `GET /api/tasks/:id/health`
- `GET /api/agents`
- `GET /api/agents/:id/sessions`
- `GET /api/agents/:id/sessions/:session/messages`
- `GET /api/supervisor`（仅返回 Node continuation 状态，保留路径兼容）

不存在审批、重试、派发、消息发送或状态修改端点。非 GET mutation 请求返回 404。

## SSE 与自动续跑

workflow stream 先发送最新 checkpoint snapshot，再按 sequence 重放保留事件。客户端可使用 `Last-Event-ID` 或 `after` 续接。

continuation 只在 workflow 无人工阻塞且处于可推进状态时调用 runtime `run()`；它使用同一个 workflow lock 和 capability，不是第二个 scheduler 或状态源。

## 安全边界

- 只监听 loopback。
- 只允许配置的 Origin。
- 响应 `no-store` 和 `nosniff`。
- 会话内容先脱敏，排除思考、凭据、工具细节和主机控制信息。
- artifact watcher 只发布声明产物的 metadata/signature，不发布原始秘密内容。
- audit 失败时 API 仍可达，但 health 为 `DEGRADED`。

## 性能基线

自动化测试以 500 workflows、2000 tasks 构造 checkpoint read model；当前本机刷新约 0.4 秒，测试预算为 2.5 秒。该测试用于发现明显的 N² 或阻塞回归，不代表远程、多主机或生产容量承诺。

## systemd 部署

```ini
[Unit]
Description=OpenClaw StateGraph Node Monitor
After=network.target

[Service]
Type=simple
User=<linux-user>
Group=<linux-group>
WorkingDirectory=<project-root>
Environment=OPENCLAW_PROJECT_ROOT=<project-root>
Environment=OPENCLAW_RUNTIME_ROOT=<project-root>/runtime
Environment=MONITOR_PORT=4319
ExecStart=/usr/bin/env node <project-root>/monitor/main.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Monitor 端口继续绑定 `127.0.0.1`。如需远程访问，应使用组织现有的认证反向代理；仓库不内置 Java/Tomcat 代理层。

## 验证

```powershell
node --test --test-concurrency=1 tests/monitor-*.test.mjs
curl http://127.0.0.1:4319/api/health
```
