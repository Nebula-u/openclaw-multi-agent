# Task-Scoped Test Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run every TEST task in the Docker sandbox against an isolated staged task workspace rather than inaccessible host runtime paths.

**Architecture:** The Orchestrator serializes TEST staging, creates a Git clone and input/output directories below the dedicated test-agent workspace, and dispatches container paths to the Agent. The host copies staged outputs into the canonical artifact root before existing ingestion. The test-agent sandbox uses `workspaceAccess: "rw"`; a staging lock and cleanup guarantee that only one task is present in that shared workspace at a time.

**Tech Stack:** Node.js 22 ESM, Node test runner, Git CLI, OpenClaw Docker sandbox, existing installer/runtime bundle.

## Global Constraints

- TEST remains `SANDBOXED_DOCKER`, `network: none`, read-only rootfs, non-root, `CAP_DROP=ALL`, and current CPU/memory/PID limits.
- No host runtime worktree or artifact directory may be mounted into the Docker container.
- All filesystem and Git subprocess calls use absolute paths and argument arrays with `shell: false`.
- The original task `input_commit`, canonical host paths, and context-manifest SHA remain result identity values.
- Any staging preflight failure returns `BLOCKED` before test commands run.
- Test staging is globally exclusive and is cleaned on success, failure, cancellation, and JSON regeneration.

---

### Task 1: Implement task staging and cleanup

**Files:**
- Create: `scripts/orchestrator/test-sandbox-staging.mjs`
- Create: `tests/orchestrator-test-sandbox-staging.test.mjs`

**Interfaces:**
- Produces `createTestSandboxStager({ projectRoot, workspaceRoot, runGit, fs })`.
- `prepare(task)` returns `{ executionRootAbs, executionInputRootAbs, executionWorktreeAbs, executionRawOutputPath, executionRawLogsRootAbs, attestation }`.
- `collect(task, staging)` copies staged `.agent-raw/result.json.raw` and raw logs into canonical artifact paths.
- `cleanup(staging)` deletes the staged task directory and releases the exclusive lock.

- [ ] **Step 1: Write failing staging tests**

```js
test('prepare stages only one TEST task clone and immutable input', () => {
  const staging = stager.prepare(task);
  assert.equal(staging.executionWorktreeAbs, join(workspace, '.task-sandbox', 'repo'));
  assert.equal(readFileSync(join(staging.executionInputRootAbs, 'task.json'), 'utf8'), readFileSync(task.contextManifestPathAbs.replace('context-manifest.json', 'task.json'), 'utf8'));
  assert.equal(existsSync(join(workspace, '.task-sandbox', 'sibling-task')), false);
});

test('prepare rejects concurrent TEST staging', () => {
  const first = stager.prepare(task);
  assert.throws(() => stager.prepare(otherTask), (error) => error.code === 'TEST_SANDBOX_BUSY');
  stager.cleanup(first);
});
```

- [ ] **Step 2: Run the staging test and verify it fails because `test-sandbox-staging.mjs` does not exist**

Run: `node --test tests/orchestrator-test-sandbox-staging.test.mjs`

- [ ] **Step 3: Implement staging with an exclusive lock, copied attempt input, local Git clone, and host attestation**

```js
export function createTestSandboxStager({ workspaceRoot, runGit = defaultGit }) {
  const root = join(resolve(workspaceRoot), '.task-sandbox');
  return {
    prepare(task) { /* acquire root/.lock, reset root/task, copy inputRootForAttempt(task), clone task.worktreePathAbs into root/repo */ },
    collect(task, staging) { /* copy staged output and logs to task.artifactRootAbs */ },
    cleanup(staging) { /* remove root/task and lock in finally-safe order */ },
  };
}
```

- [ ] **Step 4: Run the staging tests and verify they pass**

Run: `node --test tests/orchestrator-test-sandbox-staging.test.mjs`

- [ ] **Step 5: Commit the staging component**

```bash
git add scripts/orchestrator/test-sandbox-staging.mjs tests/orchestrator-test-sandbox-staging.test.mjs
git commit -m "feat: stage test tasks inside sandbox workspace"
```

### Task 2: Dispatch staged paths and ingest staged outputs

**Files:**
- Modify: `scripts/orchestrator/service.mjs`
- Modify: `tests/orchestrator-context-manifest.test.mjs`
- Modify: `tests/orchestrator-result-status.test.mjs`

**Interfaces:**
- `taskMessage(task)` uses `execution_worktree_path_abs`, `execution_context_manifest_path_abs`, and `execution_raw_output_path_abs` only when `task.testSandbox` exists.
- `createOrchestrator` accepts optional `testSandboxStager`; production defaults to the stager for `task.kind === 'TEST'`.

- [ ] **Step 1: Write failing service tests for a TEST task**

