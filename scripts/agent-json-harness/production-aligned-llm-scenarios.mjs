// A separate, production-aligned matrix.  The original free-generation
// scenarios remain in llm-scenarios.mjs unchanged for comparison.

import { LLM_SCENARIOS, REPETITIONS_PER_CASE } from './llm-scenarios.mjs';

const hash = (character) => character.repeat(64);

function commandRecord({ id, taskId, runId, startedAt, exitCode, timedOut, stdoutHash, stderrHash }) {
  return {
    command_record_id: id,
    executable: 'node',
    cwd_abs: 'C:/fixture/project',
    started_at: startedAt,
    finished_at: '2026-08-26T08:00:01Z',
    exit_code: exitCode,
    timed_out: timedOut,
    stdout_path_abs: `C:/fixture/artifacts/${id}.stdout.txt`,
    stderr_path_abs: `C:/fixture/artifacts/${id}.stderr.txt`,
    stdout_sha256: stdoutHash,
    stderr_sha256: stderrHash,
    attempt: 1,
    invoked_by_agent: 'developer-agent',
    task_id: taskId,
    run_id: runId,
    isolation_mode: 'UNSANDBOXED_LOCAL',
  };
}

const HOST_FIXTURES = {
  'command-record.schema.json': [
    { records: [commandRecord({ id: 'CMD-fixture-01', taskId: 'TASK-fixture-command-01', runId: 'RUN-fixture-command-01', startedAt: '2026-08-26T08:00:00Z', exitCode: 0, timedOut: false, stdoutHash: hash('a'), stderrHash: hash('b') })] },
    { records: [commandRecord({ id: 'CMD-fixture-02', taskId: 'TASK-fixture-command-02', runId: 'RUN-fixture-command-02', startedAt: '2026-08-26T08:01:00Z', exitCode: 1, timedOut: false, stdoutHash: hash('c'), stderrHash: hash('d') })] },
    { records: [commandRecord({ id: 'CMD-fixture-03a', taskId: 'TASK-fixture-command-03', runId: 'RUN-fixture-command-03', startedAt: '2026-08-26T08:02:00Z', exitCode: null, timedOut: true, stdoutHash: null, stderrHash: hash('e') }), commandRecord({ id: 'CMD-fixture-03b', taskId: 'TASK-fixture-command-03', runId: 'RUN-fixture-command-03', startedAt: '2026-08-26T08:02:02Z', exitCode: 0, timedOut: false, stdoutHash: hash('f'), stderrHash: hash('0') })] },
  ],
  'context-manifest.schema.json': [
    { workflow_id: 'WF-fixture-context-01', task_id: 'TASK-fixture-context-01', run_id: 'RUN-fixture-context-01', attempt: 1, created_at: '2026-08-26T08:00:00Z', target_project_root_abs: 'C:/fixture/project', worktree_path_abs: 'C:/fixture/worktrees/context-01', artifact_root_abs: 'C:/fixture/artifacts/context-01', input_files: [{ path_abs: 'C:/fixture/project/requirements.md', sha256: hash('1'), role: 'requirements' }], rule_version: 'fixture-rule-v1', rule_hash: hash('2'), input_commit: '0123456789abcdef0123456789abcdef01234567', expected_output_paths_abs: ['C:/fixture/artifacts/context-01/context.json'] },
    { workflow_id: 'WF-fixture-context-02', task_id: 'TASK-fixture-context-02', run_id: 'RUN-fixture-context-02', attempt: 2, created_at: '2026-08-26T08:01:00Z', target_project_root_abs: 'C:/fixture/project', worktree_path_abs: 'C:/fixture/worktrees/context-02', artifact_root_abs: 'C:/fixture/artifacts/context-02', input_files: [{ path_abs: 'C:/fixture/project/src/index.mjs', sha256: hash('3'), role: 'source' }], rule_version: 'fixture-rule-v1', rule_hash: hash('4'), input_commit: '1234567890abcdef1234567890abcdef12345678', expected_output_paths_abs: ['C:/fixture/artifacts/context-02/review.md'] },
    { workflow_id: 'WF-fixture-context-03', task_id: 'TASK-fixture-context-03', run_id: 'RUN-fixture-context-03', attempt: 1, created_at: '2026-08-26T08:02:00Z', target_project_root_abs: 'C:/fixture/project', worktree_path_abs: 'C:/fixture/worktrees/context-03', artifact_root_abs: 'C:/fixture/artifacts/context-03', input_files: [{ path_abs: 'C:/fixture/project/package.json', sha256: hash('5'), role: 'manifest' }, { path_abs: 'C:/fixture/project/README.md', sha256: hash('6'), role: 'documentation' }], rule_version: 'fixture-rule-v2', rule_hash: hash('7'), input_commit: null, expected_output_paths_abs: ['C:/fixture/artifacts/context-03/result.json', 'C:/fixture/artifacts/context-03/report.md'] },
  ],
  'evidence.schema.json': [
    { evidence_id: 'EVD-fixture-file-01', source_type: 'file', locator_abs: 'C:/fixture/project/requirements.md', git_locator: null, sha256: hash('8'), line_start: 1, line_end: 3, collected_at: '2026-08-26T08:03:00Z', collector: 'test-agent' },
    { evidence_id: 'EVD-fixture-git-02', source_type: 'git', locator_abs: null, git_locator: '0123456789abcdef0123456789abcdef01234567:README.md', sha256: null, line_start: null, line_end: null, collected_at: '2026-08-26T08:04:00Z', collector: 'test-agent' },
    { evidence_id: 'EVD-fixture-command-03', source_type: 'command', locator_abs: 'C:/fixture/artifacts/CMD-fixture-03.stdout.txt', git_locator: null, sha256: hash('9'), line_start: null, line_end: null, collected_at: '2026-08-26T08:05:00Z', collector: 'test-agent', command_record_id: 'CMD-fixture-03' },
  ],
  'json-validation-error.schema.json': [
    { timestamp: '2026-08-26T08:06:00Z', stage: 'local_output_ingestion', agent_id: 'test-agent', workflow_id: 'WF-fixture-error-01', task_id: 'TASK-fixture-error-01', run_id: 'RUN-fixture-error-01', attempt: 1, file_path_abs: 'C:/fixture/artifacts/error-01.json', schema_path_abs: 'C:/fixture/contracts/result.schema.json', validator: 'ajv', validator_errors: [{ code: 'SCHEMA_REQUIRED', path: '$', message: 'must have required property artifact_manifest_hash' }], invalid_content_sha256: hash('a'), invalid_content_excerpt: '{}', retry_count: 0, retry_prompt_path_abs: 'C:/fixture/artifacts/error-01.retry.md', final_status: 'FAILED' },
    { timestamp: '2026-08-26T08:07:00Z', stage: 'manager_receive', agent_id: 'test-agent', workflow_id: 'WF-fixture-error-02', task_id: 'TASK-fixture-error-02', run_id: 'RUN-fixture-error-02', attempt: 2, file_path_abs: 'C:/fixture/artifacts/error-02.json', schema_path_abs: 'C:/fixture/contracts/context-manifest.schema.json', validator: 'ajv', validator_errors: [{ code: 'SCHEMA_PATTERN', path: '/rule_hash', message: 'must match pattern' }], invalid_content_sha256: hash('b'), invalid_content_excerpt: '{"rule_hash":"bad"}', retry_count: 1, retry_prompt_path_abs: 'C:/fixture/artifacts/error-02.retry.md', final_status: 'RETRY_SUCCEEDED' },
    { timestamp: '2026-08-26T08:08:00Z', stage: 'gate', agent_id: 'test-agent', workflow_id: 'WF-fixture-error-03', task_id: 'TASK-fixture-error-03', run_id: 'RUN-fixture-error-03', attempt: 3, file_path_abs: 'C:/fixture/artifacts/error-03.jsonl', schema_path_abs: 'C:/fixture/contracts/command-record.schema.json', validator: 'ajv', validator_errors: [{ code: 'SCHEMA_TYPE', path: '/attempt', message: 'must be integer' }], invalid_content_sha256: hash('c'), invalid_content_excerpt: '{"attempt":"one"}', retry_count: 2, retry_prompt_path_abs: null, final_status: 'RETRY_FAILED' },
  ],
  'release-decision.schema.json': [
    { workflow_id: 'WF-fixture-release-01', task_id: 'TASK-fixture-release-01', run_id: 'RUN-fixture-release-01', candidate_commit: '0123456789abcdef0123456789abcdef01234567', evaluated_at: '2026-08-26T08:09:00Z', evidence_refs: ['EVD-fixture-release-01'] },
    { workflow_id: 'WF-fixture-release-02', task_id: 'TASK-fixture-release-02', run_id: 'RUN-fixture-release-02', candidate_commit: '1234567890abcdef1234567890abcdef12345678', evaluated_at: '2026-08-26T08:10:00Z', evidence_refs: ['EVD-fixture-release-02'] },
    { workflow_id: 'WF-fixture-release-03', task_id: 'TASK-fixture-release-03', run_id: 'RUN-fixture-release-03', candidate_commit: '2345678901abcdef2345678901abcdef23456789', evaluated_at: '2026-08-26T08:11:00Z', evidence_refs: ['EVD-fixture-release-03'] },
  ],
  'result.schema.json': [
    { workflow_id: 'WF-fixture-result-01', task_id: 'TASK-fixture-result-01', run_id: 'RUN-fixture-result-01', agent_id: 'developer-agent', attempt: 1, started_at: '2026-08-26T08:12:00Z', finished_at: '2026-08-26T08:12:01Z', worktree_path_abs: 'C:/fixture/worktrees/result-01', artifact_root_abs: 'C:/fixture/artifacts/result-01', input_commit: '0123456789abcdef0123456789abcdef01234567', output_commit: null, isolation_mode: 'UNSANDBOXED_LOCAL', artifact_manifest_hash: hash('d') },
    { workflow_id: 'WF-fixture-result-02', task_id: 'TASK-fixture-result-02', run_id: 'RUN-fixture-result-02', agent_id: 'developer-agent', attempt: 1, started_at: '2026-08-26T08:13:00Z', finished_at: '2026-08-26T08:13:01Z', worktree_path_abs: 'C:/fixture/worktrees/result-02', artifact_root_abs: 'C:/fixture/artifacts/result-02', input_commit: '1234567890abcdef1234567890abcdef12345678', output_commit: null, isolation_mode: 'UNSANDBOXED_LOCAL', artifact_manifest_hash: hash('e') },
    { workflow_id: 'WF-fixture-result-03', task_id: 'TASK-fixture-result-03', run_id: 'RUN-fixture-result-03', agent_id: 'developer-agent', attempt: 2, started_at: '2026-08-26T08:14:00Z', finished_at: '2026-08-26T08:14:01Z', worktree_path_abs: 'C:/fixture/worktrees/result-03', artifact_root_abs: 'C:/fixture/artifacts/result-03', input_commit: null, output_commit: null, isolation_mode: 'UNSANDBOXED_LOCAL', artifact_manifest_hash: hash('f') },
  ],
  'task-run.schema.json': [
    { workflow_id: 'WF-fixture-task-run-01', task_id: 'TASK-fixture-task-run-01', run_id: 'RUN-fixture-task-run-01', archived_at: '2026-08-26T08:15:00Z', archived_state_revision: 1, task_snapshot_sha256: hash('0'), task_snapshot: { task_id: 'TASK-fixture-task-run-01', status: 'COMPLETED' } },
    { workflow_id: 'WF-fixture-task-run-02', task_id: 'TASK-fixture-task-run-02', run_id: 'RUN-fixture-task-run-02', archived_at: '2026-08-26T08:16:00Z', archived_state_revision: 2, task_snapshot_sha256: hash('1'), task_snapshot: { task_id: 'TASK-fixture-task-run-02', status: 'RETRYING' } },
    { workflow_id: 'WF-fixture-task-run-03', task_id: 'TASK-fixture-task-run-03', run_id: 'RUN-fixture-task-run-03', archived_at: '2026-08-26T08:17:00Z', archived_state_revision: 3, task_snapshot_sha256: hash('2'), task_snapshot: { task_id: 'TASK-fixture-task-run-03', status: 'BLOCKED' } },
  ],
};

