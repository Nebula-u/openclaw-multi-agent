# Legacy Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the known LangGraph-era SQLite schema safely, identify dead Orchestrator status accurately, and remove obsolete architecture claims from active documentation.

**Architecture:** A focused Kernel migration module owns schema version detection and the single known version-1 migration. Foreground status reconciliation remains in `foreground-service.mjs`, using injected clock/liveness functions for deterministic tests. Documentation is corrected without deleting explicitly historical material.

**Tech Stack:** Node.js 22.13+ built-in `node:sqlite`, `node:test`, PowerShell/Bash installation scripts, Markdown.

## Global Constraints

- Do not delete, reset, or replace `runtime/control/kernel.db`.
- Preserve all existing Kernel facts during migration.
- Keep exactly eight authoritative Kernel fact tables.
- SQLite remains local single-machine storage; no PostgreSQL or LangGraph runtime dependency.
- Manager must not dispatch workers through native subagent tools.
- test-agent remains Docker sandboxed with `sandbox.mode=all`.
- Historical plans, superseded ADR bodies, reports, and CHANGELOG history remain historical evidence.

---

### Task 1: Version and migrate the SQLite Kernel

**Files:**
- Create: `scripts/control-kernel/migrations.mjs`
- Modify: `scripts/control-kernel/database.mjs`
- Modify: `scripts/orchestrator-cli.mjs`
- Test: `tests/control-kernel-sqlite.test.mjs`
- Test: `tests/orchestrator-cli.test.mjs`

**Interfaces:**
- Produces: `CURRENT_KERNEL_SCHEMA_VERSION`, `inspectKernelSchema(sqlite)`, and `migrateKernelSchema(sqlite)`.
- `inspectKernelSchema` returns `{ currentVersion, targetVersion, issues, migrationRequired }` without writing.
- `migrateKernelSchema` applies only known migrations transactionally and returns the same shape after migration.

- [ ] **Step 1: Write failing migration and status tests**

Add tests that create the legacy `runs` table with `langgraph_thread_id`, insert a run, open it through `openKernelDatabase`, and assert version 1, removal of the column, and preservation of the run. Extend CLI status assertions to require `schema_version: 1` and `migration_required: false`; add a legacy read-only status case that reports a migration requirement.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test --test-concurrency=1 tests/control-kernel-sqlite.test.mjs tests/orchestrator-cli.test.mjs`

Expected: FAIL because schema version/migration inspection is not implemented and the legacy insert remains blocked.

- [ ] **Step 3: Implement the minimal migration layer**

Implement exact-column inspection, known legacy detection, transactional `ALTER TABLE runs DROP COLUMN langgraph_thread_id`, canonical schema initialization, `PRAGMA user_version=1`, and fail-closed errors for version-newer-than-supported or incompatible `runs` layouts. Call it only from writable initialization. Expose read-only inspection in `kernel-status`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test --test-concurrency=1 tests/control-kernel-sqlite.test.mjs tests/orchestrator-cli.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit the migration unit**

Run: `git add scripts/control-kernel/migrations.mjs scripts/control-kernel/database.mjs scripts/orchestrator-cli.mjs tests/control-kernel-sqlite.test.mjs tests/orchestrator-cli.test.mjs && git commit -m "fix: migrate legacy sqlite kernel schema"`

### Task 2: Reconcile stale foreground Orchestrator status

**Files:**
- Modify: `scripts/orchestrator/foreground-service.mjs`
- Modify: `tests/orchestrator-request-and-route.test.mjs`
- Modify: `tests/orchestrator-cli.test.mjs`

**Interfaces:**
- `readForegroundServiceStatus(projectRoot, options?)` accepts optional `{ clock, isProcessAlive, staleAfterMs }` and returns the recorded status or a `STALE` projection.
- `requestForegroundServiceStop(projectRoot, options?)` uses the same reconciliation and rejects stale instances with `ORCHESTRATOR_NOT_RUNNING`.

- [ ] **Step 1: Write failing stale-status tests**

Create a status file with an active state, a non-existent PID, and a recent heartbeat. Assert the reader returns `STALE`, preserves `recorded_state: RUNNING`, and stop throws `ORCHESTRATOR_NOT_RUNNING`. Assert the current process with a fresh heartbeat remains `RUNNING`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test --test-concurrency=1 tests/orchestrator-request-and-route.test.mjs tests/orchestrator-cli.test.mjs`

