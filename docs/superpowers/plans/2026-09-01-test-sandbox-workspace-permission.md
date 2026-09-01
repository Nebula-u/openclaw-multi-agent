# TEST Sandbox Workspace Traversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hardened Docker TEST staging work when the installed test-agent workspace begins with host mode `0700`.

**Architecture:** Before staging cleanup and creation, normalize only the workspace directory to add other-user read/execute permission. The Docker container retains no write permission at `/workspace`; its writable boundary remains the existing staged repo, output, and raw-log directories.

**Tech Stack:** Node.js 22, `node:test`, Docker integration tests, POSIX mode bits.

## Global Constraints

- Preserve the Docker sandbox image, non-root user, network isolation, read-only root filesystem, capability drop, and resource limits.
- Preserve workspace owner/group and never add workspace-root write permission for the container user.
- A restrictive `0700` workspace must become `0705`; a workspace that already permits traversal must not lose permissions.
- A mode-normalization failure must fail closed and must not dispatch a local TEST fallback.
- The regression test must exercise the configured Docker image without `--user`, so it uses the image's real default user.

---

### Task 1: Reproduce the production permission boundary

**Files:**

- Modify: `tests/orchestrator-test-sandbox-staging.test.mjs`

**Interfaces:**

- Consumes: `createTestSandboxStager({ workspaceRoot, inspectSandbox, platform })`.
- Produces: a Docker integration regression that demonstrates a staged `0700` workspace is reachable by the configured image user.

- [x] **Step 1: Write the failing test**

Add a Linux/Docker-gated test that creates the existing fixture, changes `value.workspace` to `0o700`, prepares staging, and runs:

```js
docker run --rm --network none --read-only --cap-drop ALL \
  --volume <workspace>:/workspace openclaw-test-node:22-slim \
  bash -lc 'test -r /workspace/.task-sandbox/input/task.json && test -w /workspace/.task-sandbox/repo && test -w /workspace/.task-sandbox/output && test -w /workspace/.task-sandbox/raw-logs'
```

Assert exit status `0`, then call `sandbox.cleanup(staged)` in a `finally` block.

- [x] **Step 2: Run the new test to verify it fails**

Run:

```bash
node --test --test-name-pattern='restrictive host workspace' tests/orchestrator-test-sandbox-staging.test.mjs
```

Expected: the new test fails because the image default user cannot traverse `/workspace` with mode `0700`.

### Task 2: Normalize only the traversal permission needed by the TEST container

**Files:**

- Modify: `scripts/orchestrator/test-sandbox-staging.mjs`

**Interfaces:**

- Consumes: the stager's resolved `paths.workspaceRoot`.
- Produces: `ensureContainerWorkspaceTraversal(workspaceRoot)` which preserves the current permission bits and adds only `0o005` if missing.

- [x] **Step 1: Write minimal implementation**

Add a helper next to the existing mode helpers:

```js
function ensureContainerWorkspaceTraversal(workspaceRoot) {
  const mode = statSync(workspaceRoot).mode & 0o777;
  const requiredMode = mode | 0o005;
  if (requiredMode !== mode) chmodSync(workspaceRoot, requiredMode);
}
```

Call it immediately after sandbox configuration is verified and before `cleanRoot(cleanupImage)`. Do not catch its errors; preparation must remain fail-closed.

- [x] **Step 2: Run the new test to verify it passes**

Run:

```bash
node --test --test-name-pattern='restrictive host workspace' tests/orchestrator-test-sandbox-staging.test.mjs
```

Expected: pass; the container can read immutable staged input and write only to staged writable directories.

### Task 3: Verify the focused regression suite and review scope

**Files:**

- Modify: `scripts/orchestrator/test-sandbox-staging.mjs`
- Modify: `tests/orchestrator-test-sandbox-staging.test.mjs`
- Create: `docs/superpowers/specs/2026-09-01-test-sandbox-workspace-permission-design.md`
- Create: `docs/superpowers/plans/2026-09-01-test-sandbox-workspace-permission.md`

- [x] **Step 1: Run the focused suite**

Run:

```bash
node --test tests/orchestrator-test-sandbox-staging.test.mjs
```

Expected: all tests pass, including the new Docker integration regression.

- [x] **Step 2: Review the patch boundary**

Run:

```bash
git diff --check HEAD~1..HEAD
git status --short
```

Expected: no whitespace errors; only the stager, its regression test, and the two implementation records change.

- [ ] **Step 3: Commit the implementation**

```bash
git add scripts/orchestrator/test-sandbox-staging.mjs tests/orchestrator-test-sandbox-staging.test.mjs docs/superpowers/plans/2026-09-01-test-sandbox-workspace-permission.md
git commit -m 'fix: allow TEST sandbox workspace traversal'
```
