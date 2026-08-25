import assert from 'node:assert/strict';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createKernel } from '../scripts/control-kernel/kernel.mjs';
import { createWorkflowRepository } from '../scripts/control-kernel/workflow-repository.mjs';

function fixture(t) {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const clock = () => new Date('2026-08-21T00:00:00.000Z');
  const kernel = createKernel({ database, clock, workerId: 'test-worker', leaseSeconds: 120 });
  const repository = createWorkflowRepository({ database, clock });
  return { database, kernel, repository };
}

const request = {
  workflow_id: 'WF-sqlite',
  request: { summary: 'test' },
  request_sha256: 'a'.repeat(64),
  project_path_abs: 'F:/repo',
  route_plan: { steps: [] },
};

test('workflow repository persists JSON facts without revision or events', async (t) => {
  const { database, kernel, repository } = fixture(t);
  const run = await repository.createRun({
    workflowId: request.workflow_id,
    request: request.request,
    requestSha256: request.request_sha256,
    targetProjectRootAbs: request.project_path_abs,
    baseCommit: '1'.repeat(40),
    routePlan: request.route_plan,
    routeHash: '2'.repeat(64),
  });
  assert.deepEqual(run.request, request.request);
  assert.equal('revision' in run, false);
  const updated = await repository.updateRun(run.runId, { state: 'HOLD', statusReason: 'manual' });
  assert.equal(updated.state, 'HOLD');
  assert.equal(database.get("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='events'").count, 0);
  const projected = (await kernel.listRuns())[0];
  assert.deepEqual(projected.routePlan, request.route_plan);
  assert.equal(projected.currentStepIndex, 0);
});

test('workflow repository persists JSON regeneration counters without consuming a task attempt', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-json-regeneration', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit });
  const updated = await repository.updateTask(task.taskId, { jsonRegenerations: 1, executionRound: 2 });
  assert.equal(updated.attempt, 1);
  assert.equal(updated.jsonRegenerations, 1);
  assert.equal(updated.executionRound, 2);
  const reloaded = await repository.getTask(task.taskId);
  assert.equal(reloaded.jsonRegenerations, 1);
  assert.equal(reloaded.executionRound, 2);
});

test('SQLite partial unique index grants one active lease per task', async (t) => {
  const { kernel, repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-lease', request: {}, requestSha256: 'a'.repeat(64), targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'CODE', step_id: 'code', title: 'Code' }, agentId: 'developer-agent', inputCommit: run.baseCommit });
  const first = { executionId: 'EXE-first', taskId: task.taskId, runId: run.runId, attempt: 1, cycle: 0, workerId: 'one', agentId: 'developer-agent' };
  const second = { ...first, executionId: 'EXE-second', workerId: 'two' };
  assert.equal((await kernel.lease.acquireLease(first)).state, 'LEASED');
  await assert.rejects(kernel.lease.acquireLease(second), (error) => error.code === 'LEASE_HELD');
});

test('expired execution lease atomically returns its running task to retryable failure', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' }); t.after(() => database.close());
  let current = new Date('2026-08-21T00:00:00.000Z'); const clock = () => current;
  const kernel = createKernel({ database, clock, workerId: 'test-worker', leaseSeconds: 120 });
  const repository = createWorkflowRepository({ database, clock });
  const run = await repository.createRun({ workflowId: 'WF-expired', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit });
  await repository.updateTask(task.taskId, { state: 'RUNNING' });
  await kernel.lease.acquireLease({ executionId: 'EXE-expired', taskId: task.taskId, runId: run.runId,
    attempt: 1, cycle: 0, workerId: 'worker-one', agentId: 'developer-agent' });
  current = new Date('2026-08-21T00:02:01.000Z');
  assert.equal((await kernel.lease.reapExpiredLeases()).length, 1);
  const recoveredTask = await repository.getTask(task.taskId);
  assert.equal(recoveredTask.state, 'FAILED');
  assert.equal(recoveredTask.lastError.code, 'EXECUTION_LEASE_EXPIRED');
});

