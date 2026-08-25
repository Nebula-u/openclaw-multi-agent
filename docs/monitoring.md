# Monitor 运维说明

Monitor 是单机观测界面。它从 `runtime/control/kernel.db` 读取工作流事实，从 OpenClaw Session 目录读取可显示的会话文本，并把可重建的健康、活动和 SSE 游标写入 `runtime/monitor/monitor.db`。对人工审批，它只把用户选择写入本地命令队列；不直接写 Kernel。

## 启动

先初始化 Kernel，再启动 Monitor：

```text
npm run kernel:schema
npm run monitor:start
```

默认地址为 `http://127.0.0.1:4319/`。Monitor 只监听 loopback，并校验 Origin；不要直接暴露到公网。需要远程访问时，应在同机反向代理后增加身份认证和 TLS。

`config/monitoring.example.json` 中的关键路径：

```json
{
  "database_path": "./runtime/control/kernel.db",
  "monitor_database_path": "./runtime/monitor/monitor.db",
  "session_root": "%USERPROFILE%/.openclaw/agents"
}
```

`database_path` 必须是本机文件。Monitor 使用 SQLite `query_only` 连接，不能初始化或修改 Kernel；若库不存在或 schema 不完整，应先运行 Orchestrator 初始化命令。

## 数据源与接口

`/api/client-config` 和 SSE snapshot 的 source 为 `SQLITE_CONTROL_KERNEL`。主要只读接口：

- `GET /api/workflows`
- `GET /api/workflows/stream`
- `GET /api/snapshots`
- `GET /api/snapshots/:id`
- `GET /api/snapshots/:id/diff`
- `GET /api/hr/jobs`
- `GET /api/hr/outputs`
- `GET /api/agents/:agent/sessions/:session/messages`（`hr-agent` 返回 `HR_SESSION_PRIVATE`）
- `POST /api/approvals/resolve`（仅将审批选择排队）
- `GET /api/approval-commands/:commandId`（读取 Orchestrator 写入的命令 receipt）

快照 diff 来自目标 Git 仓库，即使原任务 worktree 已清理仍可读取。Monitor 的 HR 输出来自 SQLite 中已校验的结构化 findings，不读取或展示 HR 原始 Session/dossier。Monitor 不提供 restore/revert HTTP 写接口；使用 Orchestrator CLI。

## 只读边界

Monitor 不负责：

- 调度或继续 workflow；
- 自动运行 HR；
- 直接创建审批事实、代用户决定或修改 Kernel；
- restore、revert 或改写 Git；
- 修复 Kernel。

通知重试也应使用：

```text
node scripts/orchestrator-cli.mjs retry-notifications --project-root .
```

Monitor 不保留通知重试兼容写入口；除 `/api/approvals/resolve` 外，POST 请求都返回 `MONITOR_READ_ONLY`。该审批接口只接受本机页面的当前审批标识和已显示的选项，实际解析、恢复和 Manager 通知仍由 Orchestrator 完成。

## 故障与保留

- Kernel 不可读：API 保持可达并报告 `DEGRADED`，不回退到旧事件或 checkpoint。
- telemetry 损坏：停止 Monitor 后可删除 `runtime/monitor/monitor.db` 重建，不影响 workflow。
- Session 缺失：工作流和 Git 快照仍可显示；对应对话窗口或 HR dossier 会报告缺失。
- Git 仓库缺失：SQLite 快照索引仍在，但 diff/restore/revert 会失败关闭。

`activity_retention_days` 和 `telemetry_max_events` 只影响 Monitor telemetry，不删除 Kernel、Session、Git ref 或 artifact。
