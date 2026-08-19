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

启动成功会输出 `service=stategraph-monitor`、`backend=node`、监听地址和 dashboard URL。默认打开 `http://127.0.0.1:4319/`；面板、API 和 SSE 由同一个 Node 服务提供，不需要再直接打开本地 HTML 文件。

## 数据源

Monitor 采用**双源合并**：

| 源 | 内容 | 说明 |
| --- | --- | --- |
| 主源 `kernel.projectRuns()` | execution / artifact 事实 | PostgreSQL `kernel` schema，Control Kernel 唯一可信数据源 |
| 副源 `stateRuntime.list()` | workflow 决策语义（route / approval / steps） | PostgreSQL `langgraph` schema 的最新 checkpoint 投影 |

合并键为 `run.langgraph_thread_id === state.workflowId`。Monitor 仍然只读，并执行两条事件链（checkpoint 链 + `kernel.events` 链）的 audit。

telemetry 数据库继续使用独立 SQLite（`runtime/monitor/monitor.db`），只保存会话游标、脱敏活动、artifact 签名和健康分类；它不能反向推进 workflow。**telemetry 不迁 PostgreSQL 是明确的设计决定**：它是可丢弃的观测数据，且 Monitor 必须能在 PG 不可达时独立运行（见下节降级）。理由详见 [`adr/0002-dual-schema-postgres.md`](./adr/0002-dual-schema-postgres.md)。

Monitor 不加载 runtime/human capability，也不提供任何审批、派发、续跑或状态修改入口。

公开 workflow 标识为 `stategraph-checkpoint-v1`，source 为 `LANGGRAPH_CHECKPOINTS`。这两个常量标识 read model 协议而非底层存储，切换到 PostgreSQL 后**值不变**。

## 降级行为

Kernel 不可达不会让 Monitor 停止服务。分层降级如下：

| 故障 | 行为 | `/api/health` |
| --- | --- | --- |
| `kernel.projectRuns()` 不可达 | 退化为纯 checkpoint 只读投影，`execution` 为 `null`、`artifacts` 为 `[]` | `status:'DEGRADED'`，`kernel_reachable:false` |
| `kernel.lease.reapExpiredLeases()` 失败 | 记录降级原因，**不中断**本轮刷新 | `status:'DEGRADED'` |
| `stateRuntime.list()` 也抛错 | 保留上一次成功快照，API 仍响应只读请求 | `status:'DEGRADED'`，含错误 code |
| 事件链 audit 检出篡改 | API 仍可达 | `status:'DEGRADED'` |

`kernel_reachable` 有三种取值：`true`（Kernel 可达）、`false`（Kernel 配置了但读取失败）、`null`（未注入 Kernel，例如离线测试）。前端可据此区分「没有执行记录」和「读不到执行记录」。

详见 [`adr/0004-monitor-degradation.md`](./adr/0004-monitor-degradation.md)。

## 新增字段

19 个端点与 3 个 read model 的**原有字段名与语义全部冻结，只允许追加**。本次重构追加的字段：

```js
// 快照与 /api/health、/api/workflows
kernel_reachable: true | false | null

// publicWorkflow 追加
run_id                  // Kernel run_id（RUN- 前缀）
langgraph_thread_id     // LangGraph thread（WF- 前缀），与 run_id 分离
kernel_run_id           // 同 run_id，兼容早期字段
kernel_state            // Kernel 侧 run 状态
kernel_degraded         // 该 workflow 是否来自降级投影

// publicTask 追加
execution: {            // Kernel 侧最新一条 execution 事实，无则 null
  execution_id, worker_id, state,
  heartbeat_at, lease_expires_at, attempt,
}
artifacts: [{ artifact_id, kind, uri, sha256 }]   // 无则空数组
task_group_id           // 并行预留，串行下恒为 task_id
parallel_slot           // 并行预留，串行下恒为 0
```

## 租约回收

Monitor 的 `reconcileCycle()` 在每个刷新周期先调用 `kernel.lease.reapExpiredLeases()`，把 `lease_expires_at < now()` 且仍处于 `LEASED`/`RUNNING` 的 execution 标记为 `LEASE_EXPIRED`。随后 StateGraph 的 `reconcile` 节点读到该状态即产生 `EXECUTION_LEASE_EXPIRED` 失败，走正常 attempt 重试预算。

这是 Agent 进程静默死亡的兜底路径。回收失败只记降级、不阻断刷新——租约回收是可延迟的后台任务，不应拖垮实时视图。

## 查询 API

- `GET /api/health`
- `GET /api/client-config`
- `GET /api/workflows`
- `GET /api/workflows/stream`
- `GET /api/workflows/:id/snapshot`
- `GET /api/workflows/:id/stream`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/activity`
- `GET /api/tasks/:id/health`
- `GET /api/agents`
- `GET /api/agents/:id/sessions`
- `GET /api/agents/:id/sessions/:session/messages`
- `GET /api/supervisor`（固定返回 `READ_ONLY`，保留路径兼容）

`GET /`、`GET /index.html`、`GET /styles.css`、`GET /config.js` 和 `GET /app.js` 只提供仓库内固定的 Monitor 静态资源，不接受任意文件路径。

## 交互边界

Monitor 只接受 `GET` 与 SSE。人工确认、错误处理和后续路线变更全部在 Manager CLI 对话中完成，再由 Manager 写用户授权的 StateGraph 请求文件。页面只显示用户确认的 workflow 阶段和已清洗进度。

## SSE

全局 workflow stream 只在 checkpoint read model 实际变化时发送 snapshot，再按 sequence 重放保留事件。客户端可使用 `Last-Event-ID` 或 `after` 续接；前端不再定时轮询或重建 SSE。StateGraph 续跑由 Manager CLI bridge 的后台 processor 负责，不依赖 Monitor 页面或进程。

## 安全边界

- 只监听 loopback。
- 只允许配置的 Origin，以及服务自身的 loopback Origin。
- Monitor 进程和浏览器都不读取 runtime / human capability。
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