const PREVIOUS_FAILURE_SCHEMA_FILES = new Set([
  'command-record.schema.json',
  'context-manifest.schema.json',
  'evidence.schema.json',
  'json-validation-error.schema.json',
  'release-decision.schema.json',
  'result.schema.json',
  'route-plan.schema.json',
  'task-run.schema.json',
]);

function productionCase(schemaFile, testCase, index) {
  return { ...testCase, hostFixture: HOST_FIXTURES[schemaFile]?.[index] ?? null };
}

export const PRODUCTION_ALIGNED_LLM_SCENARIOS = LLM_SCENARIOS
  .filter((scenario) => PREVIOUS_FAILURE_SCHEMA_FILES.has(scenario.schemaFile))
  .map((scenario) => ({
    ...scenario,
    cases: scenario.cases.map((testCase, index) => productionCase(scenario.schemaFile, testCase, index)),
  }));

export { REPETITIONS_PER_CASE };

export function buildProductionAlignedLlmCasePrompt(scenario, testCase, schemaText) {
  const format = scenario.jsonl ? 'JSONL，每一行是一个完整 JSON 对象' : '一个 JSON 对象';
  const fixtureBlock = testCase.hostFixture === null
    ? '本用例没有宿主生成的哈希、提交号或归档快照；不得为不存在的外部事实补造这些值。'
    : [
      '以下是宿主提供的测试夹具，代表本次运行已生成或已观察到的真实上下文。它不是要你查询的外部事实。',
      '凡夹具中出现的标识、路径、时间、SHA-256、提交号、快照或审计字段，必须逐字复制到适用的输出字段；不得自行计算、截断、替换或编造。',
      '特别地，夹具中的 null 必须保持为 JSON null；不得为不存在的文件或 Git 定位信息编造 SHA-256。',
      scenario.jsonl && Array.isArray(testCase.hostFixture.records) ? '夹具的 records 数组表示已完成的命令记录：数组中每个对象必须原样作为一行 JSONL 输出，不要输出 records 包装对象。' : '',
      '```json', JSON.stringify(testCase.hostFixture, null, 2), '```',
    ].join('\n');
  return [
    '这是自动化 JSON 生成与清洗工作流测试，旨在验证 Schema 输出、确定性清洗和失败修复重试是否正常。',
    '不要调用任何工具，不要读取或写入文件，不要分析或执行任务。',
    `请仅回复 ${format}，不要使用 Markdown 代码块、解释、前后缀、确认语或任何其他内容。`,
    `业务需求：${testCase.requirement}`,
    `语言偏好：${testCase.language}。`,
    `固定测试用例：${testCase.id}（变体 ${testCase.variation}，主题：${testCase.topic}）。`,
    '', fixtureBlock, '',
    '以下是唯一有效的 JSON Schema。不得复制项目模板；除宿主夹具明确给出的事实外，不得虚构命令、证据、提交、审批或外部事实。',
    '```json', schemaText, '```',
  ].join('\n');
}
