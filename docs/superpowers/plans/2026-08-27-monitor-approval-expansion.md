# Monitor Approval Expansion Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Monitor approval card's “其他” section open across automatic snapshot re-renders for the same pending decision.

**Architecture:** Add a page-memory map keyed by `workflow_id:decision_id`. The approval renderer reads the map when creating its `<details>` element and writes to it from its native `toggle` event. When no pending approval exists, remove cached entries for that workflow.

**Tech Stack:** Browser JavaScript, static HTML, Node.js built-in test runner.

## Global Constraints

- Do not persist approval UI state beyond the active browser page.
- Do not change Monitor API calls, approval command payloads, or Orchestrator behavior.
- Preserve the current no-build static dashboard architecture.

---

### Task 1: Persist the approval auxiliary-action expansion state

**Files:**
- Modify: `tests/monitor-static-dashboard.test.mjs`
- Modify: `monitor/ui/app.js`

**Interfaces:**
- Consumes: `approvalKey(workflow, approval)` and the approval card's existing `<details class="approval-other-actions">`.
- Produces: `state.openApprovalDetails`, a `Set` containing keys for currently expanded approval cards.

- [ ] **Step 1: Write the failing regression assertions**

Add assertions to `tests/monitor-static-dashboard.test.mjs` that require the dashboard source to declare `openApprovalDetails`, render `open` conditionally on a saved expansion value, and register a `toggle` listener on `.approval-other-actions`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/monitor-static-dashboard.test.mjs`

Expected: FAIL because `openApprovalDetails` and the expansion-state restoration code do not exist.

- [ ] **Step 3: Write the minimal implementation**

In `monitor/ui/app.js`, add `openApprovalDetails: new Set()` to `state`. Pass the current approval key into `approvalCard`, add `open` to the rendered `<details>` only when that key is in the set, and update the set in its `toggle` handler. Remove cached keys for a workflow when it has no pending approval or when its pending decision changes.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/monitor-static-dashboard.test.mjs`

Expected: PASS with both static dashboard tests green.

- [ ] **Step 5: Run the Monitor regression suite**

Run: `npm run test:monitor`

Expected: PASS with no failures.
