# HR Model Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure HR Agent to use the same environment-selected model as the other project Agents, and document how to inspect and apply model routing.

**Architecture:** The existing injection script derives every model environment-variable name from the registered OpenClaw Agent ID. `hr-agent` therefore maps to `OPENCLAW_AGENT_HR_AGENT_MODEL` without a new HR-only code path. Configuration, example configuration, routing documentation, and the README will expose that existing runtime behavior.

**Tech Stack:** Node.js ESM, OpenClaw CLI, dotenv-style project configuration, Node test runner.

## Global Constraints

- All eight Agents use `mydeep/deepseek-v4-flash` in the local `.env`.
- Global thinking uses `OPENCLAW_THINKING_LEVEL=off`.
- The injection command writes OpenClaw configuration only with `--apply --yes`.
- Agent runtime/package changes require the documented Agent update commands after delivery.

---

### Task 1: Verify HR environment-variable mapping

**Files:**
- Modify: `tests/validate-install.test.mjs`
- Modify: `scripts/inject-openclaw-models.mjs`

**Interfaces:**
- Produces: `modelEnvironmentKey(agentId)`, returning `OPENCLAW_AGENT_${agentId.replaceAll('-', '_').toUpperCase()}_MODEL`.
- Consumes: an OpenClaw Agent ID such as `hr-agent`.

- [ ] **Step 1: Write the failing test**

```js
test('model injection derives the HR environment-variable name from its Agent ID', async () => {
  const { modelEnvironmentKey } = await import('../scripts/inject-openclaw-models.mjs');
  assert.equal(modelEnvironmentKey('hr-agent'), 'OPENCLAW_AGENT_HR_AGENT_MODEL');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="HR environment-variable" tests/validate-install.test.mjs`

Expected: FAIL because `modelEnvironmentKey` is not exported.

- [ ] **Step 3: Write minimal implementation**

```js
export function modelEnvironmentKey(agentId) {
  return `OPENCLAW_AGENT_${agentId.replaceAll('-', '_').toUpperCase()}_MODEL`;
}
```

Use this function in the injection loop instead of its inline template expression. Guard the CLI entry point so importing the helper does not invoke OpenClaw.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="HR environment-variable" tests/validate-install.test.mjs`

Expected: PASS.

### Task 2: Add HR routing configuration and operator documentation

**Files:**
- Modify: `.env`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/model-routing.md`
- Modify: `tests/validate-install.test.mjs`

**Interfaces:**
- Consumes: `OPENCLAW_AGENT_HR_AGENT_MODEL=mydeep/deepseek-v4-flash` and `OPENCLAW_THINKING_LEVEL=off`.
- Produces: documented operator commands for status inspection and applying environment-backed routing.

- [ ] **Step 1: Write the failing documentation test**

```js
assert.match(readFileSync(join(ROOT, '.env.example'), 'utf8'), /OPENCLAW_AGENT_HR_AGENT_MODEL=provider\/model-id/u);
assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /openclaw models status --agent manager-agent --json/u);
assert.match(readFileSync(join(ROOT, 'README.md'), 'utf8'), /node scripts\/inject-openclaw-models\.mjs --apply --yes/u);
assert.match(modelRouting, /hr-agent.*mydeep\/deepseek-v4-flash/su);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="documents HR model injection" tests/validate-install.test.mjs`

Expected: FAIL because the HR variable and README commands are absent.

- [ ] **Step 3: Make the minimal configuration and documentation edits**

Add the HR variable to local `.env` using `mydeep/deepseek-v4-flash`; list the variable in `.env.example`; make `docs/model-routing.md` describe all eight Agents as environment-selected `mydeep/deepseek-v4-flash`; add the status and apply commands immediately after both platform Agent-update commands in the README.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --test-name-pattern="documents HR model injection" tests/validate-install.test.mjs`

Expected: PASS.

### Task 3: Verify the final configuration contract

**Files:**
- Verify: `.env`, `.env.example`, `README.md`, `docs/model-routing.md`, `scripts/inject-openclaw-models.mjs`, `tests/validate-install.test.mjs`

- [ ] **Step 1: Run targeted verification**

Run: `node --test tests/validate-install.test.mjs`

Expected: PASS.

- [ ] **Step 2: Run the model injection dry-run**

Run: `node scripts/inject-openclaw-models.mjs`

Expected: reports `hr-agent.model=mydeep/deepseek-v4-flash` as either already configured or a pending configuration change, without writing OpenClaw configuration.

- [ ] **Step 3: Inspect changed files**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only the planned files plus the plan document.
