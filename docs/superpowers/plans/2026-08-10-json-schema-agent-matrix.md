# Agent JSON Schema 全量矩阵测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个严格执行 23 个 Agent JSON Schema 场景、每场景 5 个 prompt、每 prompt 20 次独立调用并完整收集处理后校验结果的脚本。

**Architecture:** `json-schema-test-scenarios.mjs` 生成固定矩阵与 prompt；`run-json-schema-matrix.mjs` 通过单一 Gateway client 串行调用独立 session，并复用 `validateLlmResponse` 与现有错误分类器；运行目录以 `manifest/prompts/results/summary/report/failures` 保存完整证据。旧 `agent-json-harness` 的自动重写路径保持不变。

**Tech Stack:** Node.js 22 ESM、Node test runner、现有 OpenClaw Gateway client、`runtime-core/json-ingestion.mjs`、`runtime-guard.mjs` + Ajv。

## Global Constraints

- LLM 场景范围必须是 `CONTRACT_SCENARIOS` 的全部 23 项。
- `INTERNAL_CONTRACTS` 的 12 项不得发给 Agent，只通过 Runtime Guard self-check 编译。
- 每个场景必须恰好 5 个不同 prompt。
- 每个 prompt 必须原样调用恰好 20 次；不自动 repair、不自动补发通信失败。
- 默认总计划调用数必须是 `23 * 5 * 20 = 2300`。
- 每次调用使用独立 session key；prompt 必须要求 Agent 不调用工具、不读写文件、回复后立即结束。
- 每次回复必须经过既有 ingestion 和 `runtime-guard.mjs validate-file` + Ajv 校验。
- 真实 Agent 运行默认串行，避免并发引起额外会话行为。
- 运行结果写入 `artifacts/agent-json-schema-matrix/`，不把真实回复加入版本控制。

---

### Task 1: 建立全量场景矩阵和离线契约测试

**Files:**
- Create: `scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs`
- Create: `tests/agent-llm-json-matrix.test.mjs`

**Interfaces:**
- Produces `PROMPTS_PER_SCENARIO = 5` and `REPETITIONS_PER_PROMPT = 20`.
- Produces `JSON_SCHEMA_AGENT_SCENARIOS`, each item `{ name, schemaFile, agentId, jsonl, prompts }`.
- Produces `buildJsonSchemaPrompt({ scenario, prompt, schemaText }) -> string`.
- Produces `buildJsonSchemaScenarios({ contractScenarios, contractsDir }) -> scenario[]`.

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  JSON_SCHEMA_AGENT_SCENARIOS,
  PROMPTS_PER_SCENARIO,
  REPETITIONS_PER_PROMPT,
} from '../scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs';
import { CONTRACT_SCENARIOS, INTERNAL_CONTRACTS } from '../scripts/agent-llm-contract-tests/contract-scenarios.mjs';

test('all externally generated schemas have five distinct prompts and twenty repetitions', () => {
  const schemaFiles = readdirSync(join(process.cwd(), 'contracts')).filter((name) => name.endsWith('.schema.json'));
  const expected = Object.keys(CONTRACT_SCENARIOS).sort();
  assert.deepEqual(JSON_SCHEMA_AGENT_SCENARIOS.map((item) => item.schemaFile).sort(), expected);
  assert.equal(JSON_SCHEMA_AGENT_SCENARIOS.length, 23);
  for (const scenario of JSON_SCHEMA_AGENT_SCENARIOS) {
    assert.equal(scenario.prompts.length, PROMPTS_PER_SCENARIO);
    assert.equal(new Set(scenario.prompts.map((item) => item.id)).size, 5);
    assert.equal(new Set(scenario.prompts.map((item) => item.requirement)).size, 5);
    assert.equal(REPETITIONS_PER_PROMPT, 20);
  }
  assert.deepEqual([...INTERNAL_CONTRACTS].filter((name) => !schemaFiles.includes(name)), []);
});

