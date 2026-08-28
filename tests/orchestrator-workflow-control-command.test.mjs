import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createWorkflowControlCommandQueue } from '../scripts/orchestrator/workflow-control-command-queue.mjs';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function command(overrides = {}) {
  return {
    schema_version: 1,
    command_id: 'WFC-pause-001',
    workflow_id: 'WF-pause-001',
    run_id: 'RUN-pause-001',
    action: 'PAUSE',
    actor: 'human:monitor',
    notes: 'stop after the current task',
    submitted_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

test('workflow control queue resolves one PAUSE command once and reuses its receipt', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'workflow-control-queue-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const calls = [];
  const queue = createWorkflowControlCommandQueue({
    projectRoot,
    contractsRoot: ROOT,
    resolve: async (value) => { calls.push(value); return { state: 'HOLD' }; },
  });

  assert.deepEqual(queue.enqueue(command()), { command_id: 'WFC-pause-001', status: 'QUEUED' });
  assert.equal(existsSync(join(queue.commands, 'WFC-pause-001.json')), true);
  assert.equal((await queue.scan())[0].status, 'ACCEPTED');
  assert.equal((await queue.scan())[0].status, 'ACCEPTED');
  assert.equal(calls.length, 1);
});

test('workflow control queue rejects invalid commands before writing them', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'workflow-control-invalid-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const queue = createWorkflowControlCommandQueue({ projectRoot, contractsRoot: ROOT, resolve: async () => {} });
  const invalid = command(); delete invalid.action;

  assert.throws(() => queue.enqueue(invalid), (error) => error.code === 'WORKFLOW_CONTROL_COMMAND_SCHEMA_INVALID');
  assert.equal(existsSync(join(queue.commands, 'WFC-pause-001.json')), false);
});

test('repeated PAUSE commands are idempotent after a run is held', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const orchestrator = createOrchestrator({ projectRoot: ROOT, database, notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const run = await orchestrator.repository.createRun({
    workflowId: 'WF-pause-idempotent', request: {}, targetProjectRootAbs: ROOT, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key',
    routePlan: { route_hash: 'a'.repeat(64), display_title: 'Pause', summary: 'Pause', steps: [] },
  });

  const first = await orchestrator.resolveWorkflowControlCommand(command({ workflow_id: run.workflowId, run_id: run.runId }));
  const second = await orchestrator.resolveWorkflowControlCommand(command({ command_id: 'WFC-pause-002', workflow_id: run.workflowId, run_id: run.runId }));

  assert.equal(first.state, 'HOLD');
  assert.equal(second.state, 'HOLD');
  const notifications = await orchestrator.repository.listNotifications({ runId: run.runId, statuses: ['PENDING', 'DELIVERED'] });
  assert.equal(notifications.filter((item) => item.type === 'WORKFLOW_PAUSED').length, 1);
});

test('a held run does not dispatch its ready task until it is resumed', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  let runnerCalls = 0;
  const orchestrator = createOrchestrator({
    projectRoot: ROOT, database,
    runner: async () => { runnerCalls += 1; return { exitCode: 1, stdout: '', stderr: '' }; },
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  const run = await orchestrator.repository.createRun({
    workflowId: 'WF-pause-ready', request: {}, targetProjectRootAbs: ROOT, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key',
    routePlan: { route_hash: 'a'.repeat(64), display_title: 'Pause', summary: 'Pause', steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', agent_id: 'review-agent' }] },
  });
  await orchestrator.repository.createTask({ runId: run.runId, step: { step_id: 'review', kind: 'CODE_REVIEW', title: 'Review' }, agentId: 'review-agent' });

  await orchestrator.pauseRun({ workflowId: run.workflowId, runId: run.runId, actor: 'human:monitor' });
  const held = await orchestrator.tick(run.workflowId);

  assert.equal(held.state, 'HOLD');
  assert.equal(runnerCalls, 0);
});
