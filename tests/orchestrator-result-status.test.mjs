import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { ingestTaskOutput } from '../scripts/orchestrator/output-ingestion.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function field(message, name) {
  return message.match(new RegExp(`^- ${name}: (.+)$`, 'mu'))?.[1] ?? null;
}

function testRoute(workflowId) {
  return {
    schema_version: 1, workflow_id: workflowId, request_class: 'TEST_ONLY', summary: 'Run the assigned tests.', display_title: 'Tests', risk_flags: [],
    steps: [{ step_id: 'test', kind: 'TEST', title: 'Run tests', rationale: 'Verify the assigned repository.', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required for this test-only workflow.' })),
  };
}

async function createTestWorkflow(t, { runner, testSandboxStager }) {
  const workflowId = `WF-TestSandbox-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runtimeRoot = join(ROOT, 'runtime', 'test-sandbox-workflows', workflowId);
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => {
    database.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const orchestrator = createOrchestrator({
    projectRoot: ROOT, runtimeRoot, database, runner, testSandboxStager,
    worktrees: {
      inspectTarget(targetProjectRootAbs) { return { targetProjectRootAbs, headCommit: '1'.repeat(40) }; },
      prepare() { return { worktreePathAbs: ROOT, inputCommit: '1'.repeat(40) }; },
    },
    snapshots: {
      async recover(input) { return { ...input, snapshotId: 'SNP-test', snapshotKind: 'NO_CHANGE', outputCommit: input.inputCommit, changeSummary: {} }; },
    },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  await orchestrator.createRun({
    schema_version: 1, request_id: `REQ-${workflowId}`, request_type: 'CREATE', workflow_id: workflowId, submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:test', project_path_abs: ROOT,
    original_request: 'Run the assigned tests in the isolated staging workspace.', route_plan: testRoute(workflowId),
    user_authorized: { confirmed: true, actor: 'human:test', message: 'Run it.' },
  });
  return { workflowId, orchestrator };
}

function blockedTestResult(task, { inputCommit = task.inputCommit } = {}) {
  return {
    schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId,
    role: 'tester', attempt: task.attempt, started_at: '2026-08-21T00:00:00.000Z', finished_at: '2026-08-21T00:01:00.000Z',
    result_status: 'BLOCKED', summary_for_user: 'The assigned test could not complete.', summary_for_manager: 'The test task is blocked.',
    worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs, input_commit: inputCommit, output_commit: task.inputCommit,
    isolation_mode: 'SANDBOXED_DOCKER', sandbox_attestation: { backend: 'test-double' },
    self_validation: { preflight_passed: false, checks: [] }, artifact_manifest_hash: task.contextManifestSha256,
  };
}

test('human-decision output keeps the run waiting and records a recovery snapshot', async (t) => {
  const workflowId = `WF-Human-${Date.now()}`;
  const artifactRoot = join(ROOT, 'runtime', 'artifacts', workflowId);
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => {
    database.close();
    rmSync(artifactRoot, { recursive: true, force: true });
  });

  const snapshots = [];
  const orchestrator = createOrchestrator({
    projectRoot: ROOT,
    database,
    worktrees: {
      inspectTarget(targetProjectRootAbs) {
        return { targetProjectRootAbs, headCommit: '1'.repeat(40) };
      },
      prepare() {
        return { worktreePathAbs: ROOT, inputCommit: '1'.repeat(40) };
      },
    },
    snapshots: {
      async recover(input) {
        const snapshot = { ...input, snapshotId: 'SNP-human', snapshotKind: 'NO_CHANGE', outputCommit: input.inputCommit, changeSummary: {} };
        snapshots.push(snapshot);
        return snapshot;
      },
    },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runner: async ({ messagePath }) => {
      const message = readFileSync(messagePath, 'utf8');
      const rawOutputPath = message.match(/Write exactly one result\.schema\.json object only to:\r?\n\r?\n([^\r\n]+)/u)?.[1];
      assert.ok(rawOutputPath, 'task message must expose the raw output path');
      const taskArtifactRoot = dirname(dirname(rawOutputPath));
      mkdirSync(dirname(rawOutputPath), { recursive: true });
      writeFileSync(rawOutputPath, `${JSON.stringify({
        schema_version: 1,
        workflow_id: field(message, 'workflow_id'),
        task_id: field(message, 'task_id'),
        run_id: field(message, 'run_id'),
        agent_id: field(message, 'assigned_agent'),
        role: 'reviewer',
        attempt: Number(field(message, 'attempt')),
        started_at: '2026-08-21T00:00:00.000Z',
        finished_at: '2026-08-21T00:01:00.000Z',
        result_status: 'HUMAN_DECISION_REQUIRED',
        summary_for_user: 'A human decision is required.',
        summary_for_manager: 'Wait for the bound Manager decision.',
        worktree_path_abs: field(message, 'worktree_path_abs'),
        artifact_root_abs: taskArtifactRoot,
        input_commit: '1'.repeat(40),
        output_commit: '1'.repeat(40),
        isolation_mode: 'UNSANDBOXED_LOCAL',
        self_validation: { preflight_passed: true, checks: [] },
        artifact_manifest_hash: field(message, 'context_manifest_sha256'),
        decisions_required: [{ summary: 'Choose whether to continue.' }],
      })}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  await orchestrator.createRun({
    schema_version: 1,
    request_id: 'REQ-human',
    request_type: 'CREATE',
    workflow_id: workflowId,
    submitted_by: 'manager-agent',
    manager_session_id: 'manager-session',
    manager_session_key: 'agent:manager:test',
    project_path_abs: ROOT,
    original_request: 'Review the current implementation and stop for a decision.',
    route_plan: {
      schema_version: 1,
      workflow_id: workflowId,
      request_class: 'ANALYSIS_ONLY',
      summary: 'Review and request a human decision.',
      display_title: 'Review',
      risk_flags: [],
      steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', rationale: 'A decision is required.', human_approval_after: false, approval_reason: null }],
      skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required.' })),
    },
    user_authorized: { confirmed: true, actor: 'human:test', message: 'Run it.' },
  });

  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const diagnostic = JSON.stringify({ result, run, task }, null, 2);
  assert.equal(result.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(run.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(task.state, 'WAITING_HUMAN', diagnostic);
  assert.equal(task.payload.snapshot.snapshotKind, 'NO_CHANGE');
  assert.equal(snapshots.length, 1);
});

test('TEST workflow dispatches only staged paths, collects staged output, and records BLOCKED with host identity', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-success', `${Date.now()}-${Math.random().toString(16).slice(2)}`, '.task-sandbox');
  const calls = { prepare: 0, collect: 0, cleanup: 0, runner: 0 };
  let stagedTask;
  const staging = {
    executionRootAbs: stageRoot,
    executionWorktreeAbs: join(stageRoot, 'repo'),
    executionContextManifestPathAbs: join(stageRoot, 'input', 'execution-context-manifest.json'),
    executionOutputRootAbs: join(stageRoot, 'output'),
    executionRawLogsRootAbs: join(stageRoot, 'raw-logs'),
    executionRawOutputPath: join(stageRoot, 'output', 'result.json.raw'),
    containerWorktreeAbs: '/workspace/.task-sandbox/repo',
    containerContextManifestPathAbs: '/workspace/.task-sandbox/input/execution-context-manifest.json',
    containerRawOutputPath: '/workspace/.task-sandbox/output/result.json.raw',
  };
  t.after(() => rmSync(stageRoot, { recursive: true, force: true }));
  const testSandboxStager = {
    prepare(task) { calls.prepare += 1; stagedTask = task; mkdirSync(dirname(staging.executionRawOutputPath), { recursive: true }); return staging; },
    collect(task, value) { calls.collect += 1; assert.equal(value, staging); mkdirSync(dirname(task.rawOutputPath), { recursive: true }); copyFileSync(value.executionRawOutputPath, task.rawOutputPath); },
    cleanup(value) { calls.cleanup += 1; assert.equal(value, staging); rmSync(stageRoot, { recursive: true, force: true }); },
  };
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager,
    runner: async ({ messagePath }) => {
      calls.runner += 1;
      const message = readFileSync(messagePath, 'utf8');
      assert.match(message, /execution_worktree_path_abs: \/workspace\/.task-sandbox\/repo/u);
      assert.match(message, /execution_context_manifest_path_abs: \/workspace\/.task-sandbox\/input\/execution-context-manifest\.json/u);
      assert.match(message, /Write exactly one result\.schema\.json object only to:[\s\S]*\/workspace\/.task-sandbox\/output\/result\.json\.raw/u);
      assert.doesNotMatch(message, /host_worktree_path_abs|host_artifact_root_abs/u);
      writeFileSync(staging.executionRawOutputPath, `${JSON.stringify(blockedTestResult(stagedTask))}\n`);
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });

  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.state, 'FAILED');
  assert.equal(task.payload.result.result_status, 'BLOCKED');
  assert.equal(task.payload.result.input_commit, '1'.repeat(40));
  assert.equal(existsSync(task.payload.ingestion_receipt_path_abs), true);
  assert.equal(readFileSync(join(task.payload.artifact_root_abs, '.agent-raw', 'result.json.raw'), 'utf8'), JSON.stringify(blockedTestResult(stagedTask)) + '\n');
  assert.deepEqual(calls, { prepare: 1, collect: 1, cleanup: 1, runner: 1 });
  assert.equal(execution.state, 'FAILED');
});

