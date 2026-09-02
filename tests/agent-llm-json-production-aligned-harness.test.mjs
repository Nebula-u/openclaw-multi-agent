import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCTION_ALIGNED_LLM_SCENARIOS,
  REPETITIONS_PER_CASE,
  buildProductionAlignedLlmCasePrompt,
} from '../scripts/agent-json-harness/production-aligned-llm-scenarios.mjs';

test('生产环境对齐矩阵只覆盖此前出现 JSON 错误的场景，并固定每例十次', () => {
  const expectedNames = [
    'command-record',
    'context-manifest',
    'evidence',
    'json-validation-error',
    'release-decision',
    'result',
    'route-plan',
    'task-run',
  ].sort();
  assert.deepEqual(PRODUCTION_ALIGNED_LLM_SCENARIOS.map((item) => item.name).sort(), expectedNames);
  assert.equal(PRODUCTION_ALIGNED_LLM_SCENARIOS.length, 8);
  assert.equal(REPETITIONS_PER_CASE, 10);
  assert.equal(PRODUCTION_ALIGNED_LLM_SCENARIOS.length * 3 * REPETITIONS_PER_CASE, 240);
  for (const scenario of PRODUCTION_ALIGNED_LLM_SCENARIOS) {
    assert.equal(scenario.cases.length, 3);
    assert.ok(scenario.cases.every((testCase) => testCase.hostFixture !== undefined));
  }
});

test('宿主负责的哈希、提交与归档场景要求复制夹具，而非凭空生成', () => {
  const names = [
    'command-record',
    'context-manifest',
    'evidence',
    'json-validation-error',
    'release-decision',
    'result',
    'task-run',
  ];
  for (const name of names) {
    const scenario = PRODUCTION_ALIGNED_LLM_SCENARIOS.find((item) => item.name === name);
    assert.ok(scenario, `缺少 ${name} 场景`);
    const prompt = buildProductionAlignedLlmCasePrompt(scenario, scenario.cases[0], '{"type":"object"}');
    assert.match(prompt, /宿主提供的测试夹具/);
    assert.match(prompt, /逐字复制/);
    if (name === 'release-decision') assert.match(prompt, /"candidate_commit"/);
    else assert.match(prompt, /[a-f0-9]{64}/);
  }
});

test('无真实文件内容的证据夹具明确要求 sha256 为 null', () => {
  const scenario = PRODUCTION_ALIGNED_LLM_SCENARIOS.find((item) => item.name === 'evidence');
  const prompt = buildProductionAlignedLlmCasePrompt(scenario, scenario.cases[1], '{"type":"object"}');
  assert.match(prompt, /"sha256": null/);
  assert.match(prompt, /不得为不存在的文件或 Git 定位信息编造 SHA-256/);
});

test('命令记录夹具提供真实执行所需的全部必填事实', () => {
  const scenario = PRODUCTION_ALIGNED_LLM_SCENARIOS.find((item) => item.name === 'command-record');
  for (const testCase of scenario.cases) {
    const records = testCase.hostFixture.records;
    assert.ok(Array.isArray(records) && records.length >= 1);
    for (const record of records) {
      for (const field of ['command_record_id', 'executable', 'cwd_abs', 'started_at', 'finished_at', 'exit_code', 'timed_out', 'stdout_path_abs', 'stderr_path_abs', 'attempt', 'invoked_by_agent', 'task_id', 'run_id', 'isolation_mode']) {
        assert.ok(Object.hasOwn(record, field), `缺少 ${field}`);
      }
    }
  }
});
