import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createApprovalCommandQueue } from '../scripts/orchestrator/approval-command-queue.mjs';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function command() {
  return {
    schema_version: 1,
    command_id: 'CMD-approval-001',
    workflow_id: 'WF-approval-001',
    run_id: 'RUN-approval-001',
    task_id: 'TASK-approval-001',
    decision_id: 'DEC-approval-001',
    choice: 'APPROVE',
    actor: 'human:monitor',
    notes: '',
    submitted_at: '2026-08-25T00:00:00.000Z',
  };
}

test('approval command queue persists one receipt and reuses it for a duplicate scan', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'approval-command-queue-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const calls = [];
  const queue = createApprovalCommandQueue({ projectRoot, contractsRoot: ROOT, resolve: async (value) => { calls.push(value); return { state: 'ACTIVE' }; } });

  const queued = queue.enqueue(command());
  assert.deepEqual(queued, { command_id: 'CMD-approval-001', status: 'QUEUED' });
  assert.equal(existsSync(join(queue.commands, 'CMD-approval-001.json')), true);

  const first = await queue.scan();
  const second = await queue.scan();
  assert.equal(first[0].status, 'ACCEPTED');
  assert.deepEqual(second[0], first[0]);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(queue.receipts, 'CMD-approval-001.receipt.json'), 'utf8')).status, 'ACCEPTED');
});

test('approval command queue rejects an invalid command before it is queued', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'approval-command-invalid-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const queue = createApprovalCommandQueue({ projectRoot, contractsRoot: ROOT, resolve: async () => {} });
  const invalid = command(); delete invalid.choice;
  assert.throws(() => queue.enqueue(invalid), (error) => error.code === 'APPROVAL_COMMAND_SCHEMA_INVALID');
  assert.equal(existsSync(join(queue.commands, 'CMD-approval-001.json')), false);
});

test('approval command queue skips invalid filenames without blocking valid commands', async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'approval-command-filename-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const queue = createApprovalCommandQueue({ projectRoot, contractsRoot: ROOT, resolve: async () => ({ state: 'ACTIVE' }) });
  queue.enqueue(command());
  writeFileSync(join(queue.commands, 'not-an-approval.json'), '{}');

  const receipts = await queue.scan();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'ACCEPTED');
});

test('orchestrator resolves a pending monitor approval and rejects an unavailable option', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const orchestrator = createOrchestrator({ projectRoot: ROOT, database, notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const routePlan = {
    workflow_id: 'WF-approval-001', route_hash: 'a'.repeat(64), display_title: 'Approval', summary: 'Approval',
    steps: [{ step_id: 'requirements', kind: 'REQUIREMENTS' }, { step_id: 'architecture', kind: 'ARCHITECTURE' }],
  };
  const run = await orchestrator.repository.createRun({ workflowId: 'WF-approval-001', request: {}, routePlan, targetProjectRootAbs: ROOT,
    baseCommit: '1'.repeat(40), managerSessionId: 'manager-session', managerSessionKey: 'manager-key' });
  const task = await orchestrator.repository.createTask({ runId: run.runId, step: { step_id: 'requirements', kind: 'REQUIREMENTS', title: 'Requirements' }, agentId: 'requirement-agent' });
  await orchestrator.repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: 'REQUIREMENT_AMBIGUITY', request: {
    decision_id: 'DEC-approval-001', workflow_id: run.workflowId, task_id: task.taskId, run_id: run.runId, summary: 'Approve requirements',
    options: [{ option_id: 'APPROVE', description: 'Continue' }],
  } });

  await assert.rejects(
    () => orchestrator.resolveApprovalCommand({ ...command(), workflow_id: run.workflowId, run_id: run.runId, task_id: task.taskId, choice: 'CANCEL' }),
    (error) => error.code === 'APPROVAL_OPTION_INVALID',
  );
  const active = await orchestrator.resolveApprovalCommand({ ...command(), workflow_id: run.workflowId, run_id: run.runId, task_id: task.taskId });
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.currentStepIndex, 1);
  assert.equal((await orchestrator.repository.listApprovals({ runId: run.runId, status: 'PENDING' })).length, 0);
  assert.equal((await orchestrator.repository.listNotifications({ runId: run.runId, statuses: ['PENDING', 'DELIVERED'] })).at(-1).type, 'HUMAN_APPROVAL_RESOLVED');
});

