# Monitor

Monitor is a Node.js loopback operations console. It observes PostgreSQL Control Kernel projections and redacted OpenClaw session JSONL files. It does not own workflow state and does not offer user-facing control actions.

## Start

```powershell
npm run monitor:start
pwsh -NoProfile -File scripts/start-monitor.ps1 -Port 4319
```

```bash
OPENCLAW_PROJECT_ROOT=/absolute/project/path \
OPENCLAW_RUNTIME_ROOT=/absolute/project/path/runtime \
MONITOR_PORT=4319 \
bash scripts/start-monitor.sh
```

Open `http://127.0.0.1:4319/` or `http://localhost:4319/`.

## Sources

| Source | Purpose | Write authority |
| --- | --- | --- |
| PostgreSQL Kernel | workflows, tasks, executions, approvals, notifications, events, HR jobs | Orchestrator / Kernel only |
| OpenClaw session JSONL | redacted user-visible Manager, Worker, and HR conversation text | OpenClaw only |
| SQLite telemetry | session cursor, redacted activity cache, health snapshots | Monitor local cache only |

When PostgreSQL cannot be read, Monitor continues serving its last read-only snapshot and reports `DEGRADED`. It never substitutes a checkpoint projection or mutates data to repair it.

## Endpoints

- `GET /api/health`
- `GET /api/workflows`
- `GET /api/workflows/:id/snapshot`
- `GET /api/workflows/stream` (SSE)
- `GET /api/agents`
- `GET /api/agents/:id/sessions`
- `GET /api/agents/:id/sessions/:session/messages`
- `GET /api/hr/alerts`, `GET /api/hr/jobs`, `GET /api/hr/outputs`
- `GET /api/notifications`

All normal `POST` requests return `403 MONITOR_READ_ONLY`. The optional internal `POST /internal/notifications/retry` accepts only loopback traffic, an explicitly configured internal token, and an optional list of existing notification IDs. It delegates only outbox delivery retry to the Orchestrator; it cannot create or modify workflow state.

## Session And HR Safety

The session parser retains visible `user` and `assistant` text only. It excludes system messages, thinking, tool calls, tool results, and secret-bearing content, then runs shared redaction. HR gets the same redacted assistant text, and HR's own output is exempt from further keyword review. Keyword alerts are immediate local rules; HR reviews and task daily reports are asynchronous, informational jobs.

## UI

The UI shows workflow state and tasks, one selectable live Agent session at a time, Manager delivery and approval status, HR keyword alerts, HR review text, and task daily reports. With no selected workflow, only sessions unbound to a Kernel workflow are shown and marked `UNBOUND`. A single SSE connection supplies snapshot and activity updates, with browser reconnection handled by `EventSource`.
