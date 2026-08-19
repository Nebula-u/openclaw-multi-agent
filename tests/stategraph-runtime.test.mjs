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
    display_title: '运行现有测试',
    summary: '只运行现有测试，不经过开发与架构',
    risk_flags: [],
    steps: [{ step_id: 'test', kind: 'TEST', title: '运行测试', rationale: '用户只请求测试', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'RELEASE'].map((kind) => ({ kind, reason: '测试请求不需要该阶段' })),
  };
}

function lifecyclePlan(workflowId) {
  const included = ['REQUIREMENTS', 'DEVELOPMENT', 'CODE_REVIEW', 'TEST', 'RELEASE'];
  return {
    schema_version: 1,
    workflow_id: workflowId,
    request_class: 'FEATURE',
    display_title: '完整交付流程',
    summary: '开发候选提交并依次绑定评审、测试和发布',
    risk_flags: [],
    steps: included.map((kind) => ({
      step_id: kind.toLowerCase().replaceAll('_', '-'), kind, title: kind, rationale: '完整候选提交生命周期',
      human_approval_after: false, approval_reason: null,
    })),
    skipped_stages: ['ARCHITECTURE', 'DESIGN'].map((kind) => ({ kind, reason: '本测试不涉及架构或交互设计变化' })),
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
    assert.equal((await runtime.state(workflowId)).workflowTitle, '运行现有测试');
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

test('LangGraph checkpoint history exposes read-only time travel snapshots', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-history-'));
  try {
    const project = join(temp, 'target'); mkdirSync(project, { recursive: true });
    const runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), dispatcher: successfulDispatcher(), worktrees: worktreeStub(project), skipAuthority: true });
    const workflowId = 'WF-history-readonly';
    await runtime.bootstrap({ workflowId, request: { text: '查看历史', project_path_abs: project } });
    await runtime.run(workflowId);
    await runtime.run(workflowId);
    const history = await runtime.history(workflowId, { limit: 20 });
    assert.ok(history.length >= 3);
    assert.ok(history.every((item) => item.checkpoint_id));
    assert.ok(history[0].revision >= history.at(-1).revision);
    assert.equal((await runtime.stateAt(workflowId, history[0].checkpoint_id)).workflowId, workflowId);
    runtime.close();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('Manager-confirmed workflow starts frozen and user route changes preserve completed stages', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-confirmed-route-'));
  let runtime;
  try {
    const project = join(temp, 'target'); mkdirSync(project, { recursive: true });
    runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), dispatcher: successfulDispatcher(), worktrees: worktreeStub(project), skipAuthority: true });
    const workflowId = 'WF-manager-confirmed';
    const initial = lifecyclePlan(workflowId);
    await runtime.bootstrapConfirmed({ workflowId, request: { text: '完整交付', project_path_abs: project, user_confirmation: { confirmed: true, actor: 'human:cli-owner', request_id: 'REQ-create' } }, routePlan: initial });
    let state = await runtime.state(workflowId);
    assert.equal(state.routePlan.status, 'FROZEN');
    assert.equal(state.workflowTitle, initial.display_title);
    assert.equal(state.tasks.some((task) => task.kind === 'MANAGER_ANALYSIS'), false);
    assert.equal(state.tasks[0]?.kind, 'REQUIREMENTS');
    assert.equal(state.tasks[0]?.status, 'READY');
    assert.equal(state.routePlan.frozen_by, 'human:cli-owner');
    const completed = { ...state.steps[0], status: 'COMPLETED', completed_at: '2026-08-17T00:00:00.000Z' };
    await runtime.graph.updateState({ configurable: { thread_id: workflowId, checkpoint_ns: '' } }, { steps: [completed, ...state.steps.slice(1)], currentStepIndex: 1, activeTaskId: null }, 'decide');
    const changed = lifecyclePlan(workflowId);
    changed.display_title = '不应覆盖标题';
    changed.steps = changed.steps.filter((step) => step.kind !== 'CODE_REVIEW');
    changed.skipped_stages.push({ kind: 'CODE_REVIEW', reason: '用户明确要求后续阶段不再执行独立代码评审' });
    await runtime.revise(workflowId, { request_id: 'REQ-change', route_plan: changed, user_requested: true, requested_by: 'human:cli-owner', submitted_by: 'manager-agent' });
    state = await runtime.state(workflowId);
    assert.equal(state.steps[0].step_id, completed.step_id);
    assert.equal(state.steps[0].status, 'COMPLETED');
    assert.equal(state.steps.some((step) => step.kind === 'DEVELOPMENT'), true);
    assert.equal(state.steps.some((step) => step.kind === 'CODE_REVIEW'), false);
    assert.equal(state.workflowTitle, initial.display_title);
    assert.equal(state.routeHistory.length, 1);
    assert.equal(state.statusReason, '用户通过 Manager CLI 更新了后续流程');
  } finally {
    runtime?.close();
    rmSync(temp, { recursive: true, force: true });
  }
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

