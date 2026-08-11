import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { buildWorkflowGraph } from '../scripts/orchestrator/workflow-graph/graph.mjs';
import { loadWorkflowGraphPolicy } from '../scripts/orchestrator/workflow-graph/phase-policy.mjs';
import { runWorkflowTurn } from '../scripts/workflow-runner.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BUNDLE = 'a'.repeat(64);

function command(workflowId, type, revision, overrides = {}) {
  return {
    schema_version: 1,
    command_id: `CMD-${randomUUID()}`,
    workflow_id: workflowId,
    expected_revision: revision,
    command_type: type,
    actor: 'test',
    occurred_at: new Date(Date.UTC(2026, 7, 10, 1, 0, revision)).toISOString(),
    reason: `StateGraph test ${type}`,
    payload: {},
    ...overrides,
  };
}

function fixture(name) {
  const directory = mkdtempSync(join(tmpdir(), `workflow-graph-${name}-`));
  const databasePath = join(directory, 'control.db');
  const workflowId = `WF-graph-${name}`;
  const database = openControlDatabase(databasePath);
  const controls = createControlRepository(ROOT, database);
  controls.apply(command(workflowId, 'BOOTSTRAP', 0, { payload: { contract_set_id: 'graph-test', agent_bundle_id: BUNDLE } }));
  database.close();
  return {
    workflowId,
    databasePath,
    open() { const db = openControlDatabase(databasePath); return { db, controls: createControlRepository(ROOT, db) }; },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}

async function turn(value, suffix = 'run') {
  return runWorkflowTurn({
    projectRoot: ROOT,
    databasePath: value.databasePath,
    workflowId: value.workflowId,
    graphRunId: `GR-${suffix}-${randomUUID()}`,
    clock: () => new Date('2026-08-10T02:00:00.000Z'),
  });
}

test('StateGraph can wait for a newer Control Kernel revision without invoking a graph turn', async () => {
  const value = fixture('revision-gate');
  try {
    const result = await runWorkflowTurn({
      projectRoot: ROOT,
      databasePath: value.databasePath,
      workflowId: value.workflowId,
      graphRunId: `GR-revision-${randomUUID()}`,
      afterRevision: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'WAITING_FOR_CHANGE');
    assert.equal(result.result.stop_reason, 'NO_NEW_CONTROL_REVISION');
    assert.equal(result.result.before_revision, 1);
    assert.equal(result.result.after_revision, 1);
  } finally { value.close(); }
});

test('StateGraph advances active INTAKE through the standard path using Control Kernel', async () => {
  const value = fixture('intake');
  try {
    const result = await turn(value, 'intake');
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'PROGRESSED');
    assert.equal(result.result.action, 'ADVANCE_PHASE');
    assert.equal(result.result.phase, 'REQUIREMENTS');
    assert.equal(result.result.after_revision, 2);
    const { db, controls } = value.open();
    try { assert.equal(controls.get(value.workflowId).phase, 'REQUIREMENTS'); }
    finally { db.close(); }
  } finally { value.close(); }
});

test('StateGraph stops on a durable pending approval without mutating workflow state', async () => {
  const value = fixture('waiting');
  try {
    const { db, controls } = value.open();
    controls.requestDemoFastApproval(value.workflowId, { occurred_at: '2026-08-10T01:01:00.000Z' });
    db.close();
    const result = await turn(value, 'waiting');
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'WAITING_HUMAN');
    assert.equal(result.result.before_revision, 2);
    assert.equal(result.result.after_revision, 2);
  } finally { value.close(); }
});

test('StateGraph only takes the demo path after the bound DEMO_FAST approval is resolved', async () => {
  const value = fixture('demo');
  try {
    const { db, controls } = value.open();
    const requested = controls.requestDemoFastApproval(value.workflowId, { occurred_at: '2026-08-10T01:01:00.000Z' });
    const request = requested.event.payload.approval_request;
    controls.resolveApproval({
      schema_version: 1,
      decision_id: request.decision_id,
      workflow_id: value.workflowId,
      task_id: null,
      run_id: null,
      outcome: 'APPROVED',
      chosen_option_id: 'DEMO_FAST',
      raw_user_reply_summary: '用户明确选择 DEMO_FAST。',
      decided_by: 'human:test',
      decided_at: '2026-08-10T01:02:00.000Z',
      notes: '',
    });
    db.close();
    const result = await turn(value, 'demo');
    assert.equal(result.ok, true);
    assert.equal(result.result.phase, 'DEVELOPMENT');
    assert.equal(result.result.after_revision, 4);
  } finally { value.close(); }
});

test('StateGraph returns NEEDS_TASK when an active task phase has no registered package', async () => {
  const value = fixture('needs-task');
  try {
    const { db, controls } = value.open();
    controls.apply(command(value.workflowId, 'ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' }));
    db.close();
    const result = await turn(value, 'needs-task');
    assert.equal(result.ok, true);
    assert.equal(result.result.status, 'NEEDS_TASK');
    assert.equal(result.result.after_revision, 2);
    assert.equal(result.result.stop_reason, 'GRAPH_TASK_REQUIRED:REQUIREMENTS');
  } finally { value.close(); }
});