Expected: FAIL because the reader currently returns raw JSON and stop trusts it.

- [ ] **Step 3: Implement minimal reconciliation**

Use `process.kill(pid, 0)` as the default liveness probe, treat `EPERM` as alive, and bound heartbeat age by `max(5000, poll_ms * 3)`. Return `STALE` with `stale_reason` of `PROCESS_NOT_FOUND` or `HEARTBEAT_EXPIRED`. Do not rewrite the status file from a reader.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node --test --test-concurrency=1 tests/orchestrator-request-and-route.test.mjs tests/orchestrator-cli.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit the service-status unit**

Run: `git add scripts/orchestrator/foreground-service.mjs tests/orchestrator-request-and-route.test.mjs tests/orchestrator-cli.test.mjs && git commit -m "fix: report stale orchestrator services"`

### Task 3: Correct active architecture documentation

**Files:**
- Modify: `README.md`
- Modify: `config/openclaw-config-notes.md`
- Modify: `docs/native-openclaw-integration.md`
- Modify: `docs/compatibility-report.md`
- Modify: `docs/architect/JSON处理流程.md`
- Modify: `docs/current-progress-assessment.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents distinguish the manifest-level `delegation_mode=off` intent from OpenClaw's effective `delegationMode=prefer, allowAgents=[]` compatibility representation.
- Kernel operational commands document automatic versioned migration and backup-first application.

- [ ] **Step 1: Add a documentation regression test**

Extend `tests/validate-install.test.mjs` to assert active configuration/integration documents do not claim test-agent uses `sandbox.mode=off`, Manager dispatches through `sessions_spawn`, or the JSON workflow writes PostgreSQL events.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `node --test tests/validate-install.test.mjs`

Expected: FAIL on the obsolete active documentation.

- [ ] **Step 3: Rewrite active documentation**

Describe the current request-queue/Orchestrator boundary, Docker sandbox policy, SQLite migration/version reporting, stale service status, and backup-first update procedure. Preserve fixed compatibility-probe facts as historical observations while clearly separating them from current architecture.

- [ ] **Step 4: Run documentation and installation tests**

Run: `node --test tests/validate-install.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit documentation corrections**

Run: `git add README.md CHANGELOG.md config/openclaw-config-notes.md docs/native-openclaw-integration.md docs/compatibility-report.md docs/architect/JSON处理流程.md docs/current-progress-assessment.md tests/validate-install.test.mjs docs/superpowers/specs/2026-08-22-legacy-architecture-cleanup-design.md docs/superpowers/plans/2026-08-22-legacy-architecture-cleanup.md && git commit -m "docs: align active architecture with sqlite orchestrator"`

### Task 4: Verify, migrate the live Kernel, and commit final adjustments

**Files:**
- Verify only: repository and `runtime/control/kernel.db`

**Interfaces:**
- Live Kernel ends at schema version 1 without `langgraph_thread_id`.
- No workflow facts are lost.

- [ ] **Step 1: Run the complete repository verification**

Run: `npm test`

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Run install and repository hygiene verification**

Run: `pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime`

Run: `pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime`

Run: `git diff --check`

Expected: all commands exit 0.

- [ ] **Step 3: Back up and migrate the live Kernel**

Confirm `service-status` is not live, create a timestamped sibling backup with PowerShell `Copy-Item -LiteralPath`, run `npm run kernel:schema`, and run `npm run kernel:status`.

Expected: schema version 1, migration not required, eight tables, and no `langgraph_thread_id` column.

- [ ] **Step 4: Verify live facts and repository state**

Run a read-only SQLite inspection for table counts, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, and `PRAGMA table_info(runs)`; then run `git status --short --branch`.

Expected: integrity `ok`, no foreign-key violations, preserved counts, no legacy column, and only intentional source changes before the final commit.

- [ ] **Step 5: Confirm no uncommitted source adjustments remain**

Run: `git status --short --branch`

Expected: the branch is clean; runtime databases, sibling backups, generated validation output, and unrelated user files are not staged.