```js
assert.match(message, /execution_worktree_path_abs: .*\.task-sandbox\/repo/u);
assert.match(message, /Write exactly one result\.schema\.json object only to:[\s\S]*\.task-sandbox\/output\/result\.json\.raw/u);
assert.equal(readFileSync(canonicalRawOutput, 'utf8'), stagedResult);
```

- [ ] **Step 2: Run the focused Orchestrator tests and verify the staged-path assertions fail**

Run: `node --test tests/orchestrator-context-manifest.test.mjs tests/orchestrator-result-status.test.mjs`

- [ ] **Step 3: Prepare before dispatch, dispatch container paths, collect before ingestion, and cleanup in `finally`**

```js
const staging = task.kind === 'TEST' ? testSandboxStager.prepare(task) : null;
try {
  const dispatchedTask = staging ? { ...task, testSandbox: staging } : task;
  const result = await runner({ agentId: task.agentId, sessionId, messagePath, timeoutSeconds, signal });
  if (staging) testSandboxStager.collect(task, staging);
  return ingestTaskOutput({ projectRoot, task, occurredAt: now(clock) });
} finally { if (staging) testSandboxStager.cleanup(staging); }
```

- [ ] **Step 4: Preserve original host identity fields for blocked TEST output**

Change output-boundary validation so `BLOCKED` output still requires `value.input_commit === task.inputCommit`; update test-agent instructions to copy that supplied value rather than emit `UNKNOWN`.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/orchestrator-context-manifest.test.mjs tests/orchestrator-result-status.test.mjs tests/orchestrator-test-sandbox-staging.test.mjs`

```bash
git add scripts/orchestrator/service.mjs tests/orchestrator-context-manifest.test.mjs tests/orchestrator-result-status.test.mjs
git commit -m "feat: dispatch test tasks through staged sandbox paths"
```

### Task 3: Configure and document the writable staged test workspace

**Files:**
- Modify: `agents/packages/builtin/test-agent.json`
- Modify: `config/test-sandbox-policy.json`
- Modify: `agents/test-agent/workspace/AGENTS.md`
- Modify: `agents/test-agent/workspace/TOOLS.md`
- Modify: `agents/common/SECURITY_RULES.md`
- Modify: `README.md`
- Modify: `tests/validate-install.test.mjs`
- Modify: `tests/runtime-bundle.test.mjs`

**Interfaces:**
- test-agent has `workspaceAccess: "rw"`, Docker workdir `/workspace/.task-sandbox/repo`, and no external `docker.binds`.
- TEST instructions define `/workspace/.task-sandbox/{input,repo,output,raw-logs}` as the only execution paths.

- [ ] **Step 1: Write failing policy and bundle assertions**

```js
assert.equal(testAgent.sandbox_config.workspaceAccess, 'rw');
assert.equal(testAgent.sandbox_config.docker.workdir, '/workspace/.task-sandbox/repo');
assert.match(testTools, /\/workspace\/\.task-sandbox\/repo/u);
assert.doesNotMatch(JSON.stringify(testAgent.sandbox_config), /"binds"/u);
```

- [ ] **Step 2: Run the focused policy tests and verify failure**

Run: `node --test tests/validate-install.test.mjs tests/runtime-bundle.test.mjs`

- [ ] **Step 3: Update package, policy, and instructions without weakening Docker hardening**

- [ ] **Step 4: Document image build, Agent update, Linux Docker Engine, native Windows fail-closed behavior, and serial TEST behavior**

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/validate-install.test.mjs tests/runtime-bundle.test.mjs`

```bash
git add agents/packages/builtin/test-agent.json config/test-sandbox-policy.json agents/test-agent/workspace agents/common/SECURITY_RULES.md README.md tests/validate-install.test.mjs tests/runtime-bundle.test.mjs
git commit -m "feat: configure staged Docker test workspace"
```

### Task 4: Verify installation and Docker behavior

**Files:**
- Modify: `scripts/validate-install.sh`
- Modify: `scripts/validate-install.ps1`
- Modify: `tests/validate-install.test.mjs`

- [ ] **Step 1: Write failing validation tests for staged workspace configuration**

```js
assert.match(output, /workspaceAccess.*rw/u);
assert.match(output, /\.task-sandbox\/repo/u);
assert.doesNotMatch(output, /docker\.binds/u);
```

- [ ] **Step 2: Run validation tests and verify failure**

Run: `node --test tests/validate-install.test.mjs`

- [ ] **Step 3: Add read-only validation of the installed test-agent sandbox configuration**

- [ ] **Step 4: Run complete verification**

Run: `npm test && bash scripts/install.sh --runtime-root runtime && bash scripts/validate-install.sh --runtime-root runtime`

- [ ] **Step 5: Commit validation and documentation synchronization**

```bash
git add scripts/validate-install.sh scripts/validate-install.ps1 tests/validate-install.test.mjs README.md
git commit -m "test: verify staged test sandbox installation"
```
