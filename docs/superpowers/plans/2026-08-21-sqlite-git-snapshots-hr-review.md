# SQLite、Git 快照与 HR 审查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用单机 SQLite 替换 PostgreSQL，删除事件链/CAS，并实现宿主验证的 Git 快照回滚与手动优先的 HR Session 审查。

**Architecture:** Orchestrator 是唯一 SQLite 写者，Monitor 使用只读连接；Git object database 保存代码快照，SQLite `snapshots` 只保存索引。HR 按 Session 读取脱敏后的 thinking/reasoning、最后输出和宿主 Git diff，自动调度默认关闭。

**Tech Stack:** Node.js 22.13+、`node:sqlite`、Git worktree/refs/revert、OpenClaw CLI、Node test runner、Ajv。

## Global Constraints

- 只支持单机本地磁盘，不允许多机共享 SQLite 文件。
- Kernel 默认路径固定为 `runtime/control/kernel.db`；Monitor telemetry 保持 `runtime/monitor/monitor.db`。
- 不迁移 PostgreSQL 历史数据，初始化空 SQLite。
- 不增加 SQLite npm/native 依赖，删除 `pg`。
- 删除 revision CAS、事件表、哈希链审计和 artifact CAS 副本。
- Restore 创建新分支/worktree；Revert 创建反向 commit；禁止 `reset --hard`。
- HR 只检查越权、边界不清晰、猜测/模糊结果；自动模式默认 `off`。
- 修改 Agent workspace/package 后，安装 dry-run、validate 和更新命令文档必须同步。

---

### Task 1: SQLite 连接、Schema 与配置

