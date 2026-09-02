# Orchestrator Approval Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lightweight Monitor approval button and Manager approval-status tools while keeping the Orchestrator as the only SQLite workflow writer.

**Architecture:** Monitor queues an approval command in the runtime directory. The foreground Orchestrator consumes it before normal workflow ticks, resolves it through a common decision method, and sends the existing Manager notification. The fixed `manager-control` executable reads filtered status and writes the established Manager DECISION request.

**Tech Stack:** Node.js 22 `node:sqlite`, Ajv contracts, Node HTTP Monitor, vanilla browser JavaScript, PowerShell/Bash installers, Node test runner.

## Global Constraints

- Keep the Manager exec allowlist limited to its existing fixed `manager-control` executable.
- Monitor must not write SQLite; the Orchestrator remains the sole workflow-state writer.
- Do not add user accounts, CSRF, tokens, signed commands, a new network listener, or arbitrary command execution.
- Approval acceptance verifies pending status, workflow/run/task ownership, and an allowed option.
- The installed runtime receives required Manager-control code through the existing bundle and installers.

---

### Task 1: Durable approval command queue

**Files:**

- Create: `contracts/approval-command.schema.json`
- Create: `scripts/orchestrator/approval-command-queue.mjs`
- Test: `tests/orchestrator-approval-command.test.mjs`

**Interfaces:**

- `createApprovalCommandQueue({ projectRoot, orchestrator })` returns `enqueue(command)`, `processFile(name)`, `scan()`, `commands`, and `receipts`.
- `enqueue` atomically creates a command under `runtime/orchestrator/approval-commands/` and returns `{ command_id, status: 'QUEUED' }`.
- `scan` writes one immutable ACCEPTED or REJECTED receipt for each command.

- [ ] Write a failing test that queues `CMD-001`, scans it once, and asserts an ACCEPTED receipt; scan again and assert the same receipt is reused.
- [ ] Run `node --test tests/orchestrator-approval-command.test.mjs` and confirm it fails before implementation.
- [ ] Add the command schema and queue. Reject malformed JSON, non-regular files, and command files with a receipt; call `orchestrator.resolveApprovalCommand(command)` for valid input.
- [ ] Run `node --test tests/orchestrator-approval-command.test.mjs` and confirm it passes.
- [ ] Commit: `git add contracts/approval-command.schema.json scripts/orchestrator/approval-command-queue.mjs tests/orchestrator-approval-command.test.mjs && git commit -m "feat(orchestrator): add approval command queue"`.

### Task 2: Orchestrator decision path

**Files:**

- Modify: `scripts/orchestrator/service.mjs`
- Test: `tests/orchestrator-approval-command.test.mjs`
- Test: `tests/orchestrator-result-status.test.mjs`

**Interfaces:**

- `orchestrator.resolveApprovalCommand(command)` resolves a command supplied by the trusted local Monitor queue.
- `orchestrator.decide(request)` remains session-bound and delegates to the same internal transition after checking the Manager session.
- `tickAll()` scans queued approval commands before active workflow ticks and notification delivery.

- [ ] Write failing tests for a valid command transitioning `WAITING_HUMAN` to `ACTIVE`, generating `HUMAN_APPROVAL_RESOLVED`, and an invalid option returning `APPROVAL_OPTION_INVALID` without changing the approval.
- [ ] Run `node --test tests/orchestrator-approval-command.test.mjs tests/orchestrator-result-status.test.mjs` and confirm failure.
- [ ] Add one internal decision resolver. It must load the pending approval, check exact workflow/run/task ownership and option membership before calling `resolveApproval`, then preserve existing APPROVE, REWORK, and CANCEL behavior and notifications.
- [ ] Create the queue inside `createOrchestrator`, expose `resolveApprovalCommand`, and scan before `tickAll` reads ACTIVE runs.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit: `git add scripts/orchestrator/service.mjs tests/orchestrator-approval-command.test.mjs tests/orchestrator-result-status.test.mjs && git commit -m "feat(orchestrator): resolve approval commands"`.

### Task 3: Monitor endpoint and approval buttons

**Files:**

- Modify: `monitor/kernel-server.mjs`
- Modify: `monitor/ui/index.html`
- Modify: `monitor/ui/app.js`
- Modify: `monitor/ui/styles.css`
- Test: `tests/monitor-kernel-http.test.mjs`
- Test: `tests/monitor-static-dashboard.test.mjs`

**Interfaces:**

- `POST /api/approvals/resolve` accepts workflow/run/task/decision identifiers and `choice`; it returns `202` with a queued command id.
- `GET /api/approval-commands/:commandId` returns the command receipt after Orchestrator processing.

- [ ] Write failing HTTP tests asserting that a valid POST returns `202` and does not call a repository mutation, and that a receipt endpoint returns the queue receipt.
- [ ] Run `node --test tests/monitor-kernel-http.test.mjs tests/monitor-static-dashboard.test.mjs` and confirm failure.
- [ ] Add an enqueue-only handler using the queue's `enqueue`; use a fixed `human:monitor` actor and current timestamp. Do not open a writable Kernel database.
- [ ] Render one button per `pending_approval.request.options`, submit the exact identifiers and option id, disable buttons during submission, and poll the receipt endpoint until it is terminal.
- [ ] Re-run the Monitor tests and confirm they pass.
- [ ] Commit: `git add monitor tests/monitor-kernel-http.test.mjs tests/monitor-static-dashboard.test.mjs && git commit -m "feat(monitor): add approval controls"`.

### Task 4: Manager status/approval tools, packaging, and docs

**Files:**

- Modify: `scripts/manager-control/cli.mjs`
- Modify: `scripts/manager-control/service.mjs`
- Create: `scripts/manager-control/orchestrator-state.mjs`
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `scripts/runtime-bundle.mjs`
- Modify: `README.md`
- Modify: `docs/human-approval.md`
- Modify: `docs/manager-orchestration.md`
- Modify: `docs/monitoring.md`
- Test: `tests/manager-control.test.mjs`
- Test: `tests/orchestrator-request-and-route.test.mjs`
- Test: `tests/runtime-bundle.test.mjs`
- Test: `tests/validate-install.test.mjs`

**Interfaces:**

- `manager-control orchestrator-status` requires workflow and current Manager session binding, reads only the matching run and PENDING approval.
- `manager-control orchestrator-approve` requires the same binding and explicit authorization JSON, validates the exact current approval/option, and creates a new Manager DECISION request.

- [ ] Write failing Manager-control tests for a bound status lookup, denied mismatched session, and decision request creation using the full pending decision id.
- [ ] Run `node --test tests/manager-control.test.mjs tests/orchestrator-request-and-route.test.mjs` and confirm failure.
- [ ] Implement the read-only Kernel query in `orchestrator-state.mjs`, then add the two fixed CLI actions. Keep the allowlisted executable path unchanged.
- [ ] Update Manager instructions: query status before deciding; never reconstruct an ID; inspect the receipt and report any rejection.
- [ ] Extend the runtime bundle with the minimal read-only Kernel modules required by the installed Manager-control executable. Update docs with command behavior and standard Agent-update commands.
- [ ] Run `npm test`, `pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime`, and `bash scripts/validate-install.sh --runtime-root runtime`.
- [ ] Commit: `git add scripts/manager-control scripts/runtime-bundle.mjs agents/manager-agent/workspace README.md docs tests && git commit -m "feat(manager): add approval status tools"`.
