# Manager Control Lightweight Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the Manager to safely discover its current workflow after an abort without broadening exec permissions.

**Architecture:** Keep one installer-owned exact executable in the Manager allowlist. Generate an untracked runtime `.orchestrator/manager-control-entrypoint.json` record containing that exact path, and add one read-only `orchestrator-current-status` action that selects the latest workflow belonging to the supplied Manager session key. Existing exact workflow actions remain unchanged.

**Tech Stack:** Node.js ESM, node:sqlite, Bash, PowerShell, OpenClaw configuration, node:test.

## Global Constraints

- Keep the Manager allowlist to exactly one installer-owned `manager-control` launcher.
- Do not permit shell chains, PATH lookup, interpreters, or caller-provided runtime roots.
- `orchestrator-current-status` must use exact Manager session-key equality and be read-only.
- Do not automatically commit; the user requested work continue on the current branch.
- Update the deployed Manager instructions and document the ordinary Agent-update commands.

---

### Task 1: Add a session-key-scoped current-status action

**Files:**
- Modify: `scripts/manager-control/orchestrator-state.mjs`
- Modify: `scripts/manager-control/cli.mjs`
- Test: `tests/manager-control.test.mjs`

**Interfaces:**
- Produces: `readCurrentOrchestratorStatus({ runtimeRoot, managerSessionKey })`.
- Produces: `manager-control orchestrator-current-status --manager-session-key <key>`.

- [ ] Add failing tests for selecting the most recently updated same-key run, rejecting a different key with `WORKFLOW_NOT_FOUND`, and exposing the selected run's workflow ID, original request, and project reference.
- [ ] Run `node --test tests/manager-control.test.mjs` and confirm the new tests fail because the action and function do not exist.
- [ ] Implement `readCurrentOrchestratorStatus`: query runs by exact `manager_session_key`, ordered by `updated_at DESC, created_at DESC`, then delegate to the existing status formatter; include `original_request` and `project_ref` from the stored request only for the selected matching run.
- [ ] Implement CLI parsing and validation for the new action. It must accept only `--manager-session-key` and reject missing or extra arguments.
- [ ] Re-run `node --test tests/manager-control.test.mjs` and confirm it passes.

### Task 2: Make the deployed Manager invoke the registered entrypoint

**Files:**
- Modify: `scripts/install.sh`
- Modify: `scripts/install.ps1`
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Test: `tests/validate-install.test.mjs`

**Interfaces:**
- Produces: a runtime-only `.orchestrator/manager-control-entrypoint.json` record containing the exact path written to `manager-exec-allowlist.json`.
- Consumes: Linux `runtime/manager-control/manager-control` or Windows `runtime/manager-control/manager-control.cmd` selected by the installer.

- [ ] Add failing installer tests that verify the deployed Manager entrypoint record contains the same platform entrypoint recorded in `manager-exec-allowlist.json`.
- [ ] Run `node --test tests/validate-install.test.mjs` and confirm the new assertions fail.
- [ ] Have each installer write `.orchestrator/manager-control-entrypoint.json` only in the deployed runtime workspace using its canonical `managerEntrypoint` value.
- [ ] Update Manager protocol text: use the injected entrypoint exactly, make no chained or exploratory exec calls, call `session_status` then `orchestrator-current-status` after an abort, and use the returned workflow ID for later exact actions.
- [ ] Re-run `node --test tests/validate-install.test.mjs` and confirm it passes.

### Task 3: Verify packaging, documentation, and cross-platform invariants

**Files:**
- Modify: `README.md`
- Test: `tests/runtime-bundle.test.mjs`
- Test: `tests/manager-control.test.mjs`
- Test: `tests/validate-install.test.mjs`

**Interfaces:**
- Consumes: deployed Manager instructions and the new current-status action.
- Produces: documented abort-recovery behavior and standard Agent-update commands.

- [ ] Keep runtime-bundle source entries unchanged: the entrypoint record is deployment metadata and is intentionally excluded from the source bundle digest.
- [ ] Run `node --test tests/runtime-bundle.test.mjs` and confirm the Manager bundle remains valid.
- [ ] Document that the deployed Manager reads an installer-generated entrypoint record while source instructions contain no host path; include the normal Windows and Linux Agent-update commands and state that Gateway need not stop.
- [ ] Run `node --test tests/manager-control.test.mjs tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`, then `bash scripts/validate-install.sh --skip-openclaw --runtime-root runtime`, and fix only failures caused by this feature.
