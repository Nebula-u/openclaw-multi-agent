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

test('HR review keys are idempotent and snapshots round trip', async (t) => {
  const { repository } = fixture(t);
  const run = await repository.createRun({ workflowId: 'WF-snapshot', request: {}, requestSha256: 'a'.repeat(64), targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'CODE', step_id: 'code', title: 'Code' }, agentId: 'developer-agent', inputCommit: run.baseCommit });
  const job = await repository.queueHrJob({ reviewKey: 'manual:session-one', triggerMode: 'MANUAL', runId: run.runId, taskId: task.taskId, kind: 'SESSION_REVIEW', sourceAgentId: 'developer-agent', sourceSessionId: 'session-one', input: { a: 1 } });
  assert.equal((await repository.queueHrJob({ reviewKey: job.reviewKey, triggerMode: 'MANUAL', runId: run.runId, taskId: task.taskId, kind: 'SESSION_REVIEW', input: {} })).jobId, job.jobId);
  const snapshot = await repository.createSnapshot({ snapshotId: 'SNP-one', runId: run.runId, taskId: task.taskId, executionId: null, attempt: 1, agentId: 'developer-agent', sessionId: 'session-one', inputCommit: run.baseCommit, outputCommit: '3'.repeat(40), gitRef: 'refs/openclaw/snapshots/SNP-one', snapshotKind: 'ACCEPTED', changeSummary: { modified: ['a.js'] }, worktreePathAbs: 'F:/worktree' });
  assert.deepEqual((await repository.getSnapshot(snapshot.snapshotId)).changeSummary, { modified: ['a.js'] });
});
