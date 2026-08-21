import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createLease } from '../scripts/control-kernel/lease.mjs';
import { createWorkflowRepository } from '../scripts/control-kernel/workflow-repository.mjs';
import * as service from '../scripts/orchestrator/service.mjs';

test('Agent execution heartbeat prevents a concurrent reaper from expiring a live lease', async (t) => {
  assert.equal(typeof service.runWithLeaseHeartbeat, 'function');
  const database = openKernelDatabase({ databasePath: ':memory:' }); t.after(() => database.close());
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-heartbeat', request: {}, requestSha256: 'a'.repeat(64),
    targetProjectRootAbs: 'F:/repo', baseCommit: '1'.repeat(40), routePlan: { steps: [] }, routeHash: '2'.repeat(64) });
  const task = await repository.createTask({ runId: run.runId, step: { kind: 'DEVELOPMENT', step_id: 'code', title: 'Code' },
    agentId: 'developer-agent', inputCommit: run.baseCommit });
  const lease = createLease({ database, scheduleSeconds: 0.06 });
  const execution = await lease.acquireLease({ executionId: 'EXE-heartbeat', taskId: task.taskId, runId: run.runId,
    attempt: 1, cycle: 0, workerId: 'worker-one', agentId: 'developer-agent' });
  let reaped = null;
  const competingReaper = delay(140).then(async () => { reaped = await lease.reapExpiredLeases(); });
  const result = await service.runWithLeaseHeartbeat({ lease, executionId: execution.executionId,
    run: async () => { await delay(180); return { exitCode: 0 }; } });
  await competingReaper;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(reaped, []);
  assert.equal((await lease.activeExecution(task.taskId)).executionId, execution.executionId);
});

test('lost execution lease aborts the Agent and fails closed', async () => {
  let aborted = false;
  const lease = { scheduleSeconds: 0.03, async heartbeat() { return null; } };
  await assert.rejects(service.runWithLeaseHeartbeat({ lease, executionId: 'EXE-lost',
    run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve({ exitCode: -1 }); }, { once: true })) }),
  (error) => error.code === 'EXECUTION_LEASE_LOST');
  assert.equal(aborted, true);
});

test('failed task advances to a new attempt before preparing another worktree', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' }); t.after(() => database.close());
  const orchestrator = service.createOrchestrator({ projectRoot: process.cwd(), database,
    worktrees: { inspectTarget: (path) => ({ targetProjectRootAbs: path, headCommit: '1'.repeat(40) }),
      prepare() { throw new Error('prepare must not run while transitioning FAILED to READY'); } },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const workflowId = 'WF-retry-transition';
  const routePlan = { schema_version: 1, workflow_id: workflowId, request_class: 'ANALYSIS_ONLY', summary: 'Retry test', display_title: 'Retry', risk_flags: [],
    steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', rationale: 'Test retry.', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS','ARCHITECTURE','DESIGN','DEVELOPMENT','TEST','RELEASE'].map((kind) => ({ kind, reason: 'Not required.' })) };
  const run = await orchestrator.createRun({ workflow_id: workflowId, project_path_abs: process.cwd(), original_request: 'retry', route_plan: routePlan,
    manager_session_id: 'manager-session', manager_session_key: 'manager-key', user_authorized: { confirmed: true } });
  const task = await orchestrator.repository.createTask({ runId: run.runId, step: routePlan.steps[0], agentId: 'review-agent',
    inputCommit: run.baseCommit, maxAttempts: 3 });
  await orchestrator.repository.updateTask(task.taskId, { state: 'FAILED', lastError: { code: 'FIRST_ATTEMPT_FAILED' } });
  const result = await orchestrator.tick(workflowId);
  assert.equal(result.state, 'READY');
  assert.equal(result.task.attempt, 2);
  await orchestrator.close();
});
