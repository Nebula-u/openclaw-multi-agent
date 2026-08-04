import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLM_SCENARIOS, buildEmptyLlmRetryPrompt, buildLlmCasePrompt } from '../scripts/agent-json-harness/llm-scenarios.mjs';
import { textFromMessage } from '../scripts/agent-json-harness/gateway-llm-client.mjs';
import { runLlmCase } from '../scripts/agent-json-harness/llm-runner.mjs';
import { collectLlmRun } from '../scripts/agent-json-harness/collect-llm-failures.mjs';
import { ingestJsonText } from '../scripts/runtime-core/json-ingestion.mjs';

const EXPECTED_SCHEMAS = [
  'acceptance-criteria.schema.json', 'active-workflows.schema.json', 'agent-package.schema.json',
  'approval-assessment.schema.json', 'approval-request.schema.json', 'approval-response.schema.json', 'command-record.schema.json',
  'component-build-result.schema.json', 'component-request.schema.json', 'context-manifest.schema.json',
  'evidence.schema.json', 'gate-result.schema.json', 'json-validation-error.schema.json',
  'release-decision.schema.json', 'result.schema.json', 'review-findings.schema.json', 'skill-package.schema.json',
  'task.schema.json', 'workflow-event.schema.json', 'workflow.schema.json',
];

test('LLM 场景矩阵覆盖每份契约的 5 个不同需求', () => {
  assert.deepEqual(LLM_SCENARIOS.map((item) => item.schemaFile).sort(), [...EXPECTED_SCHEMAS].sort());
  for (const scenario of LLM_SCENARIOS) {
    assert.equal(scenario.cases.length, 5);
    assert.equal(new Set(scenario.cases.map((item) => item.id)).size, 5);
    assert.equal(new Set(scenario.cases.map((item) => item.topic)).size, 5);
    assert.notEqual(scenario.agentId, 'dialogue-agent');
  }
});

test('提示只要求最终 LLM 回复，且不嵌入模板', () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const prompt = buildLlmCasePrompt(scenario, scenario.cases[0], '{"type":"object"}');
  assert.match(prompt, /不要调用任何工具/);
  assert.match(prompt, /仅回复/);
  assert.doesNotMatch(prompt, /templates\//i);
});

test('非空但不符合 schema 的回复只在相同 Gateway session 中重试一次', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return '{}'; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'unit-run' });
  assert.equal(outcome.classification, 'RETRY_FAILED');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sessionKey, calls[1].sessionKey);
  assert.match(calls[1].prompt, /未通过 JSON Schema 校验/);
});

test('空回复最多在相同 Gateway session 中重写三次', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return ''; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-run' });
  assert.equal(outcome.classification, 'EMPTY_RETRY_FAILED');
  assert.equal(outcome.empty_retries, 3);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.sessionKey === calls[0].sessionKey));
  assert.match(calls[1].prompt, /最终回复为空/);
});

test('空回复恢复为合法 JSON 时标记为成功', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const responses = ['', '{"schema_version":1,"workflow_id":"WF-a","task_id":"TASK-a","run_id":"RUN-a","agent_id":"developer-agent","role":"worker","attempt":1,"started_at":"2026-08-03T00:00:00Z","finished_at":"2026-08-03T00:00:01Z","result_status":"BLOCKED","summary_for_user":"x","summary_for_manager":"x","worktree_path_abs":"D:/worktree","artifact_root_abs":"D:/artifact","isolation_mode":"UNSANDBOXED_LOCAL","self_validation":{"preflight_passed":false,"checks":[]}}'];
  const client = { send: async () => responses.shift() };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-success-run' });
  assert.equal(outcome.classification, 'EMPTY_RETRY_SUCCEEDED');
  assert.equal(outcome.empty_retries, 1);
});

test('空回复重试提示明确要求 JSON 且禁止空输出', () => {
  const prompt = buildEmptyLlmRetryPrompt(2);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /空字符串/);
});

test('工具调用没有文本时不被误认为空 LLM 回复', () => {
  assert.equal(textFromMessage({ role: 'assistant', content: [{ type: 'function_call', name: 'read_file', arguments: '{}' }] }), null);
  assert.equal(textFromMessage({ role: 'assistant', content: '' }), '');
});

test('确定性 ingestion 只剥离 BOM 或完整单 JSON fence，不修复业务字段', () => {
  const ingested = ingestJsonText('\uFEFF```json\n{"status":"UNKNOWN","id":"A"}\n```');
  assert.deepEqual(ingested.value, { status: 'UNKNOWN', id: 'A' });
  assert.deepEqual(ingested.transformations, ['STRIP_UTF8_BOM', 'UNWRAP_SINGLE_JSON_FENCE']);
  assert.throws(() => ingestJsonText('说明\n```json\n{}\n```'), SyntaxError);
});

test('收集器只创建一个 Gateway 客户端并打包每个最终失败回复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-llm-collector-'));
  const scenario = {
    name: 'uncapped', schemaFile: 'result.schema.json', agentId: 'developer-agent', jsonl: false,
    cases: [1, 2, 3, 4].map((number) => ({ id: `case-${number}`, topic: `主题-${number}` })),
  };
  let created = 0;
  let closed = 0;
  let reconnected = 0;
  const summary = await collectLlmRun({
    scenarios: [scenario], outputRoot: root, runId: 'unit-run',
    createClient: async () => { created += 1; return { close: () => { closed += 1; }, reconnect: async () => { reconnected += 1; } }; },
    runCaseImpl: async ({ testCase }) => ({
      classification: 'RETRY_FAILED', scenario, testCase, sessionKey: `unit:${testCase.id}`,
      attempts: [1, 2].map((attempt) => ({ attempt, prompt: `提示 ${attempt}`, response: '{}', validation: { ok: false, errors: [{ code: 'SCHEMA_REQUIRED', path: '$', message: 'required' }] }, error: null })),
    }),
    concurrency: 3, repetitions: 1, connectionBatchSize: 2, onProgress: () => {},
  });
  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.equal(reconnected, 1);
  assert.equal(summary.totals.packaged, 4);
  for (const number of [1, 2, 3, 4]) {
    const folder = join(root, 'unit-run', 'failures', `uncapped__case-${number}-r1`);
    assert.ok(existsSync(join(folder, 'attempt1-response.json')));
    assert.ok(existsSync(join(folder, 'attempt2-guard.json')));
  }
  assert.match(readFileSync(join(root, 'unit-run', 'report.md'), 'utf8'), /已打包供审阅：4/);
});