function stubAdapter({ phase, task = null, taskResult = null, declared = {}, latestDeclared = null, candidate = null, dispatchEffect = null }) {
  let control = {
    workflow_id: 'WF-graph-stub', revision: 3, phase, condition: 'ACTIVE', outcome: null,
    current_candidate_commit: candidate,
  };
  return {
    audit: () => ({ ok: true, errors: [] }),
    getWorkflow: () => control,
    snapshot: () => ({ workflows: [{ ...control }] }),
    approvals: () => [],
    latestTask: () => task,
    taskResult: () => taskResult,
    readDeclaredOutput: (_task, schema) => declared[schema] ? { task, value: declared[schema] } : null,
    latestDeclaredOutput: () => latestDeclared,
    validateTask: () => { throw new Error('unexpected validation'); },
    dispatch: () => {
      if (!dispatchEffect) throw new Error('unexpected dispatch');
      const changed = dispatchEffect({ task, control });
      task = changed.task;
      control = changed.control;
      return changed.result ?? { ok: true };
    },
    apply: (_graphRunId, _workflow, action) => {
      control = {
        ...control,
        revision: control.revision + 1,
        phase: action.target_phase ?? control.phase,
        condition: action.command_type === 'HOLD' ? 'HOLD' : action.command_type === 'COMPLETE' ? 'TERMINAL' : control.condition,
        outcome: action.outcome ?? control.outcome,
        current_candidate_commit: action.candidate_commit ?? control.current_candidate_commit,
      };
      return { state: control };
    },
  };
}

async function invokeStub(adapter) {
  const { policy, machine } = loadWorkflowGraphPolicy(ROOT);
  return buildWorkflowGraph({ adapter, policy, machine }).invoke({ workflowId: 'WF-graph-stub', graphRunId: 'GR-graph-stub' });
}

test('task phase advances only from a completed, locally ingested task result', async () => {
  const task = { task_id: 'TASK-graph-requirements', run_id: 'RUN-graph-requirements', task_type: 'REQUIREMENTS', assigned_agent: 'requirement-agent', status: 'COMPLETED' };
  const state = await invokeStub(stubAdapter({ phase: 'REQUIREMENTS', task, taskResult: { result_status: 'COMPLETED' } }));
  assert.equal(state.action, 'ADVANCE_PHASE');
  assert.equal(state.control.phase, 'REQUIREMENT_GATE');
  assert.equal(state.afterRevision, 4);
});

test('gate phase recomputes PASS from items before advancing', async () => {
  const task = { task_id: 'TASK-graph-gate', run_id: 'RUN-graph-gate' };
  const gate = {
    task,
    value: {
      workflow_id: 'WF-graph-stub', task_id: task.task_id, gate_name: 'RequirementGate', overall: 'PASS',
      items: [{ status: 'PASS', blocking: true }],
    },
  };
  const state = await invokeStub(stubAdapter({ phase: 'REQUIREMENT_GATE', latestDeclared: gate }));
  assert.equal(state.action, 'ADVANCE_PHASE');
  assert.equal(state.control.phase, 'ARCHITECTURE');
});

test('development phase fixes the candidate commit before changing phase', async () => {
  const task = { task_id: 'TASK-graph-dev', run_id: 'RUN-graph-dev', task_type: 'DEVELOPMENT', assigned_agent: 'developer-agent', status: 'COMPLETED' };
  const state = await invokeStub(stubAdapter({ phase: 'DEVELOPMENT', task, taskResult: { result_status: 'COMPLETED', output_commit: 'abc123' } }));
  assert.equal(state.action, 'SET_CANDIDATE');
  assert.equal(state.control.phase, 'DEVELOPMENT');
  assert.equal(state.control.current_candidate_commit, 'abc123');
});

test('task dispatch refreshes workflow revision when the worker requests human approval', async () => {
  const task = { task_id: 'TASK-graph-human', run_id: 'RUN-graph-human', task_type: 'REQUIREMENTS', assigned_agent: 'requirement-agent', status: 'READY' };
  const state = await invokeStub(stubAdapter({
    phase: 'REQUIREMENTS',
    task,
    dispatchEffect: ({ task: currentTask, control }) => ({
      task: { ...currentTask, status: 'WAITING_HUMAN' },
      control: { ...control, revision: control.revision + 1, condition: 'WAITING_HUMAN' },
    }),
  }));
  assert.equal(state.status, 'WAITING_HUMAN');
  assert.equal(state.control.condition, 'WAITING_HUMAN');
  assert.equal(state.afterRevision, 4);
});

test('FINAL_REPORT completes only from a recomputed release decision bound to the candidate', async () => {
  const task = { task_id: 'TASK-graph-release', run_id: 'RUN-graph-release' };
  const release = {
    task,
    value: {
      workflow_id: 'WF-graph-stub', task_id: task.task_id, run_id: task.run_id, candidate_commit: 'abc123', verdict: 'GO',
      checks: [{ name: 'all', status: 'PASS', evidence_refs: ['EVD-1'] }], evidence_refs: ['EVD-1'],
    },
  };
  const state = await invokeStub(stubAdapter({ phase: 'FINAL_REPORT', latestDeclared: release, candidate: 'abc123' }));
  assert.equal(state.action, 'COMPLETE');
  assert.equal(state.control.condition, 'TERMINAL');
  assert.equal(state.control.outcome, 'READY_FOR_OPERATIONS_HANDOFF');
});