test('orchestrator accepts a legacy approval option that uses id instead of option_id', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const orchestrator = createOrchestrator({ projectRoot: ROOT, database, notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const routePlan = {
    workflow_id: 'WF-legacy-option', route_hash: 'b'.repeat(64), display_title: 'Approval', summary: 'Approval',
    steps: [{ step_id: 'requirements', kind: 'REQUIREMENTS' }, { step_id: 'architecture', kind: 'ARCHITECTURE' }],
  };
  const run = await orchestrator.repository.createRun({ workflowId: routePlan.workflow_id, request: {}, routePlan, targetProjectRootAbs: ROOT,
    baseCommit: '1'.repeat(40), managerSessionId: 'manager-session', managerSessionKey: 'manager-key' });
  const task = await orchestrator.repository.createTask({ runId: run.runId, step: { step_id: 'requirements', kind: 'REQUIREMENTS', title: 'Requirements' }, agentId: 'requirement-agent' });
  await orchestrator.repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: 'REQUIREMENT_AMBIGUITY', request: {
    decision_id: 'DEC-legacy-option', workflow_id: run.workflowId, task_id: task.taskId, run_id: run.runId, summary: 'Approve requirements',
    options: [{ id: 'APPROVE', description: 'Continue' }],
  } });

  const active = await orchestrator.resolveApprovalCommand({ ...command(), workflow_id: run.workflowId, run_id: run.runId,
    task_id: task.taskId, decision_id: 'DEC-legacy-option', choice: 'APPROVE' });
  assert.equal(active.state, 'ACTIVE');
});

test('an Agent decision with a descriptive trigger re-dispatches the current task with the recorded choice', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const orchestrator = createOrchestrator({ projectRoot: ROOT, database, notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  const routePlan = {
    workflow_id: 'WF-agent-decision-001', route_hash: 'c'.repeat(64), display_title: 'Decision', summary: 'Decision',
    steps: [{ step_id: 'development', kind: 'DEVELOPMENT', title: 'Implement', agent_id: 'developer-agent' }, { step_id: 'test', kind: 'TEST', title: 'Test', agent_id: 'test-agent' }],
  };
  const run = await orchestrator.repository.createRun({ workflowId: routePlan.workflow_id, request: {}, routePlan, targetProjectRootAbs: ROOT,
    baseCommit: '1'.repeat(40), managerSessionId: 'manager-session', managerSessionKey: 'manager-key' });
  const task = await orchestrator.repository.createTask({ runId: run.runId,
    step: { step_id: 'development', kind: 'DEVELOPMENT', title: 'Implement' }, agentId: 'developer-agent', inputCommit: run.baseCommit });
  const descriptiveTrigger = '需求存在影响范围或验收方式的关键歧义；实现存在明显不同取舍的方向（APPROVAL_RULES §1.1/§1.2）';
  await orchestrator.repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: descriptiveTrigger, request: {
    decision_id: 'DEC-agent-decision-001', workflow_id: run.workflowId, task_id: task.taskId, run_id: run.runId, summary: 'Choose persistence',
    options: [{ option_id: 'PERSIST_SERVER_FILE', description: 'Use a server JSON file.' }],
  } });

  const active = await orchestrator.resolveApprovalCommand({ ...command(), workflow_id: run.workflowId, run_id: run.runId,
    task_id: task.taskId, decision_id: 'DEC-agent-decision-001', choice: 'PERSIST_SERVER_FILE', notes: '使用 JSON 文件。' });
  const retried = await orchestrator.repository.getTask(task.taskId);

  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.currentStepIndex, 0);
  assert.equal(retried.state, 'READY');
  assert.equal(retried.attempt, 2);
  assert.deepEqual(retried.payload.resolved_decisions, [{ decision_id: 'DEC-agent-decision-001', choice: 'PERSIST_SERVER_FILE', notes: '使用 JSON 文件。', actor: 'human:monitor' }]);
});

