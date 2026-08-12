import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  JSON_SCHEMA_AGENT_SCENARIOS,
  PROMPTS_PER_SCENARIO,
  REPETITIONS_PER_PROMPT,
} from '../scripts/agent-llm-contract-tests/json-schema-test-scenarios.mjs';
import { CONTRACT_SCENARIOS, INTERNAL_CONTRACTS } from '../scripts/agent-llm-contract-tests/contract-scenarios.mjs';
import { DEFAULT_TIMEOUT_MS, runJsonSchemaMatrix } from '../scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs';

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
      assert.match(prompt.text, /不要调用工具/u);
      assert.match(prompt.text, /立即结束/u);
      assert.match(prompt.text, /仅回复/u);
    }
  }
});

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
    validateResponse: () => {
      count += 1;
      return { ok: count !== 1, errors: count === 1 ? [{ code: 'SCHEMA_REQUIRED' }] : [], ingestion: null };
    },
  });
  assert.equal(summary.totals.executed, 100);
  assert.equal(summary.totals.failed, 1);
  assert.ok(existsSync(join(root, 'failure-run', 'failures')));
});

test('package exposes the full matrix command', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['agent-json-schema:matrix'], 'node scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs');
});

test('matrix Agent calls are capped at fifteen minutes', async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 900000);
  await assert.rejects(
    () => runJsonSchemaMatrix({
      scenarios: [JSON_SCHEMA_AGENT_SCENARIOS[0]], timeoutMs: 900001,
      createClient: async () => ({ send: async () => '{}', close() {} }),
    }),
    /no more than 900000ms/u,
  );
});
