# Orchestrator And Control Kernel Architecture

## Authority

PostgreSQL Control Kernel is the single durable source for workflow facts. The Node Orchestrator is the only writer that interprets those facts to schedule work. OpenClaw hosts conversations and model calls; it is not a workflow database or scheduler. Monitor is read-only.

```text
Manager native conversation
  -> Manager request JSON
  -> Orchestrator
  -> PostgreSQL runs/tasks/executions/artifacts/approvals/notifications/events/hr_jobs
  -> Monitor projection and redacted session tail
```

## State

| Record | States |
| --- | --- |
| Workflow | `ACTIVE`, `WAITING_HUMAN`, `HOLD`, `TERMINAL` with terminal outcome `SUCCEEDED`, `FAILED`, or `CANCELLED` |
| Task | `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `WAITING_HUMAN`, `CANCELLED` |
| Execution | `LEASED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `LEASE_EXPIRED`, `CANCELLED` |

One active execution lease per task is enforced by PostgreSQL. Lease recovery changes execution facts; the Orchestrator decides whether a task retries or workflow enters `HOLD`.

## Route Execution

The Manager proposes a route according to actual user intent, including skipped-stage reasons and human gates. After the user explicitly confirms in the Manager session, the Orchestrator freezes that JSONB route plan on the run.

The scheduler reads exactly one current route step, creates or resumes its task, builds a context manifest and isolated worktree, invokes the assigned OpenClaw Agent, then performs fail-closed JSON ingestion. On success it advances to the next step or opens the configured human approval. On agent failure/rework it writes an event and notification, informs Manager, and applies the bounded retry policy.

Worker outputs and inter-Agent context are limited to published artifacts, the task context manifest, and Kernel facts. Workers cannot send one another messages, modify the Kernel, or change route state.

## Notifications And Approval

Every user-relevant task event is appended to the Kernel event chain and placed in the `notifications` outbox before a Manager delivery is attempted. Delivery failures remain `FAILED` or `PENDING` for retry and are visible in Monitor. The Manager relays the event in the originating native conversation, obtains any user decision, and writes the session-bound `DECISION` request.

## HR

The Monitor tailer extracts only redacted visible assistant messages. Keyword hits create an immediate Kernel event and an HR job. The HR Agent receives only redacted assistant text and supplied Kernel facts, has no workflow authority, and is not recursively reviewed. Task terminal outcomes enqueue HR daily reports. Monitor reads the HR Agent session text directly after redaction.

## Legacy Migration

No LangGraph checkpoint is read by the active runtime. `scripts/control-kernel/migrate-stategraph.mjs` identifies old non-terminal runs that lack a frozen route plan. Its dry-run is default; `--apply` places such runs in `HOLD` rather than inferring a route. Legacy intermediate task states are converted to failed task facts with a review reason before the minimal task-state constraint is applied.
