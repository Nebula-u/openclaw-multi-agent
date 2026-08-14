import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createStateGraphRuntime } from '../scripts/stategraph/runtime.mjs';
import { loadStateGraphPolicy } from '../scripts/stategraph/policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function plan(workflowId) {
  return {
    schema_version: 1,
    workflow_id: workflowId,
    request_class: 'TEST_ONLY',
    summary: '只运行现有测试，不经过开发与架构',
    risk_flags: [],
    steps: [{ step_id: 'test', kind: 'TEST', title: '运行测试', rationale: '用户只请求测试', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'RELEASE'].map((kind) => ({ kind, reason: '测试请求不需要该阶段' })),
  };
}

function successfulDispatcher() {
  return {
    start(task) { return { ...task, status: 'DISPATCHED', current_cycle: 0, session_id: task.session_id ?? '00000000-0000-4000-8000-000000000001' }; },
    reconcile(task) {
      if (task.kind === 'MANAGER_ANALYSIS') return { kind: 'SUCCEEDED', task: { ...task, status: 'SUCCEEDED', result: plan(task.workflow_id) } };
      return { kind: 'SUCCEEDED', task: { ...task, status: 'SUCCEEDED', result: {
        result_status: 'COMPLETED',
        summary_for_user: '测试通过',
        output_commit: task.input_commit,
        isolation_mode: 'SANDBOXED_DOCKER',
        command_record_refs: [join(task.artifact_root_abs, 'command-records.jsonl')],
        self_validation: { preflight_passed: true, checks: task.required_gate_checks.map((name) => ({ name, status: 'PASS', detail: 'verified' })) },
      }, sandbox_attestation: { container_id: 'test-container' } } };
    },
  };
}

function worktreeStub(project) {
  const commit = 'a'.repeat(40);
  return {
    inspectTarget() { return { target_project_root_abs: project, head_commit: commit }; },
    pathFor() { return project; },
    assertDescendant() { return true; },
    head() { return commit; },
  };
}

test('checkpoint is the authority for dynamic route, human freeze and completion', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-runtime-'));
  try {
    const project = join(temp, 'target');
    mkdirSync(project, { recursive: true });
    const databasePath = join(temp, 'checkpoints.db');
    const runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath, dispatcher: successfulDispatcher(), worktrees: worktreeStub(project), skipAuthority: true });
    const workflowId = 'WF-checkpoint-route';
    await runtime.bootstrap({ workflowId, request: { text: '只执行现有测试', project_path_abs: project } });
    await runtime.run(workflowId);
    await runtime.run(workflowId);
    const proposed = await runtime.run(workflowId);
    assert.equal(proposed.condition, 'WAITING_HUMAN');
    assert.equal(proposed.pending_approval.kind, 'ROUTE_PLAN_CONFIRMATION');
    const routeHash = proposed.route_hash;
    await runtime.approve(workflowId, { decision_id: proposed.pending_approval.decision_id, choice: 'APPROVE', decided_by: 'human:test', notes: '' });
    let state = await runtime.state(workflowId);
    assert.equal(state.routePlan.status, 'FROZEN');
    assert.equal(state.routePlan.route_hash, routeHash);
    await runtime.run(workflowId);
    await runtime.run(workflowId);
    await runtime.run(workflowId);
    await runtime.run(workflowId);
    const completed = await runtime.run(workflowId);
    assert.equal(completed.condition, 'TERMINAL');
    assert.equal(completed.outcome, 'COMPLETED');
    assert.equal((await runtime.audit(workflowId)).ok, true);
    runtime.close();

    const recovered = createStateGraphRuntime({ projectRoot: ROOT, databasePath, dispatcher: successfulDispatcher(), worktrees: worktreeStub(project), skipAuthority: true });
    state = await recovered.state(workflowId);
    assert.equal(state.outcome, 'COMPLETED');
    assert.equal(state.routePlan.route_hash, routeHash);
    recovered.close();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('each Agent error is reported, same Agent retries twice, then human approval is required', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-retry-'));
  try {
    const project = join(temp, 'target');
    mkdirSync(project, { recursive: true });
    const failing = {
      start(task) { return { ...task, status: 'DISPATCHED', session_id: `session-${task.attempt}` }; },
      reconcile(task) { return { kind: 'ERROR', task, code: 'AGENT_TEST_FAILURE', message: `attempt ${task.attempt} failed` }; },
    };
    const runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), dispatcher: failing, worktrees: worktreeStub(project),
      policy: loadStateGraphPolicy(ROOT), skipAuthority: true });
    const workflowId = 'WF-agent-retry';
    await runtime.bootstrap({ workflowId, request: { text: '分析请求', project_path_abs: project } });
    for (let index = 0; index < 6; index += 1) await runtime.run(workflowId);
    const state = await runtime.state(workflowId);
    const task = state.tasks.find((item) => item.kind === 'MANAGER_ANALYSIS');
    assert.equal(task.agent_id, 'manager-agent');
    assert.equal(task.attempt, 3);
    assert.equal(task.status, 'WAITING_HUMAN');
    assert.equal(state.managerReports.length, 3);
    assert.equal(state.pendingApproval.kind, 'ERROR_ESCALATION');
    assert.equal(state.condition, 'WAITING_HUMAN');
    runtime.close();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
