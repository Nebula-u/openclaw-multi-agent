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
      assert.match(prompt.text, /不要调用工具/u);
      assert.match(prompt.text, /立即结束/u);
      assert.match(prompt.text, /仅回复/u);
    }
  }
});
