# Trusted Runtime Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dependency-free, fail-closed runtime guard that enforces workflow state, JSON contracts, event integrity, Gate aggregation, and approval scope.

**Architecture:** Keep manager-agent as the orchestrator and add one stateless Node.js guard invoked at control boundaries. Machine-readable state transitions and two missing control schemas make cross-file checks deterministic without reintroducing a background control plane.

**Tech Stack:** Node.js 22 standard library, JSON Schema Draft-07 subset, Bash, PowerShell 7, Node `node:test`.

## Global Constraints

- No Python runtime control plane, daemon, dispatcher, network access, or npm dependency.
- Guard failures are fail-closed and never rewrite historical Agent artifacts.
- README records results only; CHANGELOG records change, reason, and effect.
- Current historical Windows runtime is unavailable and must not be auto-migrated.

---

### Task 1: Runtime Guard Behavioral Tests

**Files:**
- Create: `tests/runtime-guard.test.mjs`
- Create later: `scripts/runtime-guard.mjs`

**Interfaces:**
- Consumes: CLI commands `validate-file`, `append-event`, and `check-workflow`.
- Produces: observable exit codes, JSON stdout, and appended event lines.

- [ ] **Step 1: Write tests against the desired CLI**

Use `node:test`, `assert/strict`, `spawnSync`, and `mkdtempSync`. Each test creates a real temporary runtime and invokes `node scripts/runtime-guard.mjs ...`.

Required test names:

```text
validate-file rejects malformed JSON
validate-file rejects a result missing agent_id
append-event creates a deterministic first hash
check-workflow rejects an invalid workflow transition
check-workflow rejects active index revision drift
check-workflow rejects a null or tampered event hash
check-workflow rejects FAIL items with PASS overall
check-workflow rejects PASS while an approval is pending
check-workflow rejects approval responses reused across task or run
check-workflow rejects release PASS with open HIGH findings
check-workflow accepts a consistent minimal workflow
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test tests/runtime-guard.test.mjs
```