test('execution-scoped task mutation rejects a stale execution after its lease was reaped', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' }); t.after(() => database.close());
  let current = new Date('2026-08-21T00:00:00.000Z'); const clock = () => current;
  const kernel = createKernel({ database, clock, workerId: 'test-worker', leaseSeconds: 120 });
  const repository = createWorkflowRepository({ database, clock });
  const run = await repository.createRun({ workflowId: 'WF-stale-execution', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit });
  const execution = await kernel.lease.acquireLease({ executionId: 'EXE-stale', taskId: task.taskId, runId: run.runId,
    attempt: 1, cycle: 0, workerId: 'worker-one', agentId: 'developer-agent' });
  await repository.updateTask(task.taskId, { state: 'RUNNING' });

  const first = await repository.updateTaskForExecution(task.taskId, { jsonRegenerations: 1 }, {
    executionId: execution.executionId, attempt: 1,
  });
  assert.equal(first.jsonRegenerations, 1);

  current = new Date('2026-08-21T00:02:01.000Z');
  await assert.rejects(
    repository.updateTaskForExecution(task.taskId, { jsonRegenerations: 2 }, { executionId: execution.executionId, attempt: 1 }),
    (error) => error.code === 'EXECUTION_TASK_CAS_FAILED',
  );
  await kernel.lease.reapExpiredLeases();
  await repository.updateTask(task.taskId, { state: 'READY', attempt: 2, jsonRegenerations: 0 });
  await assert.rejects(
    repository.updateTaskForExecution(task.taskId, { state: 'SUCCEEDED', jsonRegenerations: 2 }, {
      executionId: execution.executionId, attempt: 1,
    }),
    (error) => error.code === 'EXECUTION_TASK_CAS_FAILED',
  );
  const currentTask = await repository.getTask(task.taskId);
  assert.equal(currentTask.state, 'READY');
  assert.equal(currentTask.attempt, 2);
  assert.equal(currentTask.jsonRegenerations, 0);
});

test('retry-exhausted approval creation is idempotent for one task attempt', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-retry-approval-idempotent', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit, maxAttempts: 1 });
  await repository.updateTask(task.taskId, { state: 'FAILED' });
  const request = (decisionId) => ({ decision_id: decisionId, workflow_id: run.workflowId, run_id: run.runId,
    task_id: task.taskId, task_attempt: 1, max_attempts: 1, trigger: 'TASK_RETRY_EXHAUSTED', summary: 'retry?',
    options: [{ option_id: 'RETRY_SAME_AGENT', description: 'retry' }] });

  const [first, second] = await Promise.all([
    repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId,
      trigger: 'TASK_RETRY_EXHAUSTED', request: request('DEC-retry-one') }),
    repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId,
      trigger: 'TASK_RETRY_EXHAUSTED', request: request('DEC-retry-two') }),
  ]);
  assert.equal(second.decisionId, first.decisionId);
  assert.equal((await repository.listApprovals({ runId: run.runId, status: 'PENDING' })).length, 1);
  assert.equal((await repository.getTask(task.taskId)).state, 'WAITING_HUMAN');
});

test('retry-exhausted approval resolution atomically resumes the bound task attempt and run', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-retry-approval-resolve', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit, maxAttempts: 1,
    payload: { preserved: true } });
  await repository.updateTask(task.taskId, { state: 'FAILED', jsonRegenerations: 2 });
  const approval = await repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId,
    trigger: 'TASK_RETRY_EXHAUSTED', request: { decision_id: 'DEC-retry-resolve', workflow_id: run.workflowId, run_id: run.runId,
      task_id: task.taskId, task_attempt: 1, max_attempts: 1, trigger: 'TASK_RETRY_EXHAUSTED', summary: 'retry?',
      options: [{ option_id: 'RETRY_SAME_AGENT', description: 'retry' }] } });

  const resolved = await repository.resolveRetryExhaustedApproval({ decisionId: approval.decisionId,
    response: { outcome: 'RETRY_SAME_AGENT', notes: 'confirmed', actor: 'human:test' } });
  assert.equal(resolved.approval.status, 'RESOLVED');
  assert.equal(resolved.task.state, 'READY');
  assert.equal(resolved.task.attempt, 2);
  assert.equal(resolved.task.maxAttempts, 4);
  assert.equal(resolved.task.jsonRegenerations, 0);
  assert.equal(resolved.task.payload.preserved, true);
  assert.equal(resolved.task.payload.retry_authorization.decision_id, approval.decisionId);
  assert.equal(resolved.run.state, 'ACTIVE');
});