test('TEST runner error cleans staged workspace and releases its execution lease', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-runner-error', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const calls = { prepare: 0, collect: 0, cleanup: 0, runner: 0 };
  const staging = { executionWorktreeAbs: join(stageRoot, 'repo'), executionContextManifestPathAbs: join(stageRoot, 'input', 'execution-context-manifest.json'), executionRawOutputPath: join(stageRoot, 'output', 'result.json.raw') };
  t.after(() => rmSync(stageRoot, { recursive: true, force: true }));
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager: {
      prepare() { calls.prepare += 1; mkdirSync(stageRoot, { recursive: true }); return staging; },
      collect() { calls.collect += 1; },
      cleanup() { calls.cleanup += 1; rmSync(stageRoot, { recursive: true, force: true }); },
    },
    runner: async () => { calls.runner += 1; throw Object.assign(new Error('runner exploded'), { code: 'RUNNER_EXPLODED' }); },
  });
  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.lastError.code, 'RUNNER_EXPLODED');
  assert.deepEqual(calls, { prepare: 1, collect: 0, cleanup: 1, runner: 1 });
  assert.equal(existsSync(stageRoot), false);
  assert.equal(execution.state, 'FAILED');
});

test('BLOCKED TEST output still requires the assigned input commit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-blocked-input-'));
  const task = {
    workflowId: 'WF-Blocked-Identity', taskId: 'TASK-Blocked-Identity', runId: 'RUN-Blocked-Identity', agentId: 'test-agent', attempt: 1,
    inputCommit: '1'.repeat(40), worktreePathAbs: join(root, 'repo'), artifactRootAbs: join(root, 'artifacts'), contextManifestSha256: 'a'.repeat(64),
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(task.artifactRootAbs, '.agent-raw'), { recursive: true });
  writeFileSync(join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'), `${JSON.stringify(blockedTestResult(task, { inputCommit: 'UNKNOWN' }))}\n`);

  assert.throws(() => ingestTaskOutput({ projectRoot: ROOT, task }), (error) => error.code === 'AGENT_OUTPUT_INPUT_COMMIT_MISMATCH');
});

