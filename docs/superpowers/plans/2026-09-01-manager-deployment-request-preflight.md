# Manager Deployment Request Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete Manager deployment request template and prevent invalid drafts from reaching the formal Orchestrator queue through bounded validation and hash-bound atomic submission.

**Architecture:** Manager writes a request under its installed `.orchestrator/drafts` directory. Manager-control invokes the repository's existing `orchestrator-cli validate-request` through a fixed non-shell process call, returns the draft hash, and revalidates plus atomically publishes the same bytes only when submission presents that hash.

**Tech Stack:** Node.js 22 ESM, Node test runner, Ajv-backed existing request validation, PowerShell and Bash installers.

## Global Constraints

- Keep `contracts/manager-request.schema.json`, `contracts/route-plan.schema.json`, and deployment route policy semantics unchanged.
- Do not duplicate schema or route-policy logic in Manager-control.
- Accept only draft basenames under the installed Manager workspace.
- Reject symbolic links, hard links, non-regular files, traversal, absolute paths, existing request targets, and existing receipt targets.
- Submission must compare `expected_sha256`, rerun authoritative validation, and publish the exact bytes it validated.
- Do not change installer command-line parameters.
- Commit after each task passes its focused tests.

---

### Task 1: Deployment template and Manager protocol

**Files:**
- Create: `templates/manager-request.deploy.json`
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `agents/manager-agent/workspace/templates/README.md`
- Test: `tests/orchestrator-request-and-route.test.mjs`

**Interfaces:**
- Consumes: existing `assertManagerRequest(projectRoot, request)` and ordinary Manager CREATE reference.
- Produces: `templates/manager-request.deploy.json` and explicit Manager instructions for draft validation and submission.

- [ ] **Step 1: Add failing deployment-reference and instruction assertions**

Add a test that fills the deployment reference with `REQ-manager-deploy-001`, `WF-manager-deploy-001`, a current session binding, `PRJ-manager-deploy-001`, and a lowercase `project_id`, then calls `assertManagerRequest(ROOT, request)` and checks two RELEASE phases and all three risk flags. Extend the workspace protocol test to require `manager-request.deploy.json`, `.orchestrator/drafts`, `orchestrator-validate-request`, and `orchestrator-submit-request`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: failure because the deployment template and new protocol text do not exist.

- [ ] **Step 3: Add the complete deployment reference and precise rules**

Create the template with exactly three deployment risk flags, `{ base_url, project_id }`, and two RELEASE steps using `release_phase` values `PREFLIGHT` and `DEPLOY`. Update Manager rules to choose it for deployment routes, write confirmed requests to drafts, validate, and submit by expected hash. State that draft validation failures may reuse the draft request ID, while formal rejected receipts still require a new ID.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: all tests pass.

- [ ] **Step 5: Commit the template and protocol**

```bash
git add templates/manager-request.deploy.json agents/manager-agent/workspace/AGENTS.md agents/manager-agent/workspace/TOOLS.md agents/manager-agent/workspace/templates/README.md tests/orchestrator-request-and-route.test.mjs
git commit -m "feat(manager): add deployment request protocol"
```

### Task 2: Bounded validation and hash-bound submission

**Files:**
- Create: `scripts/manager-control/request-submission.mjs`
- Modify: `scripts/manager-control/cli.mjs`
- Test: `tests/manager-control.test.mjs`

**Interfaces:**
- Consumes: `runtime/control/install-manifest.json`, the existing `scripts/orchestrator-cli.mjs validate-request` command, and Manager draft files.
- Produces: `createManagerRequestSubmission({ projectRoot, runtimeRoot, runValidator })` with `validateDraft(draftFile)` and `submitDraft(draftFile, expectedSha256)` methods.

- [ ] **Step 1: Add failing action and security tests**

