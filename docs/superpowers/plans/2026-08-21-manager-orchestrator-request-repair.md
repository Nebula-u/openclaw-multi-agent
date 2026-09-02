# Manager–Orchestrator Request Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the manager one current, test-proven protocol for routing feature requests to the Node Orchestrator without doing the requirement agent's work.

**Architecture:** The manager remains a sandboxed conversation agent that writes session-bound request JSON to its existing queue. A complete request reference and unambiguous workspace instructions prevent legacy StateGraph output. The Node Orchestrator validates the request and maps route stages to fixed worker agents.

**Tech Stack:** Node.js 22, node:test, AJV request/route validation, Markdown workspace rules, JSON templates.

## Global Constraints

- Keep the manager's tools limited to `read`, `write`, `edit`, and `session_status`.
- Do not add manager worker delegation, database mutation, shell execution, or business-code tools.
- Preserve the rejected request and its receipt as evidence; do not delete or overwrite them.
- The manager may ask necessary route/confirmation questions, but requirement recommendations remain owned by `requirement-agent`.
- A changed manager workspace or template requires installed Agent synchronization after delivery.

---

### Task 1: Lock the manager request reference and instructions

**Files:**
- Modify: `agents/manager-agent/workspace/AGENTS.md`
- Modify: `agents/manager-agent/workspace/TOOLS.md`
- Modify: `agents/manager-agent/workspace/templates/README.md`
- Modify: `templates/manager-request.json`
- Create: `templates/manager-request.change.json`
- Create: `templates/manager-request.decision.json`
- Test: `tests/orchestrator-request-and-route.test.mjs`

**Interfaces:**
- Consumes: `contracts/manager-request.schema.json`, `contracts/route-plan.schema.json`, and `scripts/orchestrator/route-policy.mjs`.
- Produces: manager-readable references for `CREATE`, `CHANGE`, and `DECISION` requests.

- [ ] **Step 1: Write failing static contract tests**

Add tests that require all three request-reference files, require the manager rules to name `session_status`, `templates/manager-request.json`, and `.orchestrator/receipts/`, and reject `.agent-raw/route-plan.json.raw` plus the unavailable `validate-request` command.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: FAIL because the current manager tools still name `.agent-raw/route-plan.json.raw` and only one request template exists.

- [ ] **Step 3: Write the minimal protocol references**

Replace the stale tool description, state the manager/request-agent boundary, and add valid JSON reference shapes. The CREATE reference includes a full serial feature route with `REQUIREMENTS` marked `human_approval_after: true`; CHANGE and DECISION references contain their mandatory request-specific fields.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```text
git add agents/manager-agent/workspace templates tests/orchestrator-request-and-route.test.mjs
git commit -m "fix: align manager request protocol with orchestrator"
```

### Task 2: Prove a template-shaped CREATE request reaches the assigned requirement agent

**Files:**
- Modify: `tests/orchestrator-request-and-route.test.mjs`

**Interfaces:**
- Consumes: `createManagerRequestProcessor`, `assertManagerRequest`, and `compileRoutePlan`.
- Produces: a regression proof that the current request contract is accepted and maps `REQUIREMENTS` to `requirement-agent`.

- [ ] **Step 1: Write the failing queue acceptance test**

Add a manager request fixture with `schema_version: 1`, `request_type: "CREATE"`, a valid `WF-...` identifier, session binding, original request, user authorization, and the serial feature route. Assert that `processFile` returns `ACCEPTED`, the mock receives the request, and its compiled first step has `agent_id === "requirement-agent"`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: FAIL until the new fixture and assertions use the exact current request shape.

- [ ] **Step 3: Make only the fixture/test helper changes needed for the current templates**

Use the existing `routePlan` helper or a focused feature-route helper; do not modify queue or route-policy production code because their current behavior already produced the correct rejected receipt for the legacy request.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/orchestrator-request-and-route.test.mjs`

Expected: PASS and the route's requirements step is assigned to `requirement-agent`.

- [ ] **Step 5: Commit**

```text
git add tests/orchestrator-request-and-route.test.mjs
git commit -m "test: cover manager create request routing"
```

### Task 3: Verify package assembly and repository behavior

**Files:**
- Test: `tests/runtime-bundle.test.mjs`
- Test: `tests/orchestrator-request-and-route.test.mjs`

**Interfaces:**
- Consumes: `scripts/runtime-bundle.mjs` and the installed manager workspace assembly contract.
- Produces: evidence that templates are included in the runtime bundle and the focused protocol suite remains green.

- [ ] **Step 1: Run focused manager and bundle tests**

Run: `node --test tests/orchestrator-request-and-route.test.mjs tests/runtime-bundle.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run complete verification**

Run: `npm test`

Expected: PASS with no failures.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check` and `git status --short`

Expected: no whitespace errors and only the planned source, test, and documentation changes.

- [ ] **Step 4: Commit documentation if not already committed**

```text
git add docs/superpowers/specs/2026-08-21-manager-orchestrator-request-repair-design.md docs/superpowers/plans/2026-08-21-manager-orchestrator-request-repair.md
git commit -m "docs: record manager orchestrator repair"
```
