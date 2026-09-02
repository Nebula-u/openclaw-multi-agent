# Manager Control Semantic Arguments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Manager-facing JSON command arguments with quote-safe semantic arguments that work through the Windows `.cmd` launcher.

**Architecture:** `scripts/manager-control/cli.mjs` will parse typed project and authorization fields, construct the internal objects locally, and retain existing service-layer validation. The Manager workspace will invoke only these semantic forms. Regression tests will cover parser behavior and actual Windows PowerShell-to-`.cmd` invocation.

**Tech Stack:** Node.js 22 ESM, `node:test`, PowerShell 7 on Windows, OpenClaw runtime bundle installer.

## Global Constraints

- Do not change model maximum-output-token settings or thinking configuration.
- Do not add a maximum number of failed attempts.
- Keep `manager-control.cmd` as the only Manager allowlisted executable.
- Do not accept JSON files, encoded payloads, or arbitrary command text.
- Do not commit this plan or implementation changes automatically; leave them in the current workspace for user review.

---

### Task 1: Define and test the semantic CLI contract

**Files:**
- Modify: `tests/manager-control.test.mjs`
- Modify: `scripts/manager-control/cli.mjs`

**Interfaces:**
- Consumes: `run(argv, output, { runtimeRoot })`
- Produces: `ensure` accepts `--workflow-id`, `--project-name`, `--project-mode`, and optional `--remote-url`; `orchestrator-approve` accepts `--authorization-summary`.

- [x] **Step 1: Write failing tests for semantic project registration and approval**

Replace the direct CLI invocations in the semantic-action test with:

```js
runManagerControl([
  'ensure', '--workflow-id', 'WF-CLI-001',
  '--project-name', 'cli demo', '--project-mode', 'new',
], output, { runtimeRoot });
```

and replace approval JSON with:

```js
'--authorization-summary', 'User explicitly approved requirements'
```

Add assertions that an invalid `new` plus `--remote-url`, a `remote` request without `--remote-url`, and a blank authorization summary throw `MANAGER_CONTROL_USAGE`.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/manager-control.test.mjs`

Expected: semantic options are rejected because the existing grammar only permits JSON parameters.

- [x] **Step 3: Implement the minimum semantic parser and object construction**

In `cli.mjs`, replace `project-json` with `project-name`, `project-mode`, and `remote-url` in the `ensure` allowlist. Replace `authorization-json` with `authorization-summary` in the approval allowlist. Add helpers that build `{ mode, name, remote_url? }` and `{ confirmed: true, actor: 'human:manager', message: summary }`; reject the invalid combinations above before calling the service layer.

- [x] **Step 4: Run the focused test and verify it passes**

Run: `node --test tests/manager-control.test.mjs`

Expected: all Manager-control tests pass.

### Task 2: Cover the deployed Windows wrapper

**Files:**
- Modify: `tests/manager-control.test.mjs`
- Read: `scripts/manager-control/manager-control.cmd`

**Interfaces:**
- Consumes: `manager-control.cmd ensure --workflow-id ... --project-name ... --project-mode new`
- Produces: one JSON response with a `projectRef` matching `PRJ-...`.

- [x] **Step 1: Write a Windows-only failing integration test**

Add a test guarded by `process.platform === 'win32'`. Copy `scripts/manager-control` into a temporary runtime root, invoke `manager-control.cmd` via `pwsh -NoProfile -Command` with a multi-word `--project-name`, parse stdout as JSON, and assert its `projectRef` matches `/^PRJ-/u`. Skip outside Windows.

- [x] **Step 2: Run the focused test and verify the wrapper regression test executes on Windows**

Run: `node --test tests/manager-control.test.mjs`

Expected on Windows: the integration test passes; elsewhere: it is reported as skipped.

- [x] **Step 3: Adjust only test setup needed for the deployed launcher**

If the copied launcher cannot locate its peer modules, copy the entire `scripts/manager-control` directory to the temporary runtime root. Do not alter the `.cmd` wrapper.

- [x] **Step 4: Re-run the focused test**

Run: `node --test tests/manager-control.test.mjs`

Expected: no failures.

### Task 3: Update Manager instructions and validate the deployable bundle

**Files:**
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `README.md` if it documents Manager-control parameters
- Test: `tests/runtime-bundle.test.mjs`
- Test: `tests/validate-install.test.mjs`

**Interfaces:**
- Consumes: the semantic CLI contract from Task 1.
- Produces: installed Manager workspace only instructs semantic arguments; runtime bundle includes the corrected launcher and instructions.

- [x] **Step 1: Write failing instruction assertions**

Add or extend a repository test that reads the Manager workspace instructions and asserts they mention `--project-name` and `--authorization-summary`, while they do not instruct use of `--project-json` or `--authorization-json`.

- [x] **Step 2: Run the relevant test and verify it fails**

Run: `node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`

Expected: failure because the old instruction text remains.

- [x] **Step 3: Update Manager instructions and documentation**

Replace JSON-parameter guidance with the semantic forms. Describe only the entrypoint and its semantic action; do not add shell, Node, or workaround instructions. Update README only if it names the old parameters.

- [x] **Step 4: Run focused validation**

Run: `node --test tests/manager-control.test.mjs tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`

Expected: all focused tests pass.

### Task 4: Repository verification

**Files:**
- Verify: all files from Tasks 1–3

- [x] **Step 1: Run the full test suite**

Run: `npm test`

Expected: exit code 0.

- [x] **Step 2: Review the complete diff**

Run: `git diff --check` and `git diff -- scripts/manager-control/cli.mjs tests/manager-control.test.mjs agents/manager-agent/workspace/AGENTS.md agents/manager-agent/workspace/TOOLS.md README.md`

Expected: no whitespace errors; no model-output or thinking setting changes; no change that expands the Manager allowlist.

- [x] **Step 3: Leave the changes uncommitted**

Do not create a commit. Report the files changed and the exact Agent update command required to deploy the runtime and workspace changes.
