import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = '2026-08-05T08:00:00.000Z';
const WORKFLOW_ID = 'WF-task-kernel-test';
const AGENT = 'developer-agent';
const hex = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'task-kernel-'));
  const artifact = join(directory, 'artifacts');
  const output = join(artifact, 'output');
  const worktree = join(directory, 'worktree');
  mkdirSync(output, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const database = openControlDatabase(join(directory, 'control.db'));
  const controls = createControlRepository(ROOT, database);
  controls.apply({
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: WORKFLOW_ID,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent', occurred_at: NOW,
    reason: 'task tests', payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
  });
  const input = join(directory, 'requirements.md');
  writeFileSync(input, '# requirements\n');
  const manifestPath = join(artifact, 'context-manifest.json');
  const paths = {
    result: join(output, 'result.json'), evidence: join(output, 'evidence.jsonl'), commands: join(output, 'command-records.jsonl'),
  };
  const task = {
    schema_version: 1, output_contract_version: 1, workflow_id: WORKFLOW_ID,
    task_id: 'TASK-task-kernel-test', run_id: 'RUN-task-kernel-test', parent_task_id: null,
    task_type: 'DEVELOPMENT', assigned_agent: AGENT, title: 'Implement feature', status: 'CREATED',
    dependencies: [], acceptance_criteria_ids: [], attempt: 1, max_attempts: 2,
    worktree_path_abs: worktree, artifact_root_abs: artifact, context_manifest_path_abs: manifestPath,
    allowed_write_paths_abs: [worktree], forbidden_paths_abs: [],
    structured_outputs: [
      { path_abs: paths.result, schema_path_abs: join(ROOT, 'contracts', 'result.schema.json'), format: 'json', required: true, producer: AGENT },
      { path_abs: paths.evidence, schema_path_abs: join(ROOT, 'contracts', 'evidence.schema.json'), format: 'jsonl', required: true, producer: AGENT },
      { path_abs: paths.commands, schema_path_abs: join(ROOT, 'contracts', 'command-record.schema.json'), format: 'jsonl', required: true, producer: AGENT },
    ],
    created_at: NOW, updated_at: NOW,
  };
  const manifest = {
    schema_version: 1, workflow_id: WORKFLOW_ID, task_id: task.task_id, run_id: task.run_id,
    assigned_agent: AGENT, created_at: NOW, target_project_root_abs: worktree,
    worktree_path_abs: worktree, artifact_root_abs: artifact,
    input_files: [{ path_abs: input, sha256: hex(input), role: 'requirements' }],
    rule_version: '1', rule_hash: 'b'.repeat(64), expected_output_paths_abs: Object.values(paths),
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const tasks = createTaskRepository(ROOT, database);
  return { directory, database, tasks, task, paths, manifestPath, close() { database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function intent(value) {
  const dispatchId = 'DSP-task-kernel-test';
  return {
    schema_version: 1, record_type: 'DISPATCH_INTENT', dispatch_id: dispatchId,
    idempotency_key: `${WORKFLOW_ID}/${value.task.task_id}/${value.task.run_id}/${AGENT}/1`,
    workflow_id: WORKFLOW_ID, task_id: value.task.task_id, run_id: value.task.run_id, agent_id: AGENT, attempt: 1,
    task_file_abs: join(value.directory, 'task.json'), input_manifest_path_abs: value.manifestPath,
    input_manifest_sha256: hex(value.manifestPath), session_key: 'agent:developer:task-kernel',
    lease_started_at: NOW, lease_deadline: '2026-08-05T09:00:00.000Z', retry_count: 0, max_retries: 1,
    created_at: '2026-08-05T08:01:00.000Z', status: 'PREPARED',
  };
}

function receipt(dispatch, status, id, at) {
  return {
    schema_version: 1, record_type: 'DISPATCH_RECEIPT', receipt_id: id,
    dispatch_id: dispatch.dispatch_id, idempotency_key: dispatch.idempotency_key,
    workflow_id: dispatch.workflow_id, task_id: dispatch.task_id, run_id: dispatch.run_id,
    agent_id: dispatch.agent_id, attempt: dispatch.attempt, status,
    session_key: dispatch.session_key, session_id: 'session-123', lease_deadline: dispatch.lease_deadline,
    input_manifest_sha256: dispatch.input_manifest_sha256, recorded_at: at,
  };
}

function writeValidOutputs(value, resultStatus = 'COMPLETED') {
  const result = {
    schema_version: 1, workflow_id: WORKFLOW_ID, task_id: value.task.task_id, run_id: value.task.run_id,
    agent_id: AGENT, role: 'developer', attempt: 1, started_at: NOW, finished_at: '2026-08-05T08:10:00.000Z',
    result_status: resultStatus, summary_for_user: 'done', summary_for_manager: 'done',
    worktree_path_abs: value.task.worktree_path_abs, artifact_root_abs: value.task.artifact_root_abs,
    isolation_mode: 'UNSANDBOXED_LOCAL', self_validation: { preflight_passed: true, checks: [{ name: 'test', status: 'PASS' }] },
  };
  writeFileSync(value.paths.result, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(value.paths.evidence, `${JSON.stringify({ evidence_id: 'EVD-1', source_type: 'file', collected_at: NOW, collector: AGENT })}\n`);
  writeFileSync(value.paths.commands, `${JSON.stringify({ command_record_id: 'CR-1', executable: 'node', cwd_abs: value.task.worktree_path_abs,
    started_at: NOW, finished_at: NOW, exit_code: 0, timed_out: false, stdout_path_abs: join(value.directory, 'stdout'),
    stderr_path_abs: join(value.directory, 'stderr'), attempt: 1, invoked_by_agent: AGENT, task_id: value.task.task_id,
    run_id: value.task.run_id, isolation_mode: 'UNSANDBOXED_LOCAL' })}\n`);
  return result;
}

function complete(value, dispatch, overrides = {}) {
  return {
    schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: `CMP-${randomUUID()}`,
    dispatch_id: dispatch.dispatch_id, idempotency_key: dispatch.idempotency_key,
    workflow_id: dispatch.workflow_id, task_id: dispatch.task_id, run_id: dispatch.run_id,
    agent_id: dispatch.agent_id, attempt: dispatch.attempt, status: 'SUCCEEDED',
    session_key: dispatch.session_key, session_id: 'session-123', result_path_abs: value.paths.result,
    result_sha256: hex(value.paths.result), error_code: null, error_message: null,
    completed_at: '2026-08-05T08:11:00.000Z', ...overrides,
  };
}

function readyAndRunning(value) {
  value.tasks.register(value.task);
  const checked = value.tasks.validatePackage(value.task.task_id, '2026-08-05T08:00:30.000Z');
  assert.equal(checked.task.status, 'READY');
  const dispatch = intent(value);
  const prepared = value.tasks.prepareDispatch(dispatch);
  assert.equal(prepared.task.status, 'DISPATCHED');
  assert.equal(value.tasks.outbox().length, 1);
  value.tasks.recordReceipt(receipt(dispatch, 'SENT', 'DRC-sent', '2026-08-05T08:02:00.000Z'));
  value.tasks.recordReceipt(receipt(dispatch, 'ACKNOWLEDGED', 'DRC-ack', '2026-08-05T08:02:30.000Z'));
  const running = value.tasks.recordReceipt(receipt(dispatch, 'RUNNING', 'DRC-running', '2026-08-05T08:03:00.000Z'));
  assert.equal(running.task.status, 'RUNNING');
  assert.equal(value.tasks.outbox().length, 0);
  return dispatch;
}

test('task control closes registration, package validation, dispatch and result ingestion', () => {
  const value = setup();
  try {
    const dispatch = readyAndRunning(value);
    writeValidOutputs(value);
    const completion = complete(value, dispatch);
    const ingested = value.tasks.ingestCompletion(completion);
    assert.equal(ingested.task.status, 'COMPLETED');
    assert.equal(value.tasks.get(value.task.task_id).status, 'COMPLETED');
    assert.equal(value.tasks.dispatches(value.task.task_id)[0].status, 'SUCCEEDED');
    rmSync(value.paths.result);
    assert.equal(value.tasks.ingestCompletion(completion).idempotent_replay, true);
  } finally { value.close(); }
});

test('task cannot become COMPLETED when a required structured output is missing', () => {
  const value = setup();
  try {
    const dispatch = readyAndRunning(value);
    writeValidOutputs(value);
    rmSync(value.paths.evidence);
    assert.throws(() => value.tasks.ingestCompletion(complete(value, dispatch)),
      (error) => error.code === 'TASK_REQUIRED_OUTPUT_MISSING');
    assert.equal(value.tasks.get(value.task.task_id).status, 'RUNNING');
    assert.equal(value.tasks.dispatches(value.task.task_id)[0].status, 'RUNNING');
  } finally { value.close(); }
});

test('dispatch preparation is idempotent and does not create a second spawn intent', () => {
  const value = setup();
  try {
    value.tasks.register(value.task);
    value.tasks.validatePackage(value.task.task_id);
    const dispatch = intent(value);
    const first = value.tasks.prepareDispatch(dispatch);
    const replay = value.tasks.prepareDispatch(dispatch);
    assert.equal(first.idempotent_replay, false);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(value.tasks.dispatches(value.task.task_id).length, 1);
    assert.equal(value.tasks.outbox().length, 1);
  } finally { value.close(); }
});
