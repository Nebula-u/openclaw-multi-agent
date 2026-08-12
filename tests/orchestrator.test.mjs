import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import {
  outputIngestionFailureReceiptPath,
  stagedOutputPath,
  validationFailureLogPath,
} from '../scripts/runtime-core/structured-output-ingestion.mjs';
import { reconcileDispatch, resolveExecutionPolicy, startReadyTask } from '../scripts/orchestrator/service.mjs';
import { openClawCommand, openClawSpawnSpec, terminateProcessTree, validateAgentTimeoutSeconds } from '../scripts/orchestrator/agent-process.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = '2026-08-07T03:00:00.000Z';
const WORKFLOW_ID = 'WF-orchestrator-test';
const AGENT = 'developer-agent';
const hex = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orchestrator-'));
  const artifact = join(directory, 'artifacts'); const output = join(artifact, 'output'); const worktree = join(directory, 'worktree');
  mkdirSync(join(artifact, '.agent-raw', 'output'), { recursive: true }); mkdirSync(output, { recursive: true }); mkdirSync(worktree, { recursive: true });
  const databasePath = join(directory, 'control.db'); const database = openControlDatabase(databasePath);
  createControlRepository(ROOT, database).apply({ schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: WORKFLOW_ID,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent', occurred_at: NOW, reason: 'orchestrator test',
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) } });
  const input = join(directory, 'requirements.md'); writeFileSync(input, '# requirements\n');
  const manifestPath = join(artifact, 'context-manifest.json');
  const paths = { result: join(output, 'result.json'), evidence: join(output, 'evidence.jsonl'), commands: join(output, 'command-records.jsonl') };
  const task = { schema_version: 1, output_contract_version: 1, output_ingestion_mode: 'LOCAL_STAGED', workflow_id: WORKFLOW_ID,
    task_id: 'TASK-orchestrator-test', run_id: 'RUN-orchestrator-test', parent_task_id: null, task_type: 'DEVELOPMENT', assigned_agent: AGENT,
    title: 'Controlled worker execution', status: 'CREATED', dependencies: [], acceptance_criteria_ids: [], attempt: 1, max_attempts: 2,
    worktree_path_abs: worktree, artifact_root_abs: artifact, context_manifest_path_abs: manifestPath, allowed_write_paths_abs: [worktree], forbidden_paths_abs: [],
    structured_outputs: [
      { path_abs: paths.result, schema_path_abs: join(ROOT, 'contracts', 'result.schema.json'), format: 'json', required: true, producer: AGENT },
      { path_abs: paths.evidence, schema_path_abs: join(ROOT, 'contracts', 'evidence.schema.json'), format: 'jsonl', required: true, producer: AGENT },
      { path_abs: paths.commands, schema_path_abs: join(ROOT, 'contracts', 'command-record.schema.json'), format: 'jsonl', required: true, producer: AGENT },
    ], created_at: NOW, updated_at: NOW };
  const manifest = { schema_version: 1, workflow_id: WORKFLOW_ID, task_id: task.task_id, run_id: task.run_id, assigned_agent: AGENT,
    created_at: NOW, target_project_root_abs: worktree, worktree_path_abs: worktree, artifact_root_abs: artifact,
    input_files: [{ path_abs: input, sha256: hex(input), role: 'requirements' }], rule_version: '1', rule_hash: 'b'.repeat(64), expected_output_paths_abs: Object.values(paths) };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const tasks = createTaskRepository(ROOT, database); tasks.register(task); tasks.validatePackage(task.task_id, NOW); database.close();
  return { directory, databasePath, task, paths, close() { rmSync(directory, { recursive: true, force: true }); } };
}