test('TEST waits for upstream rework instead of retrying when DEVELOPMENT has no completed result', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  let runnerCalls = 0;
  const orchestrator = createOrchestrator({
    projectRoot: ROOT, database, testSandboxEnabled: false,
    notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    runner: async () => { runnerCalls += 1; throw new Error('TEST must not be dispatched'); },
    worktrees: {
      inspectTarget(targetProjectRootAbs) { return { targetProjectRootAbs, headCommit: '1'.repeat(40) }; },
      prepare() { return { worktreePathAbs: ROOT, inputCommit: '1'.repeat(40) }; },
    },
  });
  const routePlan = {
    workflow_id: 'WF-upstream-missing-001', route_hash: 'd'.repeat(64), display_title: 'Upstream', summary: 'Upstream',
    steps: [{ step_id: 'development', kind: 'DEVELOPMENT', title: 'Implement', agent_id: 'developer-agent' }, { step_id: 'test', kind: 'TEST', title: 'Test', agent_id: 'test-agent' }],
  };
  const run = await orchestrator.repository.createRun({ workflowId: routePlan.workflow_id, request: { original_request: 'Implement then test the application.' }, routePlan, targetProjectRootAbs: ROOT,
    baseCommit: '1'.repeat(40), managerSessionId: 'manager-session', managerSessionKey: 'manager-key' });
  const development = await orchestrator.repository.createTask({ runId: run.runId,
    step: { step_id: 'development', kind: 'DEVELOPMENT', title: 'Implement' }, agentId: 'developer-agent', inputCommit: run.baseCommit });
  await orchestrator.repository.updateTask(development.taskId, { state: 'SUCCEEDED', payload: { result: { result_status: 'HUMAN_DECISION_REQUIRED', output_commit: null } } });
  await orchestrator.repository.updateRun(run.runId, { currentStepIndex: 1, state: 'ACTIVE' });

  const waiting = await orchestrator.tick(run.workflowId);
  const pending = (await orchestrator.repository.listApprovals({ runId: run.runId, status: 'PENDING' }))[0];

  assert.equal(runnerCalls, 0);
  assert.equal(waiting.state, 'WAITING_HUMAN');
  assert.equal(pending.trigger, 'UPSTREAM_IMPLEMENTATION_MISSING');
  assert.deepEqual(pending.request.options.map((option) => option.option_id), ['REWORK', 'ABORT']);

  const resumed = await orchestrator.decide({ workflow_id: run.workflowId, manager_session_id: 'manager-session', manager_session_key: 'manager-key',
    decision_id: pending.decisionId, choice: 'REWORK', notes: '请先完成开发。', user_authorized: { confirmed: true, actor: 'human:test', message: '返工。' } });
  const retriedDevelopment = await orchestrator.repository.getTask(development.taskId);
  const testTask = (await orchestrator.repository.listTasks({ runId: run.runId })).find((task) => task.stepId === 'test');
  assert.equal(resumed.currentStepIndex, 0);
  assert.equal(retriedDevelopment.state, 'READY');
  assert.equal(retriedDevelopment.attempt, 2);
  assert.equal(testTask.state, 'READY');
});

test('orchestrator scans approval commands from its configured runtime root', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'orchestrator-approval-runtime-'));
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const orchestrator = createOrchestrator({ projectRoot: ROOT, runtimeRoot, database, notificationRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(orchestrator.approvalCommands.root, join(runtimeRoot, 'orchestrator', 'approval-commands'));
});
