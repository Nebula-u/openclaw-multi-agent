# openclaw-multi-agent

`openclaw-multi-agent` is a route-driven OpenClaw workflow system. The Manager confirms the user's intent in its native OpenClaw conversation, the Node Orchestrator serially dispatches only the required Agents, PostgreSQL Control Kernel records the workflow facts, and the Monitor is a local read-only operations console.

## Architecture

```text
User <-> OpenClaw Manager conversation
               |
               v
       .orchestrator/requests/*.json
               |
               v
        Node Orchestrator
      /          |          \
 schedule   Manager outbox   HR jobs
    |            |              |
    v            v              v
 OpenClaw      Manager         HR Agent
 Workers       session         session
    \            |              /
     \-----------v-------------/
       PostgreSQL Control Kernel
 runs / tasks / executions / artifacts /
 approvals / notifications / events / hr_jobs
               |
               v
 Local read-only Monitor + SSE + OpenClaw session tailer
```

| Component | Responsibility |
| --- | --- |
| OpenClaw | Hosts the Manager, six business Workers, and the background HR Agent sessions. |
| Node Orchestrator | The only scheduler. It freezes a confirmed route, creates serial tasks, runs Workers, ingests output, handles retry/approval boundaries, and queues Manager updates. |
| PostgreSQL Control Kernel | The only workflow/task/execution/approval fact source. It also persists outbox notifications, HR jobs, artifacts, and append-only hash-chained events. |
| Monitor | A loopback, observational UI. It reads the Kernel and redacted OpenClaw sessions, serves REST/SSE, and never creates, advances, approves, cancels, or reworks a workflow. |
| SQLite telemetry | Local, disposable Monitor cache for session cursors, redacted activity, health snapshots, and SSE-related telemetry. It never writes workflow facts back to PostgreSQL. |

There is no LangGraph/StateGraph runtime, checkpoint store, or webchat plugin in the active control plane.

## States

The business state model is intentionally small.

```text
Workflow: ACTIVE -> WAITING_HUMAN | HOLD | TERMINAL
TERMINAL: SUCCEEDED | FAILED | CANCELLED

Task: READY -> RUNNING -> SUCCEEDED | FAILED | WAITING_HUMAN | CANCELLED

Execution internals: LEASED | RUNNING | SUCCEEDED | FAILED | LEASE_EXPIRED | CANCELLED
```

`executions` leases are operational facts for heartbeat, timeout recovery, and single-task exclusion. They are not a second workflow state machine. During migration, a legacy intermediate task state that cannot be recovered without guessing is changed to `FAILED` and its non-terminal workflow is placed in `HOLD` for review.

## Manager And Human Approval

The Manager is the sole user-facing control point.

1. It understands the request and proposes a `route_plan` containing only needed stages, each skipped-stage reason, automatic transitions, and human review points.
2. It presents that route in the native OpenClaw conversation and waits for the user's explicit confirmation.
3. It writes a session-bound `CREATE` request only after confirmation.
4. When a task needs review, fails, requests rework, resumes, or ends, the Orchestrator first records an event and a persistent notification, then asks the Manager to explain it to the user in the originating conversation.
5. The Manager collects the user's textual decision and writes the session-bound `DECISION` request. It never decides, dispatches, or updates the database on the user's behalf.

Every Manager request requires `manager_session_id`, `manager_session_key`, and explicit `user_authorized` evidence. `CREATE` and `CHANGE` requests freeze the full route plan; `DECISION` must reference the pending approval and originating session.

## Routes And Agents

The route has no implicit “full pipeline” requirement. The Manager may use any valid ordered subset, with a documented skipped-stage reason for every omitted stage.

```text
REQUIREMENTS -> ARCHITECTURE -> DESIGN -> DEVELOPMENT -> TEST -> CODE_REVIEW -> RELEASE
```

`DEVELOPMENT` requires `TEST`; elevated risk (`security_boundary`, destructive action, external side effect, manual acceptance, or release risk) requires at least one route-level human review. The Orchestrator maps each task kind to its fixed Worker and runs one route step at a time.

| Agent | Role |
| --- | --- |
| `manager-agent` | User intent, route proposal/confirmation, approvals, and user-facing progress updates. |
| `requirement-agent` | Scope, boundaries, assumptions, and acceptance criteria. |
| `architect-agent` | Architecture or design, interfaces, risks, and test strategy. |
| `developer-agent` | Authorized implementation in an isolated Git worktree. |
| `test-agent` | Testing and factual test evidence in its authorized isolation boundary. |
| `review-agent` | Independent code review and regression findings. |
| `release-agent` | Release-readiness and rollback assessment only; never deploys. |
| `hr-agent` | Protected background reviewer. It is not in a route plan, cannot be delegated by Manager, and never contacts the user. |

## JSON And Agent Communication

Manager requests are validated against [`contracts/manager-request.schema.json`](contracts/manager-request.schema.json). The confirmed `route_plan` is stored as frozen JSONB on `runs`.

For each task, the Orchestrator creates a context manifest, task message, isolated worktree, artifact root, and one precise raw-output destination. Workers do not communicate with each other, write PostgreSQL, dispatch tasks, or modify Monitor state. They may write only under the assigned `<artifact_root>/.agent-raw/**` and return one `result.schema.json` object.

The ingestion pipeline fails closed:

```text
raw JSON / JSONL
-> BOM, fence, and unique-candidate handling
-> Ajv schema and identity validation
-> path, hash, and reference validation
-> atomic publication
-> artifact registration
-> execution/task/run update
-> Kernel event
-> Manager notification
```

Malformed JSON, multiple candidates, truncation, identity mismatch, or path escape are rejected while the raw source and a redacted failure receipt are retained. Agent-to-Agent context moves only through published artifacts, the context manifest, and Kernel facts.