test('TEST staging preparation failure is recorded as BLOCKED, releases its lease, and never reaches the runner', async (t) => {
  const stageRoot = join(ROOT, 'runtime', 'test-sandbox-stage-prepare-error', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const lockPath = `${stageRoot}.lock`;
  let runnerCalls = 0;
  t.after(() => { rmSync(stageRoot, { recursive: true, force: true }); rmSync(lockPath, { force: true }); });
  const { workflowId, orchestrator } = await createTestWorkflow(t, {
    testSandboxStager: {
      prepare() { mkdirSync(dirname(lockPath), { recursive: true }); writeFileSync(lockPath, 'locked'); unlinkSync(lockPath); throw Object.assign(new Error('staging unavailable'), { code: 'TEST_SANDBOX_INPUT_MISSING' }); },
      collect() { throw new Error('not reached'); }, cleanup() { throw new Error('not reached'); },
    },
    runner: async () => { runnerCalls += 1; return { exitCode: 0, stdout: '', stderr: '' }; },
  });
  const result = await orchestrator.tick(workflowId);
  const run = await orchestrator.repository.getRun(workflowId);
  const [task] = await orchestrator.repository.listTasks({ runId: run.runId });
  const [execution] = await orchestrator.kernel.repository.listExecutions({ taskId: task.taskId });
  assert.equal(result.state, 'FAILED');
  assert.equal(task.payload.result.result_status, 'BLOCKED');
  assert.equal(task.lastError.code, 'AGENT_BLOCKED');
  assert.equal(runnerCalls, 0);
  assert.equal(existsSync(lockPath), false);
  assert.equal(execution.state, 'FAILED');
});