Test valid deployment-draft validation, exact SHA return, atomic submission, unchanged submitted bytes, validation failure without queue output, SHA mismatch, invalid basename, symbolic link, hard link, and refusal to overwrite an existing request or receipt. Test CLI argument allowlists for `orchestrator-validate-request --draft-file` and `orchestrator-submit-request --draft-file --expected-sha256`.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test tests/manager-control.test.mjs`

Expected: failure because the actions and request-submission module do not exist.

- [ ] **Step 3: Implement safe draft resolution and authoritative validation**

Implement basename validation with `/^[A-Za-z0-9][A-Za-z0-9.-]*\.json$/`, reject path separators and absolute paths, open only a regular single-link file with no-follow semantics, and compute SHA-256 from the bytes read through that descriptor. Invoke `process.execPath` with `[scripts/orchestrator-cli.mjs, 'validate-request', '--project-root', projectRoot, '--request-file', draftPath]`, `shell: false`, and structured JSON error propagation.

- [ ] **Step 4: Implement hash-bound atomic submission and CLI dispatch**

Require a lowercase 64-character `expected_sha256`, reread and revalidate the draft, refuse existing request/receipt paths, and atomically publish the exact bytes using a create-exclusive temporary file followed by a no-overwrite finalization. Return `{ status: 'QUEUED', request_id, workflow_id, request_type, input_sha256, request_path }`.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `node --test tests/manager-control.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit the controlled boundary**

```bash
git add scripts/manager-control/request-submission.mjs scripts/manager-control/cli.mjs tests/manager-control.test.mjs
git commit -m "feat(manager): validate drafts before queue submission"
```

### Task 3: Installer, runtime bundle, and operator documentation

**Files:**
- Modify: `scripts/install.ps1`
- Modify: `scripts/install.sh`
- Modify: `README.md`
- Modify: `tests/runtime-bundle.test.mjs`
- Modify: `tests/validate-install.test.mjs`

**Interfaces:**
- Consumes: the new global template and Manager-control source copied by the existing installers.
- Produces: installed Manager draft/request/receipt directories and installation assertions for the new protocol.

- [ ] **Step 1: Add failing installation and bundle assertions**

Require the runtime bundle to contain `manager-control/request-submission.mjs` and the installed Manager workspace to contain `templates/manager-request.deploy.json`. Extend Linux installation validation to require `.orchestrator/drafts`, `.orchestrator/requests`, and `.orchestrator/receipts`; add the equivalent PowerShell source assertions where PowerShell execution is unavailable.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs`

Expected: failure because installation does not explicitly create the request lifecycle directories and README does not document the new commands.

- [ ] **Step 3: Update both installers and README**

Create all three Manager request lifecycle directories during apply mode without changing installer parameters. Document template selection, validation, hash-bound submission, and the distinction between draft validation errors and formal rejected receipts. Keep existing update and reinstall commands unchanged.

- [ ] **Step 4: Run focused tests and dry-run validation**

Run:

```bash
node --test tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
bash scripts/install.sh --dry-run --yes --runtime-root runtime
bash scripts/validate-install.sh --runtime-root runtime
```

Expected: tests and Linux dry-run/validation pass. PowerShell-specific test cases remain skipped only when `pwsh` is unavailable.

- [ ] **Step 5: Commit installation and documentation**

```bash
git add scripts/install.ps1 scripts/install.sh README.md tests/runtime-bundle.test.mjs tests/validate-install.test.mjs
git commit -m "docs(manager): install request preflight workflow"
```

### Task 4: Full regression verification

**Files:**
- Verify only; modify earlier task files only if a regression exposes a requirement gap.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: a clean branch whose full test suite and relevant installation validation pass.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: zero failures; PowerShell-only tests may skip when `pwsh` is unavailable.

- [ ] **Step 2: Inspect branch changes and commit history**

Run:

```bash
git status --short
git diff --check
git log --oneline --decorate -5
```

Expected: no uncommitted implementation changes, no whitespace errors, and separate commits for design/plan, Manager protocol, controlled boundary, and installation/docs.