function writeWorkerRaw(value) {
  const result = { schema_version: 1, workflow_id: WORKFLOW_ID, task_id: value.task.task_id, run_id: value.task.run_id, agent_id: AGENT,
    role: 'developer', attempt: 1, started_at: NOW, finished_at: NOW, result_status: value.resultStatus ?? 'COMPLETED', summary_for_user: 'done', summary_for_manager: 'done',
    ...(value.resultStatus === 'HUMAN_DECISION_REQUIRED' ? { decisions_required: [{ trigger: 'IMPLEMENTATION_TRADEOFF', summary: '是否继续演示路径', options: [{ option_id: 'PROCEED', description: '继续', impact: '继续执行', reversibility: 'reversible' }] }] } : {}),
    worktree_path_abs: value.task.worktree_path_abs, artifact_root_abs: value.task.artifact_root_abs, isolation_mode: 'UNSANDBOXED_LOCAL',
    self_validation: { preflight_passed: true, checks: [{ name: 'test', status: 'PASS' }] } };
  const output = (path) => value.task.structured_outputs.find((item) => item.path_abs === path);
  writeFileSync(stagedOutputPath(value.task, output(value.paths.result)), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(stagedOutputPath(value.task, output(value.paths.evidence)), `${JSON.stringify({ evidence_id: 'EVD-orchestrator', source_type: 'file', collected_at: NOW, collector: AGENT })}\n`);
  writeFileSync(stagedOutputPath(value.task, output(value.paths.commands)), `${JSON.stringify({ command_record_id: 'CR-orchestrator', executable: 'node', cwd_abs: value.task.worktree_path_abs,
    started_at: NOW, finished_at: NOW, exit_code: 0, timed_out: false, stdout_path_abs: join(value.directory, 'stdout'), stderr_path_abs: join(value.directory, 'stderr'),
    attempt: 1, invoked_by_agent: AGENT, task_id: value.task.task_id, run_id: value.task.run_id, isolation_mode: 'UNSANDBOXED_LOCAL' })}\n`);
}

async function dispatchAndReconcile(value, runner) {
  const started = await startReadyTask({
    projectRoot: ROOT,
    databasePath: value.databasePath,
    taskId: value.task.task_id,
    uuid: (() => { let valueIndex = 30; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
    runner,
  });
  if (!started.ok) return started;
  return reconcileDispatch({
    projectRoot: ROOT,
    databasePath: value.databasePath,
    dispatchId: started.dispatch_id,
    uuid: (() => { let valueIndex = 40; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
  });
}

test('execution policy rejects timeout or lease values above the five-minute small-project ceiling', () => {
  assert.deepEqual(resolveExecutionPolicy(ROOT, 'ARCHITECTURE'), { timeoutSeconds: 300, leaseSeconds: 300 });
  assert.throws(
    () => resolveExecutionPolicy(ROOT, 'ARCHITECTURE', { timeoutSeconds: 301 }),
    (error) => error.code === 'ORCHESTRATOR_EXECUTION_POLICY_INVALID',
  );
  assert.throws(
    () => resolveExecutionPolicy(ROOT, 'ARCHITECTURE', { leaseSeconds: 301 }),
    (error) => error.code === 'ORCHESTRATOR_EXECUTION_POLICY_INVALID',
  );
  assert.throws(() => validateAgentTimeoutSeconds(301), /between 1 and 300 seconds/u);
});

test('local Orchestrator derives worker, session, receipts and completion from one READY task', async () => {
  const value = setup();
  try {
    let request;
    const started = await startReadyTask({ projectRoot: ROOT, databasePath: value.databasePath, taskId: value.task.task_id,
      uuid: (() => { let valueIndex = 0; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
      runner: async (input) => {
        request = input;
        writeWorkerRaw(value);
        writeFileSync(input.launcher.stdout_path_abs, '{"ok":true,"response":"done"}');
        writeFileSync(input.launcher.stderr_path_abs, '');
        writeFileSync(input.launcher.result_path_abs, JSON.stringify({ schema_version: 1, state: 'SUCCEEDED', exit_code: 0, signal: null, timed_out: false, started_at: NOW, finished_at: NOW }));
        return { started: true, launcher_pid: 1234 };
      },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    const result = reconcileDispatch({
      projectRoot: ROOT,
      databasePath: value.databasePath,
      dispatchId: started.dispatch_id,
      uuid: (() => { let valueIndex = 5; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(request.agentId, AGENT);
    assert.equal(request.timeoutSeconds, 300);
    assert.match(request.messagePath, /\.orchestrator/u);
    const launcher = JSON.parse(readFileSync(started.launcher.launcher_path_abs, 'utf8'));
    assert.equal(launcher.timeout_seconds, 300);
    assert.equal(launcher.lease_seconds, 300);
    const database = openControlDatabase(value.databasePath);
    try {
      const tasks = createTaskRepository(ROOT, database);
      assert.equal(tasks.get(value.task.task_id).status, 'COMPLETED');
      assert.equal(tasks.dispatches(value.task.task_id)[0].status, 'SUCCEEDED');
      assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database)));
    } finally { database.close(); }
    assert.equal(readFileSync(value.paths.result, 'utf8').includes('"result_status": "COMPLETED"'), true);
  } finally { value.close(); }
});

test('asynchronous dispatch returns before the worker completes and reconciliation closes the original dispatch', async () => {
  const value = setup();
  try {
    let launcherInput;
    const started = await startReadyTask({
      projectRoot: ROOT,
      databasePath: value.databasePath,
      taskId: value.task.task_id,
      uuid: (() => { let valueIndex = 10; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
      runner: async (input) => {
        launcherInput = input;
        writeWorkerRaw(value);
        writeFileSync(input.launcher.stdout_path_abs, '{"ok":true}\n');
        writeFileSync(input.launcher.stderr_path_abs, '');
        writeFileSync(input.launcher.status_path_abs, JSON.stringify({ state: 'RUNNING' }));
        writeFileSync(input.launcher.result_path_abs, JSON.stringify({
          schema_version: 1, state: 'SUCCEEDED', exit_code: 0, signal: null, timed_out: false,
          finished_at: NOW,
        }));
        return { started: true, launcher_pid: 1234 };
      },
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.status, 'STARTED');
    assert.equal(started.task.status, 'DISPATCHED');
    assert.ok(launcherInput?.launcher.result_path_abs);

    const reconciled = reconcileDispatch({
      projectRoot: ROOT,
      databasePath: value.databasePath,
      dispatchId: started.dispatch_id,
      uuid: (() => { let valueIndex = 20; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
    });
    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.status, 'SUCCEEDED');
    assert.equal(reconciled.task.status, 'COMPLETED');
  } finally { value.close(); }
});

test('legacy dispatch without launcher evidence stays recoverable instead of fabricating completion or failure', async () => {
  const value = setup();
  try {
    const started = await startReadyTask({
      projectRoot: ROOT,
      databasePath: value.databasePath,
      taskId: value.task.task_id,
      uuid: (() => { let valueIndex = 50; return () => `00000000-0000-4000-8000-${String(++valueIndex).padStart(12, '0')}`; })(),
      runner: async () => ({ started: true, launcher_pid: 1234 }),
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    rmSync(started.launcher.launcher_path_abs);
    const recovered = reconcileDispatch({ projectRoot: ROOT, databasePath: value.databasePath, dispatchId: started.dispatch_id });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.status, 'RECOVERY_REQUIRED');
    assert.equal(recovered.recovery.code, 'ORCHESTRATOR_LAUNCHER_METADATA_MISSING');
    const database = openControlDatabase(value.databasePath);
    try {
      const tasks = createTaskRepository(ROOT, database);
      assert.equal(tasks.get(value.task.task_id).status, 'DISPATCHED');
      assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database)));
    } finally { database.close(); }
  } finally { value.close(); }
});

test('Windows OpenClaw execution resolves the explicit cmd launcher', () => {
  if (process.platform !== 'win32') return;
  const command = openClawCommand();
  assert.equal(command.file, process.env.ComSpec || 'cmd.exe');
  assert.equal(command.executable, process.env.OPENCLAW_COMMAND || 'openclaw.cmd');
  assert.equal(command.shell, false);
  const spec = openClawSpawnSpec(['--version']);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.options.windowsVerbatimArguments, true);
});

test('Windows timeout termination targets the complete process tree', () => {
  let call;
  const result = terminateProcessTree(4321, { platform: 'win32', run: (file, args, options) => {
    call = { file, args, options };
    return { status: 0, error: null };
  } });
  assert.equal(result.ok, true);
  assert.equal(call.file, 'taskkill.exe');
  assert.deepEqual(call.args, ['/PID', '4321', '/T', '/F']);
  assert.equal(call.options.shell, false);
});

test('HUMAN_DECISION_REQUIRED creates a v2 PENDING approval and pauses both task and workflow', async () => {
  const value = setup();
  try {
    const result = await dispatchAndReconcile(value, async (input) => {
      writeWorkerRaw({ ...value, resultStatus: 'HUMAN_DECISION_REQUIRED' });
      writeFileSync(input.launcher.stdout_path_abs, '{"ok":true}');
      writeFileSync(input.launcher.stderr_path_abs, '');
      writeFileSync(input.launcher.result_path_abs, JSON.stringify({ schema_version: 1, state: 'SUCCEEDED', exit_code: 0, signal: null, timed_out: false, finished_at: NOW }));
      return { started: true, launcher_pid: 1234 };
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.requires_human_approval, true);
    const database = openControlDatabase(value.databasePath);
    try {
      const controls = createControlRepository(ROOT, database);
      const tasks = createTaskRepository(ROOT, database);
      assert.equal(controls.get(WORKFLOW_ID).condition, 'WAITING_HUMAN');
      assert.equal(controls.approvals({ status: 'PENDING' }).length, 1);
      assert.equal(tasks.get(value.task.task_id).status, 'WAITING_HUMAN');
      const pending = controls.approvals({ status: 'PENDING' })[0];
      const response = { schema_version: 1, decision_id: pending.decision_id, workflow_id: WORKFLOW_ID,
        task_id: value.task.task_id, run_id: value.task.run_id, outcome: 'APPROVED', chosen_option_id: 'PROCEED',
        raw_user_reply_summary: '批准继续', decided_by: 'human:test', decided_at: '2026-08-07T03:01:00.000Z', notes: '' };
      controls.resolveApproval(response);
      tasks.resumeHumanTask({ task_id: value.task.task_id, decision_id: response.decision_id,
        outcome: response.outcome, occurred_at: response.decided_at });
      assert.equal(tasks.get(value.task.task_id).status, 'COMPLETED');
      assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database)));
    } finally { database.close(); }
  } finally { value.close(); }
});

test('unsupported Gateway response becomes a durable local failure rather than a fabricated receipt', async () => {
  const value = setup();
  try {
    const result = await dispatchAndReconcile(value, async (input) => {
      writeFileSync(input.launcher.stdout_path_abs, '{"unrecognized":true}');
      writeFileSync(input.launcher.stderr_path_abs, '');
      writeFileSync(input.launcher.result_path_abs, JSON.stringify({ schema_version: 1, state: 'SUCCEEDED', exit_code: 0, signal: null, timed_out: false, finished_at: NOW }));
      return { started: true, launcher_pid: 1234 };
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ORCHESTRATOR_GATEWAY_RESPONSE_UNSUPPORTED');
    const database = openControlDatabase(value.databasePath);
    try {
      const tasks = createTaskRepository(ROOT, database);
      assert.equal(tasks.get(value.task.task_id).status, 'FAILED');
      assert.equal(tasks.dispatches(value.task.task_id)[0].status, 'FAILED');
      assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database)));
    } finally { database.close(); }
  } finally { value.close(); }
});

test('a local spawn ENOENT failure without an Agent receipt passes the control audit', async () => {
  const value = setup();
  try {
    const result = await dispatchAndReconcile(value, async () => {
      const error = new Error('spawn openclaw ENOENT');
      error.code = 'ENOENT';
      throw error;
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ENOENT');
    const database = openControlDatabase(value.databasePath);
    try {
      const tasks = createTaskRepository(ROOT, database);
      assert.equal(tasks.get(value.task.task_id).status, 'FAILED');
      assert.equal(tasks.dispatches(value.task.task_id)[0].status, 'FAILED');
      assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database)));
    } finally { database.close(); }
  } finally { value.close(); }
});

test('invalid staged JSON is preserved and recorded by local ingestion before the task fails', async () => {
  const value = setup();
  try {
    const resultOutput = value.task.structured_outputs.find((output) => output.path_abs === value.paths.result);
    const rawPath = stagedOutputPath(value.task, resultOutput);
    writeFileSync(rawPath, '{"schema_version": 1, "token": "secret-value",', 'utf8');
    const result = await dispatchAndReconcile(value, async (input) => {
      writeFileSync(input.launcher.stdout_path_abs, '{"ok":true}');
      writeFileSync(input.launcher.stderr_path_abs, '');
      writeFileSync(input.launcher.result_path_abs, JSON.stringify({ schema_version: 1, state: 'SUCCEEDED', exit_code: 0, signal: null, timed_out: false, finished_at: NOW }));
      return { started: true, launcher_pid: 1234 };
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'TASK_OUTPUT_INGESTION_INVALID');
    assert.equal(readFileSync(rawPath, 'utf8'), '{"schema_version": 1, "token": "secret-value",');
    const failure = JSON.parse(readFileSync(outputIngestionFailureReceiptPath(value.task, resultOutput), 'utf8'));
    assert.equal(failure.record_type, 'STRUCTURED_OUTPUT_INGESTION_FAILURE');
    assert.equal(failure.failure_code, 'TASK_OUTPUT_INGESTION_INVALID');
    assert.equal(failure.validation_error.stage, 'local_output_ingestion');
    assert.equal(failure.validation_error.invalid_content_excerpt.includes('secret-value'), false);
    assert.equal(failure.validation_error.invalid_content_excerpt.includes('<REDACTED>'), true);
    const lines = readFileSync(validationFailureLogPath(value.task), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].validator_errors[0].code, 'JSON_PARSE_ERROR');
    const database = openControlDatabase(value.databasePath);
    try { assert.equal(auditControlDatabase(database).ok, true, JSON.stringify(auditControlDatabase(database))); }
    finally { database.close(); }
  } finally { value.close(); }
});