## HR Review And Daily Reports

Monitor session tailing reads visible `user` and `assistant` messages from installed OpenClaw Agent JSONL sessions. System prompts, thinking, tool arguments, tool output, and secrets are excluded or redacted before any display or HR input.

For each non-HR assistant message, local rules immediately check configured uncertainty keywords such as `可能`, `我觉得`, `猜测`, `不确定`, `maybe`, `perhaps`, `I think`, and `guess`. A hit emits `HR_KEYWORD_ALERT` for Monitor display and queues an asynchronous HR review. HR has no JSON contract, cannot block workflow progress, and its original visible session output is displayed directly in Monitor after the same redaction policy.

When a task reaches a terminal business outcome, a `TASK_DAILY_REPORT` job asks HR to summarize what the business Agents did, errors or limitations, and items needing attention. The report is observational only.

## PostgreSQL Setup

Node.js 22.5+, npm, Git, OpenClaw CLI, and PostgreSQL are required for formal workflow operation. Docker is required when a task's test isolation requires it.

```bash
docker run -d --name openclaw-pg \
  -e POSTGRES_USER=openclaw -e POSTGRES_PASSWORD=password \
  -e POSTGRES_DB=openclaw -p 5432:5432 postgres:16
```

Copy `.env.example` to `.env` and set at least:

```text
OPENCLAW_PG_URL=postgresql://openclaw:password@localhost:5432/openclaw
OPENCLAW_KERNEL_SCHEMA=kernel
```

Then apply the idempotent schema and inspect the Kernel:

```powershell
npm install
npm run kernel:schema
npm run kernel:status
node scripts/control-kernel/migrate-stategraph.mjs
```

`migrate-stategraph.mjs` is dry-run by default. Use `--apply` only after reviewing the proposed `HOLD` records. It never reconstructs an old route by guesswork.

## Operating The Orchestrator

Manager requests live in the installed Manager workspace:

```text
runtime/agents/manager-agent/workspace/.orchestrator/
  requests/
  receipts/
```

Run the request processor from the project root:

```powershell
# Validate and process Manager requests, advance active serial routes, and run pending HR work.
node scripts/orchestrator-cli.mjs scan --project-root .

# Advance one active workflow, retry persistent Manager notifications, or inspect facts.
node scripts/orchestrator-cli.mjs run --project-root . --workflow-id WF-example
node scripts/orchestrator-cli.mjs retry-notifications --project-root .
node scripts/orchestrator-cli.mjs status --project-root .
```

On Linux, use the same `node` commands. The request processor and notification retry command are safe to run repeatedly; receipts and the PostgreSQL facts enforce idempotence.

## Monitor

Start the local Monitor:

```powershell
npm run monitor:start
# or
pwsh -NoProfile -File scripts/start-monitor.ps1 -Port 4319
```

```bash
OPENCLAW_PROJECT_ROOT=/absolute/project/path \
OPENCLAW_RUNTIME_ROOT=/absolute/project/path/runtime \
MONITOR_PORT=4319 \
bash scripts/start-monitor.sh
```

Open `http://127.0.0.1:4319/` or `http://localhost:4319/`. Both loopback hostnames are accepted as the local Monitor origin; other origins and ports are rejected. The Monitor shows PostgreSQL workflows/tasks, Manager delivery state, pending approvals, redacted live Agent sessions, unbound sessions, HR alerts, HR output, and task daily reports. It updates through a single SSE stream and preserves reconnection cursors locally.

All public Monitor mutation endpoints return `MONITOR_READ_ONLY`. The only internal exception is `POST /internal/notifications/retry`, which accepts a localhost-only token and retries existing persistent Manager notifications only. It cannot create, progress, approve, cancel, or rework workflow state.

Monitor API highlights:

- `GET /api/health`
- `GET /api/workflows`
- `GET /api/workflows/stream`
- `GET /api/agents`, `GET /api/agents/:id/sessions`, and `GET /api/agents/:id/sessions/:session/messages`
- `GET /api/hr/alerts`, `GET /api/hr/jobs`, and `GET /api/hr/outputs`
- `GET /api/notifications`

More detail is in [docs/monitoring.md](docs/monitoring.md).

## Install And Update Agents

The first install is a dry-run followed by Apply:

```powershell
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
pwsh -NoProfile -File scripts/validate-install.ps1
```

```bash
bash scripts/install.sh --runtime-root runtime
bash scripts/install.sh --apply --yes --runtime-root runtime
bash scripts/validate-install.sh
```

Source changes to Agent workspaces, `agents/common/`, Agent packages, runtime bundle logic, sandbox/model/tool configuration, or installation behavior require a normal installed-Agent update:

```text
Windows: pwsh -NoProfile -File scripts/install.ps1 -Apply -Yes -RuntimeRoot runtime
Linux:   bash scripts/install.sh --apply --yes --runtime-root runtime
```

Ordinary updates do not require stopping the Gateway. Only when Agent registration or managed runtime is damaged, stop the OpenClaw Gateway manually first, then use the Windows/PowerShell safe reinstall:

```text
pwsh -NoProfile -File scripts/reinstall-agents.ps1 -Apply -Yes -GatewayStopped -RuntimeRoot runtime
```

There is no separate Bash reinstall command; use PowerShell 7 on Linux for that recovery path.

## Tests

```powershell
npm test
```

```bash
npm test
```

Test groups are also available as `npm run test:orchestrator`, `npm run test:hr`, `npm run test:monitor`, and `npm run test:kernel`. Kernel tests need a reachable `OPENCLAW_PG_URL`; confirm they pass rather than skip.