test('matrix prompts stop the agent after one JSON/JSONL response', () => {
  for (const scenario of JSON_SCHEMA_AGENT_SCENARIOS) {
    for (const prompt of scenario.prompts) {
      assert.match(prompt.text, /不要调用工具/);
      assert.match(prompt.text, /立即结束/);
      assert.match(prompt.text, /仅回复/u);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/agent-llm-json-matrix.test.mjs`

Expected: FAIL because `json-schema-test-scenarios.mjs` does not exist.

- [ ] **Step 3: Write the minimal scenario implementation**

`buildJsonSchemaScenarios` must read only the 23 entries in `CONTRACT_SCENARIOS`, assert every referenced Schema exists, and create exactly these five requirement variants for each Schema: `status-report`, `approval-decision`, `audit-evidence`, `resource-description`, and `blocked-recovery`. Each prompt text must include the schema text, format instruction, fixed business requirement, no-tool/no-file instruction, and immediate-stop instruction. Do not include a template payload.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/agent-llm-json-matrix.test.mjs`

Expected: PASS with the 23-schema/5-prompt assertions.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs tests/agent-llm-json-matrix.test.mjs
git commit -m "test: define full agent JSON schema prompt matrix"
```

### Task 2: Implement exact-call runner and result collection

**Files:**
- Create: `scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs`
- Modify: `tests/agent-llm-json-matrix.test.mjs`

**Interfaces:**
- Produces `runJsonSchemaMatrix({ scenarios, outputRoot, runId, timeoutMs, repetitions = 20, createClient, validateResponse, onProgress }) -> Promise<summary>`.
- With the default arguments, `summary.totals.planned` equals `scenarios.length * 5 * 20`; the programmatic `repetitions` and sliced-scenario options exist only for offline tests and the one-call smoke test.
- Each result record has `{ scenario, schema_file, agent_id, prompt_id, repetition, session_key, prompt_sha256, response, validation, classification, error }`.

- [ ] **Step 1: Write the failing tests**

```js
test('runner sends each identical prompt exactly twenty times and writes every result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'json-schema-matrix-'));
  const scenario = JSON_SCHEMA_AGENT_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const summary = await runJsonSchemaMatrix({
    scenarios: [scenario], outputRoot: root, runId: 'unit-run',
    createClient: async () => ({
      send: async (input) => { calls.push(input); return '{"ok":true}'; },
      close() {},
    }),
    validateResponse: () => ({ ok: true, ingestion: { transformations: [] }, errors: [] }),
  });
  assert.equal(calls.length, 100);
  for (const prompt of scenario.prompts) {
    const matching = calls.filter((call) => call.prompt === prompt.text);
    assert.equal(matching.length, 20);
    assert.equal(new Set(matching.map((call) => call.sessionKey)).size, 20);
  }
  assert.equal(summary.totals.planned, 100);
  assert.equal(summary.totals.executed, 100);
  assert.equal(summary.totals.failed, 0);
  assert.equal(readFileSync(join(root, 'unit-run', 'results.jsonl'), 'utf8').trim().split('\n').length, 100);
});

test('runner records a failed validation and continues with later calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'json-schema-matrix-failure-'));
  const scenario = JSON_SCHEMA_AGENT_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  let count = 0;
  const summary = await runJsonSchemaMatrix({
    scenarios: [scenario], outputRoot: root, runId: 'failure-run',
    createClient: async () => ({ send: async () => '{}', close() {} }),
    validateResponse: () => ({ ok: ++count !== 1, errors: count === 1 ? [{ code: 'SCHEMA_REQUIRED' }] : [], ingestion: null }),
  });
  assert.equal(summary.totals.executed, 100);
  assert.equal(summary.totals.failed, 1);
  assert.ok(existsSync(join(root, 'failure-run', 'failures')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/agent-llm-json-matrix.test.mjs`

Expected: FAIL because `run-json-schema-matrix.mjs` is not available.

- [ ] **Step 3: Write the minimal runner**

The runner must call `assertRuntimeGuardReady()` before connecting, create one client, loop scenario → prompt → repetition in that order, call `client.send({ agentId, sessionKey, prompt: prompt.text, expectedReplyCount: 1, timeoutMs })` once per planned call, and never retry. It must call `validateLlmResponse(response, scenario)` for the default validator, classify failures with `classifyLlmFailure`, append each record to `results.jsonl`, write failed records under `failures/<scenario>__<prompt-id>__call-<n>.json`, and update `summary.json` after every call. `client.close()` belongs in `finally`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --test tests/agent-llm-json-matrix.test.mjs`

Expected: PASS with exactly 100 fake client calls and 100 result lines.

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs tests/agent-llm-json-matrix.test.mjs
git commit -m "feat: collect exact agent JSON schema matrix results"
```

### Task 3: Add CLI entry point, package command, and usage documentation

**Files:**
- Modify: `scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs`
- Modify: `package.json`
- Modify: `scripts/agent-llm-contract-tests/README.md`
- Modify: `tests/agent-llm-json-matrix.test.mjs`

**Interfaces:**
- CLI: `node scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs [--scenario <name> ...] [--run-id <id>] [--output-root <path>] [--timeout-seconds <number>]`.
- Package command: `npm run agent-json-schema:matrix`.
- No CLI flag silently changes the default 5 prompt × 20 repetition contract.

- [ ] **Step 1: Write the failing CLI/manifest test**

```js
test('matrix manifest declares the full default workload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'json-schema-matrix-manifest-'));
  const scenario = JSON_SCHEMA_AGENT_SCENARIOS.slice(0, 1);
  const summary = await runJsonSchemaMatrix({
    scenarios: scenario, outputRoot: root, runId: 'manifest-run',
    createClient: async () => ({ send: async () => '{}', close() {} }),
    validateResponse: () => ({ ok: true, errors: [], ingestion: null }),
  });
  const manifest = JSON.parse(readFileSync(join(root, 'manifest-run', 'manifest.json'), 'utf8'));
  assert.equal(manifest.prompts_per_scenario, 5);
  assert.equal(manifest.repetitions_per_prompt, 20);
  assert.equal(manifest.calls_planned, 100);
  assert.equal(summary.run_status, 'COMPLETE');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/agent-llm-json-matrix.test.mjs`

Expected: FAIL because the manifest/CLI contract is not yet implemented.

- [ ] **Step 3: Implement CLI and docs**

Use the default output root `artifacts/agent-json-schema-matrix`; default run ID is timestamp-based. `--scenario` filters by stable scenario name and can be repeated. Implement `--help` without opening a Gateway connection. Reject unknown scenarios, non-positive timeout, duplicate run directory, or invalid numeric arguments. Do not expose a CLI repetitions override. Update README with the exact full-run command, single-scenario command, output files, and explicit note that a full run makes 2300 Gateway calls.

- [ ] **Step 4: Run focused tests and command help**

Run: `node --test tests/agent-llm-json-matrix.test.mjs && npm run agent-json-schema:matrix -- --help`

Expected: focused tests PASS; help prints usage without opening a Gateway connection.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs scripts/agent-llm-contract-tests/README.md tests/agent-llm-json-matrix.test.mjs
git commit -m "docs: expose full agent JSON schema matrix command"
```

### Task 4: Run proportional verification and lightweight real smoke test

**Files:**
- Modify: `tests/agent-llm-json-matrix.test.mjs` only if a discovered assertion gap requires it.

- [ ] **Step 1: Run the focused offline tests**

Run: `node --test tests/agent-llm-json-matrix.test.mjs tests/agent-llm-json-harness.test.mjs tests/runtime-guard.test.mjs`

Expected: all focused tests pass and existing retry harness behavior remains unchanged.

- [ ] **Step 2: Run the full offline project test suite**

Run: `npm test`

Expected: exit code 0 and no test failures.

- [ ] **Step 3: Run one lightweight real Agent smoke test**

Run: `node --input-type=module -e "import { connectGatewayLlmClient } from './scripts/agent-json-harness/gateway-llm-client.mjs'; import { JSON_SCHEMA_AGENT_SCENARIOS } from './scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs'; import { runJsonSchemaMatrix } from './scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs'; const source = JSON_SCHEMA_AGENT_SCENARIOS.find((item) => item.name === 'result'); const scenario = { ...source, prompts: [source.prompts[0]] }; await runJsonSchemaMatrix({ scenarios: [scenario], repetitions: 1, runId: 'smoke-' + Date.now(), createClient: connectGatewayLlmClient });"`

Expected: one selected Agent returns a text response, the script writes a result record, and the record contains either `validation.ok: true` or an explicit validation/communication failure. Do not claim full matrix success from this smoke test.

- [ ] **Step 4: Check coverage and working tree**

Run: `node --input-type=module -e "import { JSON_SCHEMA_AGENT_SCENARIOS } from './scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs'; console.log(JSON_SCHEMA_AGENT_SCENARIOS.length, JSON_SCHEMA_AGENT_SCENARIOS.reduce((n, s) => n + s.prompts.length * 20, 0))" && git diff --check && git status --short`

Expected: output `23 2300`, no whitespace errors, and only intended files plus pre-existing `projects/` changes.

- [ ] **Step 5: Commit**

```bash
git add tests/agent-llm-json-matrix.test.mjs
git commit -m "test: verify full agent JSON schema matrix coverage"
```