Expected: FAIL because `scripts/runtime-guard.mjs` does not exist.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/runtime-guard.test.mjs
git commit -m "test: define runtime guard behavior"
```

### Task 2: Schema Subset Validator and CLI

**Files:**
- Create: `scripts/runtime-guard.mjs`

**Interfaces:**
- Consumes: `--schema`, `--file`, `--jsonl`, `--allow-placeholders`.
- Produces: `{ "ok": true, ... }` on stdout and exit 0; `{ "ok": false, "errors": [...] }` and exit 1 on failure.

- [ ] **Step 1: Implement argument parsing and deterministic JSON output**
- [ ] **Step 2: Implement JSON/JSONL parsing with line-numbered errors**
- [ ] **Step 3: Implement the supported Draft-07 keyword subset and local `$ref`**
- [ ] **Step 4: Reject unsupported assertion keywords and runtime placeholders**
- [ ] **Step 5: Run the focused validate-file tests**

Run:

```bash
node --test --test-name-pattern='validate-file' tests/runtime-guard.test.mjs
```

Expected: PASS.

### Task 3: State and Event Contracts

**Files:**
- Create: `config/workflow-state-machine.json`
- Create: `contracts/active-workflows.schema.json`
- Create: `contracts/workflow-event.schema.json`
- Modify: `contracts/workflow.schema.json`
- Create: `templates/active-workflows.json`
- Create: `templates/workflow-event.json`
- Modify: `templates/workflow.json`
- Modify: `templates/task.json`
- Modify: `templates/result.json`

**Interfaces:**
- Consumes: workflow/task current and previous states.
- Produces: `state_revision`, legal transition tables, canonical event schema, safe template defaults.

- [ ] **Step 1: Add workflow and task transition maps**
- [ ] **Step 2: Add HOLD, WAITING_HUMAN, state_revision, and phase enum to workflow schema**
- [ ] **Step 3: Define strict active index and workflow event schemas**
- [ ] **Step 4: Add safe templates with empty approvals and non-success result defaults**
- [ ] **Step 5: Run schema JSON parsing checks**

Run:

```bash
for file in contracts/*.json config/workflow-state-machine.json templates/*.json; do jq empty "$file"; done
```

Expected: exit 0.

### Task 4: Event Append and Workflow Consistency

**Files:**
- Modify: `scripts/runtime-guard.mjs`

**Interfaces:**
- `append-event --events <path> --event <draft-path> --project-root <path>`
- `check-workflow --project-root <path> --runtime-root <path> --workflow-id <id> [--skip-git]`

- [ ] **Step 1: Implement recursive canonical JSON and SHA-256**
- [ ] **Step 2: Implement append-only event creation with fsync**
- [ ] **Step 3: Validate event seq, previous hash, recomputed hash, workflow transition, task transition, and latest snapshot match**
- [ ] **Step 4: Validate active index, task references, pending decisions, result IDs, JSONL evidence, and Git candidate**
- [ ] **Step 5: Run event and state tests**

Run:

```bash
node --test --test-name-pattern='append-event|transition|revision|event hash|consistent minimal workflow' tests/runtime-guard.test.mjs
```

Expected: PASS.

### Task 5: Gate and Approval Enforcement

**Files:**
- Modify: `contracts/gate-result.schema.json`
- Modify: `contracts/approval-request.schema.json`
- Modify: `contracts/approval-response.schema.json`
- Create: `templates/gate-result.json`
- Create: `templates/approval-request.json`
- Create: `templates/approval-response.json`
- Modify: `scripts/runtime-guard.mjs`

**Interfaces:**
- Gate items require `blocking`; Gate requires `overall_reason` and `approved_decision_ids`.
- Approval request/response bind `decision_id`, `workflow_id`, `task_id`, and `run_id`.

- [ ] **Step 1: Tighten Gate and approval schemas**
- [ ] **Step 2: Recompute expected Gate overall from item statuses**
- [ ] **Step 3: Block PASS for pending approvals and open BLOCKER/CRITICAL/HIGH findings**
- [ ] **Step 4: Validate approval option and scope matching**
- [ ] **Step 5: Validate ReleaseReadinessGate against release verdict**
- [ ] **Step 6: Run Gate and approval tests**

Run:

```bash
node --test --test-name-pattern='FAIL items|approval|HIGH findings|release' tests/runtime-guard.test.mjs
```

Expected: PASS.

### Task 6: Manager and Installer Integration

**Files:**
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `agents/common/APPROVAL_RULES.md`
- Modify: `scripts/validate-install.sh`
- Modify: `scripts/validate-install.ps1`

**Interfaces:**
- Manager invokes Guard before and after control boundaries.
- Static validators invoke Node tests and validate schemas/templates through Guard.

- [ ] **Step 1: Permit only the stateless Runtime Guard exception to the no-control-plane rule**
- [ ] **Step 2: Require Guard success before spawn, merge, phase advance, recovery, and completion claims**
- [ ] **Step 3: Replace invalid HOLD result language with task/workflow HOLD behavior**
- [ ] **Step 4: Call Guard self-check and Node tests from Bash and PowerShell validators**
- [ ] **Step 5: Run Bash installation validation**

Run:

```bash
bash scripts/validate-install.sh --skip-openclaw
```

Expected: all checks PASS.

### Task 7: Documentation and Release Notes

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/workflow.md`
- Modify: `docs/manager-orchestration.md`
- Modify: `docs/state-and-recovery.md`
- Modify: `docs/agent-contracts.md`
- Modify: `docs/gate-checklists.md`
- Modify: `docs/human-approval.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documentation matches executable states and commands.
- README contains results only.
- CHANGELOG contains what, why, and effect.

- [ ] **Step 1: Document the stateless Guard architecture boundary**
- [ ] **Step 2: Replace contradictory HOLD and WAITING_HUMAN language**
- [ ] **Step 3: Document canonical event hashing, Gate aggregation, and approval binding**
- [ ] **Step 4: Add concise README usage and achieved guarantees**
- [ ] **Step 5: Add CHANGELOG entry with change/reason/effect**

### Task 8: Full Verification and Review

**Files:**
- Review all modified files.

- [ ] **Step 1: Run the complete Node test suite**

```bash
node --test tests/runtime-guard.test.mjs
```

- [ ] **Step 2: Run Bash static validation**

```bash
bash scripts/validate-install.sh --skip-openclaw
```

- [ ] **Step 3: Run syntax and JSON checks**

```bash
bash -n scripts/*.sh
node --check scripts/runtime-guard.mjs
for file in contracts/*.json config/*.json templates/*.json; do jq empty "$file"; done
```

- [ ] **Step 4: Confirm repository diff is scoped and contains no runtime artifacts**

```bash
git status --short
git diff --check
git diff --stat origin/main...HEAD
```

- [ ] **Step 5: Request independent code review and address Critical/Important findings**
- [ ] **Step 6: Commit the verified implementation**

```bash
git add scripts/runtime-guard.mjs tests/runtime-guard.test.mjs config contracts templates agents docs README.md CHANGELOG.md
git commit -m "feat: enforce trusted workflow runtime state"
```