**Files:**
- Create: `scripts/control-kernel/database.mjs`
- Replace: `scripts/control-kernel/schema.sql`
- Modify: `scripts/control-kernel/apply-schema.mjs`
- Delete: `scripts/control-kernel/pool.mjs`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/control-kernel-schema.test.mjs`
- Test: `tests/helpers/kernel-fixture.mjs`

**Interfaces:**
- Produces: `resolveKernelConfig({ projectRoot?, databasePath? }) -> { databasePath, workerId, leaseSeconds, busyTimeoutMs }`
- Produces: `openKernelDatabase({ databasePath, readonly? }) -> KernelDatabase`
- `KernelDatabase` exposes `exec(sql)`, `run(sql, params)`, `get(sql, params)`, `all(sql, params)`, `transaction(fn)`, `close()`.

- [ ] **Step 1: Rewrite schema tests for an isolated SQLite file**

```js
test('initializes all eight authoritative tables and WAL pragmas', () => {
  const fixture = createKernelFixture();
  assert.deepEqual(fixture.tableNames(), ['approvals','artifacts','executions','hr_jobs','notifications','runs','snapshots','tasks']);
  assert.equal(fixture.db.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(fixture.db.get('PRAGMA journal_mode').journal_mode, 'wal');
});
```

- [ ] **Step 2: Run the schema test and confirm it fails because the SQLite database module does not exist**

Run: `node --test tests/control-kernel-schema.test.mjs`
Expected: FAIL with module/export or PostgreSQL fixture errors.

- [ ] **Step 3: Implement the SQLite wrapper and eight-table schema**

```js
import { DatabaseSync } from 'node:sqlite';
export function openKernelDatabase({ databasePath, readonly = false, busyTimeoutMs = 5000 }) {
  const sqlite = new DatabaseSync(databasePath, { readOnly: readonly });
  if (!readonly) sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  sqlite.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeoutMs};`);
  return createStatementFacade(sqlite);
}
```

- [ ] **Step 4: Remove PostgreSQL configuration/dependency and require Node 22.13+**

```json
{
  "engines": { "node": ">=22.13.0" },
  "dependencies": { "ajv": "^8.17.1", "ajv-formats": "^3.0.1" }
}
```

- [ ] **Step 5: Run schema tests**

Run: `node --test tests/control-kernel-schema.test.mjs`
Expected: PASS with no skipped PostgreSQL suite.

- [ ] **Step 6: Commit**

```text
git add scripts/control-kernel tests/control-kernel-schema.test.mjs tests/helpers/kernel-fixture.mjs .env.example package.json package-lock.json
git commit -m "refactor: replace kernel storage with SQLite"
```

### Task 2: Repository、Lease 与事件链删除

**Files:**
- Replace: `scripts/control-kernel/repository.mjs`
- Replace: `scripts/control-kernel/workflow-repository.mjs`
- Replace: `scripts/control-kernel/lease.mjs`
- Modify: `scripts/control-kernel/kernel.mjs`
- Delete: `tests/control-kernel-events.test.mjs`
- Replace: `tests/control-kernel-repository.test.mjs`
- Replace: `tests/control-kernel-lease.test.mjs`

**Interfaces:**
- Consumes: `KernelDatabase` from Task 1.
- Produces: existing repository camelCase objects without `revision`, event methods or `sourceEventId`.
- Produces: `queueHrJob({ reviewKey, triggerMode, ... })` with unique-key deduplication.

- [ ] **Step 1: Add failing SQLite repository and lease tests**

```js
test('only one active execution lease exists per task', async () => {
  await lease.acquireLease(first);
  await assert.rejects(lease.acquireLease(second), (error) => error.code === 'LEASE_HELD');
});
test('updating a run does not require or increment revision', async () => {
  assert.equal((await repository.updateRun(run.runId, { state: 'HOLD' })).state, 'HOLD');
});
```

- [ ] **Step 2: Run repository and lease tests and confirm PostgreSQL SQL fails**

Run: `node --test tests/control-kernel-repository.test.mjs tests/control-kernel-lease.test.mjs`
Expected: FAIL on `$1`, JSONB, `ANY`, `now()` or pool usage.

- [ ] **Step 3: Rewrite repositories with SQLite statements and explicit JSON mapping**

```js
const encode = (value) => value == null ? null : JSON.stringify(value);
const decode = (value, fallback = null) => value == null ? fallback : JSON.parse(value);
db.run('UPDATE runs SET state=?, updated_at=? WHERE run_id=?', [patch.state, now(), runId]);
```

- [ ] **Step 4: Implement lease acquisition with the partial unique index**

```js
const result = db.run(`INSERT OR IGNORE INTO executions (...) VALUES (?,?,?,?,...)`, values);
if (result.changes === 0) throw Object.assign(new Error('task already has an active lease'), { code: 'LEASE_HELD', details: holder });
```

- [ ] **Step 5: Remove all event append/audit calls and tests**

Run: `rg -n "appendEvent|auditEvents|event_hash|prev_hash|RUN_CAS_CONFLICT|expectedRevision" scripts monitor tests`
Expected: no active-code matches.

- [ ] **Step 6: Run Kernel tests**

Run: `npm run test:kernel`
Expected: PASS with no skips.

- [ ] **Step 7: Commit**

```text
git add scripts/control-kernel tests/control-kernel-*.test.mjs
git commit -m "refactor: simplify SQLite kernel facts"
```

### Task 3: Git 快照验证与恢复

**Files:**
- Modify: `scripts/orchestrator/git-worktree.mjs`
- Create: `scripts/orchestrator/snapshot-service.mjs`
- Modify: `scripts/orchestrator/output-ingestion.mjs`
- Modify: `scripts/orchestrator/service.mjs`
- Modify: `scripts/control-kernel/workflow-repository.mjs`
- Modify: `contracts/result.schema.json`
- Create: `tests/orchestrator-snapshots.test.mjs`
- Modify: `tests/orchestrator-output-ingestion.test.mjs`

**Interfaces:**
- Produces: `worktrees.verifyCompletion({ inputCommit, outputCommit, worktreePathAbs })`.
- Produces: `worktrees.captureRecovery({ inputCommit, worktreePathAbs, snapshotId })`.
- Produces: `createSnapshotService({ repository, worktrees }).accept/recover/list/show/diff/restore/revert`.

- [ ] **Step 1: Add failing tests for SHA, ancestry, HEAD and dirty-state validation**

```js
assert.throws(() => manager.verifyCompletion({ inputCommit: base, outputCommit: sibling, worktreePathAbs }), { code: 'TASK_OUTPUT_COMMIT_NOT_DESCENDANT' });
assert.throws(() => manager.verifyCompletion({ inputCommit: base, outputCommit: head, worktreePathAbs: dirty }), { code: 'TASK_WORKTREE_DIRTY' });
```

- [ ] **Step 2: Add failing recovery/ref/restore tests**

```js
const snapshot = await service.recover(execution);
assert.equal(snapshot.snapshotKind, 'FAILED_RECOVERY');
assert.equal(git('show-ref', snapshot.gitRef), snapshot.outputCommit);
const restored = await service.restore(snapshot.snapshotId, target);
assert.equal(git('-C', restored.worktreePathAbs, 'rev-parse', 'HEAD'), snapshot.outputCommit);
```

- [ ] **Step 3: Run snapshot tests and confirm missing interfaces**

Run: `node --test tests/orchestrator-snapshots.test.mjs tests/orchestrator-output-ingestion.test.mjs`
Expected: FAIL with missing snapshot service/verification methods.

- [ ] **Step 4: Implement host Git validation, name-status/stat/patch and hidden refs**

```js
git(worktree, ['cat-file', '-e', `${outputCommit}^{commit}`], 'verify output commit');
git(worktree, ['merge-base', '--is-ancestor', inputCommit, outputCommit], 'verify ancestry');
git(projectRoot, ['update-ref', `refs/openclaw/snapshots/${snapshotId}`, outputCommit], 'pin snapshot');
```

- [ ] **Step 5: Capture dirty/crashed worktrees as recovery commits without advancing candidate**

```js
git(worktree, ['add', '-A'], 'stage recovery snapshot');
git(worktree, ['commit', '-m', `openclaw: recovery snapshot ${snapshotId}`], 'commit recovery snapshot');
```

- [ ] **Step 6: Implement safe restore and confirmed revert**

Restore creates `openclaw/restore/<snapshot-id>` plus an isolated worktree. Revert requires `confirm === snapshotId`; on conflict aborts the revert and returns `SNAPSHOT_REVERT_CONFLICT` without resetting user branches.

- [ ] **Step 7: Run snapshot and orchestrator tests**

Run: `npm run test:orchestrator`
Expected: PASS.

- [ ] **Step 8: Commit**

```text
git add scripts/orchestrator scripts/control-kernel/workflow-repository.mjs contracts/result.schema.json tests/orchestrator-*.test.mjs
git commit -m "feat: add verified Git snapshots and recovery"
```

### Task 4: 快照 CLI

**Files:**
- Modify: `scripts/orchestrator-cli.mjs`
- Modify: `package.json`
- Test: `tests/orchestrator-cli.test.mjs`

**Interfaces:**
- Adds commands: `snapshot-list`, `snapshot-show`, `snapshot-diff`, `snapshot-restore`, `snapshot-revert`.

- [ ] **Step 1: Add failing command parsing and confirmation tests**

```js
await assert.rejects(main(['snapshot-revert','--snapshot-id',id]), (error) => error.code === 'SNAPSHOT_REVERT_CONFIRMATION_REQUIRED');
```

- [ ] **Step 2: Implement read-only commands and mutation confirmation**

```text
node scripts/orchestrator-cli.mjs snapshot-list --project-root . --workflow-id WF-...
node scripts/orchestrator-cli.mjs snapshot-revert --project-root . --snapshot-id SNP-... --confirm SNP-...
```

- [ ] **Step 3: Run CLI tests**

Run: `node --test tests/orchestrator-cli.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```text
git add scripts/orchestrator-cli.mjs package.json tests/orchestrator-cli.test.mjs
git commit -m "feat: expose safe snapshot commands"
```

### Task 5: HR Session Dossier 与三类审查

**Files:**
- Create: `scripts/hr/session-dossier.mjs`
- Replace: `scripts/hr/service.mjs`
- Modify: `scripts/hr/keywords.mjs`
- Modify: `scripts/hr-runner.mjs`
- Modify: `scripts/orchestrator-cli.mjs`
- Replace: `tests/hr-service.test.mjs`
- Create: `tests/hr-session-dossier.test.mjs`

**Interfaces:**
- Produces: `buildSessionDossier({ sessionRoot, agentId, sessionId, snapshot, limits })`.
- Produces: `queueReview({ workflowId?, taskId?, date?, triggerMode })`.
- Adds commands: `hr-review`, `hr-run-pending`.

- [ ] **Step 1: Add failing dossier tests**

```js
assert.deepEqual(dossier.messages.map((item) => item.kind), ['THINKING','THINKING','FINAL_OUTPUT']);
assert.equal(dossier.messages.some((item) => item.text.includes('tool-secret')), false);
assert.equal(dossier.git.output_commit, snapshot.outputCommit);
```

- [ ] **Step 2: Add failing manual/automatic mode and deduplication tests**

```js
assert.equal(resolveHrAutoMode(root), 'off');
assert.equal((await service.queueReview({ taskId, triggerMode: 'MANUAL' })).length, 1);
assert.equal((await service.queueReview({ taskId, triggerMode: 'MANUAL' })).length, 0);
```

- [ ] **Step 3: Implement safe Session parsing and bounded dossier generation**

Parse only assistant `thinking`/`reasoning` blocks and the last assistant text block. Redact every value, reject path escapes, report truncation metadata, and attach snapshot name-status/stat/patch.

- [ ] **Step 4: Rewrite HR prompt for exactly three finding categories**

```text
Return JSON findings using only: UNAUTHORIZED_ACTION, UNCLEAR_BOUNDARY, SPECULATIVE_OR_VAGUE.
Do not reproduce private reasoning; cite the shortest redacted excerpt and source locator.
```

- [ ] **Step 5: Make automatic execution opt-in**

Remove unconditional `hr.runPending()` from Monitor, foreground loop, `tick` and `drain`. Gate task enqueue behind `OPENCLAW_HR_AUTO_MODE=task|both`; daily remains an explicit scheduler-callable command.

- [ ] **Step 6: Run HR tests**

Run: `npm run test:hr`
Expected: PASS.

- [ ] **Step 7: Commit**

```text
git add scripts/hr scripts/hr-runner.mjs scripts/orchestrator-cli.mjs tests/hr-*.test.mjs
git commit -m "feat: add manual session-scoped HR review"
```

### Task 6: Monitor SQLite Read Model 与快照展示

**Files:**
- Modify: `monitor/config.mjs`
- Replace: `monitor/kernel-server.mjs`
- Modify: `monitor/server.mjs`
- Modify: `monitor/ui/app.js`
- Modify: `monitor/ui/index.html`
- Modify: `monitor/ui/styles.css`
- Modify: `tests/monitor-kernel-http.test.mjs`
- Modify: `tests/monitor-http.test.mjs`
- Modify: `tests/monitor-static-dashboard.test.mjs`

**Interfaces:**
- Kernel source protocol becomes `orchestrator-sqlite-v1`.
- Adds read-only endpoints `GET /api/snapshots`, `GET /api/snapshots/:id`, `GET /api/snapshots/:id/diff`.

- [ ] **Step 1: Add failing Monitor SQLite and snapshot endpoint tests**

```js
assert.equal(clientConfig.source, 'SQLITE_CONTROL_KERNEL');
assert.equal((await get('/api/snapshots')).snapshots[0].agent_id, 'developer-agent');
```

- [ ] **Step 2: Remove event reads and background HR execution**

The snapshot materializer reads runs/tasks/executions/notifications/hr_jobs/snapshots only. Session tailing remains telemetry-only and never queues HR automatically when mode is `off`.

- [ ] **Step 3: Add compact snapshot/HR panels and CLI restore guidance**

The UI shows Agent, Session, input/output commit, change counts and HR findings. It does not perform restore/revert HTTP mutations.

- [ ] **Step 4: Run Monitor tests**

Run: `npm run test:monitor`
Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add monitor tests/monitor-*.test.mjs
git commit -m "feat: show SQLite snapshots and HR reviews"
```

### Task 7: Agent 规则、安装和配置同步

**Files:**
- Modify: `agents/common/COMMON_RULES.md`
- Modify: `agents/common/GIT_RULES.md`
- Modify: `agents/developer-agent/workspace/AGENTS.md`
- Modify: `agents/developer-agent/workspace/TOOLS.md`
- Modify: `agents/test-agent/workspace/AGENTS.md`
- Modify: `agents/test-agent/workspace/TOOLS.md`
- Modify: `agents/hr-agent/workspace/AGENTS.md`
- Modify: `agents/hr-agent/workspace/SOUL.md`
- Modify: `agents/hr-agent/workspace/TOOLS.md`
- Modify: `agents/packages/builtin/hr-agent.json`
- Modify: `config/monitoring.example.json`
- Modify: `scripts/install.ps1`
- Modify: `scripts/install.sh`
- Modify: `scripts/validate-install.ps1`
- Modify: `scripts/validate-install.sh`
- Modify: `tests/validate-install.test.mjs`
- Modify: `tests/runtime-bundle.test.mjs`

**Interfaces:**
- Installed Agent rules describe host-verified commits/snapshots and HR's read-only three-category review.

- [ ] **Step 1: Add failing static validation for removed PostgreSQL/event-chain language and new HR capability**

```js
assert.doesNotMatch(installedHrAgents, /Never.*read thinking/u);
assert.match(installedHrAgents, /UNAUTHORIZED_ACTION.*UNCLEAR_BOUNDARY.*SPECULATIVE_OR_VAGUE/su);
```

- [ ] **Step 2: Update Agent rules and package capability**

HR can consume only supplied redacted dossier data and cannot independently browse arbitrary Session roots. Developer/Test still commit normally; host performs final verification and recovery snapshots.

- [ ] **Step 3: Keep Windows/Linux install commands and validation consistent**

Run dry-run and validation using the exact supported script parameters; do not add a nonexistent reinstall command.

- [ ] **Step 4: Run installation tests**

Run: `node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add agents config scripts/install.ps1 scripts/install.sh scripts/validate-install.ps1 scripts/validate-install.sh tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
git commit -m "docs: align installed agents with snapshots and HR review"
```

### Task 8: README、架构和运维文档

**Files:**
- Replace: `README.md`
- Replace: `docs/architecture.md`
- Replace: `docs/monitoring.md`
- Replace: `docs/git-worktree-strategy.md`
- Modify: `docs/agent-contracts.md`
- Modify: `docs/manager-orchestration.md`
- Modify: `docs/human-approval.md`
- Modify: `docs/evidence-and-claims.md`
- Create: `docs/hr-review.md`
- Create: `docs/adr/0005-single-machine-sqlite.md`
- Create: `docs/adr/0006-git-snapshot-index.md`
- Modify: `docs/adr/README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** Documentation is the deployment and operator contract.

- [ ] **Step 1: Replace deployment instructions with empty-SQLite startup**

Document Node 22.13+, local disk requirement, `runtime/control/kernel.db`, no migration, backup of `kernel.db` + WAL checkpoint, and removal of Docker PostgreSQL.

- [ ] **Step 2: Document snapshot and HR commands with safety semantics**

Include exact list/show/diff/restore/revert and `hr-review`/`hr-run-pending` commands, automatic-mode values, retention, privacy and failure handling.

- [ ] **Step 3: Update architecture links and mark old ADR decisions superseded**

All active documentation must say SQLite is authoritative, Git stores code snapshots, Monitor is read-only, HR is manual by default, and events are not a fact table.

- [ ] **Step 4: Verify active docs contain no stale PostgreSQL/StateGraph/event-chain instructions**

Run: `rg -n "PostgreSQL|OPENCLAW_PG|KERNEL_SCHEMA|search_path|event hash|事件链|StateGraph" README.md docs --glob '!archive/**' --glob '!plan/**' --glob '!report/**'`
Expected: only historical/superseded decision explanations that explicitly identify their status.

- [ ] **Step 5: Commit**

```text
git add README.md docs CHANGELOG.md
git commit -m "docs: document SQLite snapshots and HR operations"
```

### Task 9: 全量验证与交付

**Files:**
- Modify only files needed to fix verification failures within this plan's scope.

**Interfaces:** Produces a verified working tree and deployment handoff.

- [ ] **Step 1: Run focused suites**

```text
npm run test:kernel
npm run test:orchestrator
npm run test:hr
npm run test:monitor
```

Expected: all PASS, no database-dependent skips.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: exit code 0.

- [ ] **Step 3: Run install dry-runs and validators**

```text
pwsh -NoProfile -File scripts/install.ps1 -RuntimeRoot runtime
bash scripts/install.sh --runtime-root runtime
pwsh -NoProfile -File scripts/validate-install.ps1 -RuntimeRoot runtime
bash scripts/validate-install.sh --runtime-root runtime
```

Expected: dry-runs/validators succeed without modifying installed Agents.

- [ ] **Step 4: Search for stale active implementation references**

Run: `rg -n "from 'pg'|OPENCLAW_PG|OPENCLAW_KERNEL_SCHEMA|appendEvent|auditEvents|event_hash|prev_hash|RUN_CAS_CONFLICT|runtime/artifacts/cas" scripts monitor agents tests README.md .env.example package.json`
Expected: no matches except explicit negative migration notes in docs.

- [ ] **Step 5: Inspect final diff and commit verification fixes**

```text
git diff --check
git status --short
git commit -m "test: verify SQLite snapshot migration"
```