test('stale retry-exhausted approval cannot act on a different task attempt', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-retry-approval-stale', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit, maxAttempts: 1 });
  await repository.updateTask(task.taskId, { state: 'FAILED' });
  const approval = await repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId,
    trigger: 'TASK_RETRY_EXHAUSTED', request: { decision_id: 'DEC-retry-stale', workflow_id: run.workflowId, run_id: run.runId,
      task_id: task.taskId, task_attempt: 1, max_attempts: 1, trigger: 'TASK_RETRY_EXHAUSTED', summary: 'retry?',
      options: [{ option_id: 'RETRY_SAME_AGENT', description: 'retry' }] } });
  await repository.updateTask(task.taskId, { state: 'FAILED', attempt: 2 });

  await assert.rejects(
    repository.resolveRetryExhaustedApproval({ decisionId: approval.decisionId,
      response: { outcome: 'RETRY_SAME_AGENT', notes: '', actor: 'human:test' } }),
    (error) => error.code === 'APPROVAL_TASK_BINDING_STALE',
  );
  assert.equal((await repository.listApprovals({ runId: run.runId, status: 'PENDING' })).length, 1);
  assert.equal((await repository.getRunById(run.runId)).state, 'WAITING_HUMAN');
});

test('retry-exhausted abort atomically cancels the task and terminates the run', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-retry-approval-abort', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit, maxAttempts: 1 });
  await repository.updateTask(task.taskId, { state: 'FAILED' });
  const approval = await repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId,
    trigger: 'TASK_RETRY_EXHAUSTED', request: { decision_id: 'DEC-retry-abort', workflow_id: run.workflowId, run_id: run.runId,
      task_id: task.taskId, task_attempt: 1, max_attempts: 1, trigger: 'TASK_RETRY_EXHAUSTED', summary: 'retry?',
      options: [{ option_id: 'RETRY_SAME_AGENT', description: 'retry' }, { option_id: 'ABORT', description: 'abort' }] } });

  await assert.rejects(
    repository.resolveRetryExhaustedApproval({ decisionId: approval.decisionId,
      response: { outcome: 'NOT_ALLOWED', notes: '', actor: 'human:test' } }),
    (error) => error.code === 'APPROVAL_OPTION_INVALID',
  );
  assert.equal((await repository.listApprovals({ runId: run.runId, status: 'PENDING' })).length, 1);

  const resolved = await repository.resolveRetryExhaustedApproval({ decisionId: approval.decisionId,
    response: { outcome: 'ABORT', notes: 'stop', actor: 'human:test' } });
  assert.equal(resolved.approval.status, 'RESOLVED');
  assert.equal(resolved.task.state, 'CANCELLED');
  assert.equal(resolved.task.attempt, 1);
  assert.equal(resolved.run.state, 'TERMINAL');
  assert.equal(resolved.run.outcome, 'CANCELLED');
});

test('HR review keys are idempotent and snapshots round trip', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-snapshot', request: {}, requestSha256: 'a'.repeat(64), targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'CODE', step_id: 'code', title: 'Code' }, agentId: 'developer-agent', inputCommit: run.baseCommit });
  const job = await repository.queueHrJob({ reviewKey: 'manual:session-one', triggerMode: 'MANUAL', runId: run.runId, taskId: task.taskId, kind: 'SESSION_REVIEW', sourceAgentId: 'developer-agent', sourceSessionId: 'session-one', input: { a: 1 } });
  assert.equal((await repository.queueHrJob({ reviewKey: job.reviewKey, triggerMode: 'MANUAL', runId: run.runId, taskId: task.taskId, kind: 'SESSION_REVIEW', input: {} })).jobId, job.jobId);
  const snapshot = await repository.createSnapshot({ snapshotId: 'SNP-one', runId: run.runId, taskId: task.taskId, executionId: null, attempt: 1, agentId: 'developer-agent', sessionId: 'session-one', inputCommit: run.baseCommit, outputCommit: '3'.repeat(40), gitRef: 'refs/openclaw/snapshots/SNP-one', snapshotKind: 'ACCEPTED', changeSummary: { modified: ['a.js'] }, worktreePathAbs: 'F:/worktree' });
  assert.deepEqual((await repository.getSnapshot(snapshot.snapshotId)).changeSummary, { modified: ['a.js'] });
});