test('a three-slot read-only TEST step fans out with Send and merges into one completed step', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-parallel-run-'));
  try {
    const project = join(temp, 'target');
    mkdirSync(project, { recursive: true });
    const workflowId = 'WF-three-slot-test';
    const route = plan(workflowId);
    route.steps[0].split_hint = { max_parallel: 3, partition_by: 'FILE_GROUP' };
    const policy = { ...loadStateGraphPolicy(ROOT), parallelism: { enabled: true, max_parallel: 3 } };
    const runtime = createStateGraphRuntime({
      projectRoot: ROOT,
      databasePath: join(temp, 'checkpoints.db'),
      dispatcher: successfulDispatcher(),
      worktrees: worktreeStub(project),
      policy,
      skipAuthority: true,
    });
    await runtime.bootstrapConfirmed({
      workflowId,
      request: { text: 'parallel test', project_path_abs: project, user_confirmation: { confirmed: true, actor: 'human:test', request_id: 'REQ-three-slot' } },
      routePlan: route,
    });
    let result;
    for (let index = 0; index < 24; index += 1) {
      result = await runtime.run(workflowId);
      if (result.condition === 'TERMINAL') break;
      assert.notEqual(result.condition, 'HOLD');
    }
    const state = await runtime.state(workflowId);
    const tasks = state.tasks.filter((task) => task.step_id === 'test');
    assert.equal(result.condition, 'TERMINAL');
    assert.equal(tasks.length, 3);
    assert.deepEqual(tasks.map((task) => task.parallel_slot).sort(), [0, 1, 2]);
    assert.ok(tasks.every((task) => task.status === 'ACCEPTED'));
    assert.equal(state.taskGroups[0].status, 'MERGED');
    assert.equal(state.steps[0].status, 'COMPLETED');
    assert.equal((await runtime.audit(workflowId)).ok, true);
    await runtime.close();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('DEVELOPMENT and TEST advance one checkpoint candidate that REVIEW and RELEASE cannot replace', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-lifecycle-'));
  const workflowId = 'WF-candidate-lifecycle';
  const workflowArtifacts = join(ROOT, 'runtime', 'artifacts', workflowId);
  try {
    const project = join(temp, 'target');
    mkdirSync(project, { recursive: true });
    const base = 'a'.repeat(40);
    const development = 'b'.repeat(40);
    const tested = 'c'.repeat(40);
    const heads = new Map();
    const observed = [];
    const worktrees = {
      inspectTarget() { return { target_project_root_abs: project, head_commit: base }; },
      pathFor(task) { return join(project, task.run_id); },
      assertDescendant(_repository, ancestor, descendant) {
        assert.ok([[base, development], [development, tested], [base, base], [development, development]].some(([from, to]) => from === ancestor && to === descendant));
        return true;
      },
      head(repository) { return heads.get(repository) ?? base; },
    };
    const dispatcher = {
      start(task) { return { ...task, status: 'DISPATCHED', current_cycle: 0, session_id: task.session_id ?? `session-${task.run_id}` }; },
      reconcile(task) {
        if (task.kind === 'MANAGER_ANALYSIS') return { kind: 'SUCCEEDED', task: { ...task, status: 'SUCCEEDED', result: lifecyclePlan(task.workflow_id) } };
        observed.push({ kind: task.kind, input_commit: task.input_commit });
        const outputCommit = task.kind === 'DEVELOPMENT' ? development : task.kind === 'TEST' ? tested : task.input_commit;
        heads.set(task.worktree_path_abs, outputCommit);
        return { kind: 'SUCCEEDED', task: { ...task, status: 'SUCCEEDED', sandbox_attestation: task.kind === 'TEST' ? { container_id: 'candidate-test' } : null, result: {
          result_status: 'COMPLETED', summary_for_user: `${task.kind} complete`, output_commit: outputCommit,
          isolation_mode: task.kind === 'TEST' ? 'SANDBOXED_DOCKER' : 'UNSANDBOXED_LOCAL',
          command_record_refs: task.kind === 'TEST' ? [join(task.artifact_root_abs, 'command-records.jsonl')] : [],
          self_validation: { preflight_passed: true, checks: task.required_gate_checks.map((name) => ({ name, status: 'PASS', detail: 'verified' })) },
        } } };
      },
    };
    const runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), dispatcher, worktrees, skipAuthority: true });
    await runtime.bootstrap({ workflowId, request: { text: '实现功能、评审、测试并发布', project_path_abs: project } });
    let result;
    for (let index = 0; index < 10; index += 1) {
      result = await runtime.run(workflowId);
      if (result.pending_approval?.kind === 'ROUTE_PLAN_CONFIRMATION') break;
    }
    assert.equal(result.pending_approval?.kind, 'ROUTE_PLAN_CONFIRMATION');
    await runtime.approve(workflowId, { decision_id: result.pending_approval.decision_id, choice: 'APPROVE', decided_by: 'human:test', notes: '' });
    for (let index = 0; index < 40; index += 1) {
      result = await runtime.run(workflowId);
      if (result.condition === 'TERMINAL') break;
      assert.notEqual(result.condition, 'HOLD');
      assert.equal(result.pending_approval, null);
    }
    const state = await runtime.state(workflowId);
    assert.equal(state.outcome, 'COMPLETED');
    assert.equal(state.candidateCommit, tested);
    assert.deepEqual(state.candidateHistory.map((entry) => ({ kind: entry.kind, from: entry.from_commit, to: entry.to_commit })), [
      { kind: 'DEVELOPMENT', from: base, to: development },
      { kind: 'TEST', from: development, to: tested },
    ]);
    assert.deepEqual(observed, [
      { kind: 'REQUIREMENTS', input_commit: base },
      { kind: 'DEVELOPMENT', input_commit: base },
      { kind: 'CODE_REVIEW', input_commit: development },
      { kind: 'TEST', input_commit: development },
      { kind: 'RELEASE', input_commit: tested },
    ]);
    assert.ok(state.tasks.filter((task) => task.kind !== 'MANAGER_ANALYSIS').every((task) => task.status === 'ACCEPTED'));
    runtime.close();
  } finally {
    rmSync(workflowArtifacts, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
