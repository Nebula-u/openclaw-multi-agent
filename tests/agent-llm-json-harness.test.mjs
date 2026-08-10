import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLM_SCENARIOS, buildLlmCasePrompt } from '../scripts/agent-json-harness/llm-scenarios.mjs';
import { textFromMessage } from '../scripts/agent-json-harness/gateway-llm-client.mjs';
import { runLlmCase } from '../scripts/agent-json-harness/llm-runner.mjs';
import { collectLlmRun } from '../scripts/agent-json-harness/collect-llm-failures.mjs';
import { ingestJsonText } from '../scripts/runtime-core/json-ingestion.mjs';
import { MAX_REPAIR_RETRIES, buildJsonRepairPrompt, classifyLlmFailure } from '../scripts/agent-json-harness/json-repair-prompts.mjs';
import { CONTRACT_SCENARIOS, INTERNAL_CONTRACTS, getContractScenario } from '../scripts/agent-llm-contract-tests/contract-scenarios.mjs';

const EXPECTED_SCHEMAS = [
  'acceptance-criteria.schema.json', 'agent-package.schema.json',
  'approval-assessment.schema.json', 'approval-request.schema.json', 'approval-response.schema.json', 'command-record.schema.json',
  'component-build-result.schema.json', 'component-request.schema.json', 'context-manifest.schema.json',
  'evidence.schema.json', 'gate-result.schema.json', 'json-validation-error.schema.json',
  'release-decision.schema.json', 'result.schema.json', 'review-findings.schema.json', 'skill-package.schema.json',
  'task.schema.json',
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

test('轻量 Agent 契约测试为每个 JSON Schema 定义对应 Agent 与格式', () => {
  const contractFiles = readdirSync(join(process.cwd(), 'contracts')).filter((name) => name.endsWith('.schema.json')).sort();
  const agentContracts = contractFiles.filter((name) => !INTERNAL_CONTRACTS.has(name));
  assert.deepEqual(Object.keys(CONTRACT_SCENARIOS).sort(), agentContracts);
  for (const schemaFile of agentContracts) {
    const scenario = getContractScenario(schemaFile);
    assert.match(scenario.agentId, /-agent$/u);
    assert.equal(typeof scenario.jsonl, 'boolean');
  }
  assert.deepEqual([...INTERNAL_CONTRACTS].sort(), contractFiles.filter((name) => INTERNAL_CONTRACTS.has(name)));
});

test('提示只要求最终 LLM 回复，且不嵌入模板', () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const prompt = buildLlmCasePrompt(scenario, scenario.cases[0], '{"type":"object"}');
  assert.match(prompt, /不要调用任何工具/);
  assert.match(prompt, /仅回复/);
  assert.doesNotMatch(prompt, /templates\//i);
});

test('非空但不符合 schema 的回复在相同 Gateway session 中最多重试两次', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return '{}'; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'unit-run' });
  assert.equal(outcome.classification, 'RETRY_FAILED');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.sessionKey === calls[0].sessionKey));
  assert.match(calls[1].prompt, /SCHEMA_DRIFT/);
});

test('空回复与其他错误共享最多两次重写预算', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return ''; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-run' });
  assert.equal(outcome.classification, 'EMPTY_RETRY_FAILED');
  assert.equal(outcome.repair_retries, MAX_REPAIR_RETRIES);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.sessionKey === calls[0].sessionKey));
  assert.match(calls[1].prompt, /EMPTY_RESPONSE/);
});

test('空回复恢复为合法 JSON 时标记为成功', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const responses = ['', '{"schema_version":1,"workflow_id":"WF-a","task_id":"TASK-a","run_id":"RUN-a","agent_id":"developer-agent","role":"worker","attempt":1,"started_at":"2026-08-03T00:00:00Z","finished_at":"2026-08-03T00:00:01Z","result_status":"BLOCKED","summary_for_user":"x","summary_for_manager":"x","worktree_path_abs":"D:/worktree","artifact_root_abs":"D:/artifact","isolation_mode":"UNSANDBOXED_LOCAL","self_validation":{"preflight_passed":false,"checks":[]}}'];
  const client = { send: async () => responses.shift() };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-success-run' });
  assert.equal(outcome.classification, 'REPAIR_RETRY_SUCCEEDED');
  assert.equal(outcome.repair_retries, 1);
});

test('固定重写模板明确要求 JSON 且禁止空输出', () => {
  const prompt = buildJsonRepairPrompt({ classification: 'EMPTY_RESPONSE', errors: [], retryNumber: 1 });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /content 为空/);
});

test('工具调用没有文本时不被误认为空 LLM 回复', () => {
  assert.equal(textFromMessage({ role: 'assistant', content: [{ type: 'function_call', name: 'read_file', arguments: '{}' }] }), null);
  assert.equal(textFromMessage({ role: 'assistant', content: '' }), '');
});

test('确定性 ingestion 清理 BOM、Markdown 与唯一解释性前后缀，但不修复业务字段', () => {
  const ingested = ingestJsonText('\uFEFF```json\n{"status":"UNKNOWN","id":"A"}\n```');
  assert.deepEqual(ingested.value, { status: 'UNKNOWN', id: 'A' });
  assert.deepEqual(ingested.transformations, ['STRIP_UTF8_BOM', 'UNWRAP_SINGLE_JSON_FENCE']);
  const wrapped = ingestJsonText('说明如下：\n```json\n{"status":"UNKNOWN"}\n```\n请检查。');
  assert.deepEqual(wrapped.value, { status: 'UNKNOWN' });
  assert.deepEqual(wrapped.transformations, ['UNWRAP_SINGLE_JSON_FENCE']);
  const prose = ingestJsonText('说明如下： {"id":"A"} 谢谢。');
  assert.deepEqual(prose.value, { id: 'A' });
  assert.deepEqual(prose.transformations, ['EXTRACT_UNIQUE_JSON_FROM_WRAPPER']);
  assert.throws(() => ingestJsonText('有两个候选： {"id":"A"} 和 {"id":"B"}'), /more than one/i);
});

test('JSONL ingestion 可移除唯一 Markdown 包装并拒绝猜测多个块', () => {
  const ingested = ingestJsonText('说明\n```jsonl\n{"id":"A"}\n{"id":"B"}\n```\n结束', { jsonl: true });
  assert.deepEqual(ingested.value, [{ id: 'A' }, { id: 'B' }]);
  assert.throws(() => ingestJsonText('{"id":"A"}\n说明\n{"id":"B"}', { jsonl: true }), /more than one/i);
});

test('错误分类和模板区分截断、enum/type 与 schema drift', () => {
  assert.throws(() => ingestJsonText('{"a":'), (error) => error.diagnostic === 'OUTPUT_TRUNCATED');
  assert.equal(classifyLlmFailure({ response: '{"a":', validation: { errors: [] }, ingestionError: { diagnostic: 'OUTPUT_TRUNCATED' } }), 'OUTPUT_TRUNCATED');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'enum' }] } }), 'ENUM_VIOLATION');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'type' }] } }), 'TYPE_VIOLATION');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'required' }] } }), 'SCHEMA_DRIFT');
  assert.match(buildJsonRepairPrompt({ classification: 'ENUM_VIOLATION', errors: [{ path: '/result_status', schema_keyword: 'enum', message: 'must be equal to one of the allowed values' }], retryNumber: 1 }), /enum 值不合法/);
  assert.match(buildJsonRepairPrompt({ classification: 'OUTPUT_TRUNCATED', errors: [], retryNumber: 2 }), /截断/);
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
