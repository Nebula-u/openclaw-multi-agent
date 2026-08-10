import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { exportControlProjections } from '../scripts/control-core/projections.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-control-kernel-test';
const BUNDLE = 'a'.repeat(64);

function command(type, revision, overrides = {}) {
  return {
    schema_version: 1,
    command_id: `CMD-${randomUUID()}`,
    workflow_id: WORKFLOW_ID,
    expected_revision: revision,
    command_type: type,
    actor: 'manager-agent',
    occurred_at: new Date(Date.UTC(2026, 7, 5, 0, 0, revision)).toISOString(),
    reason: `${type} test`,
    payload: {},
    ...overrides,
  };
}

function fixture({ memory = true } = {}) {
  const directory = memory ? null : mkdtempSync(join(tmpdir(), 'control-kernel-'));
  const path = memory ? ':memory:' : join(directory, 'control.db');
  const database = openControlDatabase(path);
  const repository = createControlRepository(ROOT, database);
  return {
    database,
    repository,
    path,
    close() {
      database.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function bootstrap(repository, overrides = {}) {
  return repository.apply(command('BOOTSTRAP', 0, {
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: BUNDLE },
    ...overrides,
  }));
}

test('control kernel bootstraps and atomically advances a workflow', () => {
  const value = fixture();
  try {
    const created = bootstrap(value.repository);
    assert.equal(created.state.phase, 'INTAKE');
    assert.equal(created.state.condition, 'ACTIVE');
    assert.equal(created.revision, 1);
    const advanced = value.repository.apply(command('ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' }));
    assert.equal(advanced.state.phase, 'REQUIREMENTS');
    assert.equal(advanced.revision, 2);
    const events = value.repository.events(WORKFLOW_ID);
    assert.equal(events.length, 2);
    assert.equal(events[1].previous_event_hash, events[0].event_hash);
    assert.deepEqual(events[1].to_state, advanced.state);
  } finally { value.close(); }
});

test('control kernel rejects stale revisions and illegal phase edges without mutation', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', 0, { target_phase: 'REQUIREMENTS' })),
      (error) => error.code === 'CONTROL_REVISION_CONFLICT');
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', 1, { target_phase: 'DEVELOPMENT' })),
      (error) => error.code === 'CONTROL_DEMO_FAST_APPROVAL_REQUIRED');
    assert.equal(value.repository.get(WORKFLOW_ID).revision, 1);
    assert.equal(value.repository.events(WORKFLOW_ID).length, 1);
  } finally { value.close(); }
});

test('control kernel preserves pause and resume semantics', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const waiting = value.repository.apply(command('WAIT_HUMAN', 1));
    assert.equal(waiting.state.condition, 'WAITING_HUMAN');
    const held = value.repository.apply(command('HOLD', 2));
    assert.equal(held.state.condition, 'HOLD');
    const backToWaiting = value.repository.apply(command('RESUME', 3));
    assert.equal(backToWaiting.state.condition, 'WAITING_HUMAN');
    const active = value.repository.apply(command('RESUME', 4));
    assert.equal(active.state.condition, 'ACTIVE');
    assert.equal(active.state.phase, 'INTAKE');
  } finally { value.close(); }
});

test('v2 approval requests are persisted and cannot be bypassed by RESUME', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const request = {
      schema_version: 1,
      decision_id: 'DEC-control-kernel-test',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      trigger: 'IMPLEMENTATION_TRADEOFF',
      summary: '选择是否继续当前演示路径',
      options: [{ option_id: 'PROCEED', description: '继续', impact: '继续后续任务', reversibility: 'reversible' }],
      recommended_option: { option_id: 'PROCEED', rationale: '演示路径可回退' },
      evidence_refs: [],
      created_at: '2026-08-07T03:00:00.000Z',
      status: 'PENDING',
    };
    const waiting = value.repository.requestApproval(request, { occurred_at: '2026-08-07T03:00:00.000Z' });
    assert.equal(waiting.state.condition, 'WAITING_HUMAN');
    assert.equal(value.repository.approvals({ status: 'PENDING' }).length, 1);
    assert.throws(() => value.repository.apply(command('RESUME', 2)),
      (error) => error.code === 'CONTROL_APPROVAL_RESPONSE_REQUIRED');
    const response = {
      schema_version: 1,
      decision_id: request.decision_id,
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      outcome: 'APPROVED',
      chosen_option_id: 'PROCEED',
      raw_user_reply_summary: '用户明确批准继续。',
      decided_by: 'human:user',
      decided_at: '2026-08-07T03:00:01.000Z',
      notes: '',
    };
    const resumed = value.repository.resolveApproval(response);
    assert.equal(resumed.state.condition, 'ACTIVE');
    assert.equal(value.repository.approvals({ status: 'RESOLVED' })[0].response.outcome, 'APPROVED');
    assert.equal(auditControlDatabase(value.database).ok, true, JSON.stringify(auditControlDatabase(value.database)));
  } finally { value.close(); }
});

test('Demo fast path cannot skip from INTAKE to DEVELOPMENT without DEMO_FAST approval', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const requested = value.repository.requestDemoFastApproval(WORKFLOW_ID, { occurred_at: '2026-08-07T03:00:00.000Z' });
    const request = requested.event.payload.approval_request;
    const response = {
      schema_version: 1, decision_id: request.decision_id, workflow_id: WORKFLOW_ID, task_id: null, run_id: null,
      outcome: 'APPROVED', chosen_option_id: 'DEMO_FAST', raw_user_reply_summary: '用户明确选择 DEMO_FAST。',
      decided_by: 'human:user', decided_at: '2026-08-07T03:00:01.000Z', notes: '',
    };
    const resumed = value.repository.resolveApproval(response);
    const advanced = value.repository.apply(command('ADVANCE_PHASE', resumed.state.revision, {
      target_phase: 'DEVELOPMENT', payload: { approval_decision_id: request.decision_id },
    }));
    assert.equal(advanced.state.phase, 'DEVELOPMENT');
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', advanced.state.revision, { target_phase: 'REQUIREMENTS' })),
      (error) => error.code === 'CONTROL_PHASE_TRANSITION_INVALID');
  } finally { value.close(); }
});

test('control kernel makes command replay idempotent and rejects reused ids', () => {
  const value = fixture();
  try {
    const original = command('BOOTSTRAP', 0, { payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: BUNDLE } });
    const first = value.repository.apply(original);
    const replay = value.repository.apply(original);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.event.event_hash, first.event.event_hash);
    assert.equal(value.repository.events(WORKFLOW_ID).length, 1);
    assert.throws(() => value.repository.apply({ ...original, reason: 'different content' }),
      (error) => error.code === 'CONTROL_IDEMPOTENCY_CONFLICT');
  } finally { value.close(); }
});

test('control kernel persists state and prevents event update or delete', () => {
  const value = fixture({ memory: false });
  try {
    bootstrap(value.repository);
    assert.throws(() => value.database.exec("UPDATE workflow_events SET event_type='X'"), /immutable/);
    assert.throws(() => value.database.exec('DELETE FROM workflow_events'), /immutable/);
    value.database.close();
    const reopened = openControlDatabase(value.path);
    try {
      const repository = createControlRepository(ROOT, reopened);
      assert.equal(repository.get(WORKFLOW_ID).revision, 1);
      assert.equal(repository.events(WORKFLOW_ID).length, 1);
    } finally { reopened.close(); }
    value.close = () => rmSync(resolve(value.path, '..'), { recursive: true, force: true });
  } finally { value.close(); }
});

test('control kernel only completes an active FINAL_REPORT workflow with a release outcome', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const path = [
      'REQUIREMENTS', 'REQUIREMENT_GATE', 'ARCHITECTURE', 'ARCHITECTURE_GATE',
      'DEVELOPMENT', 'CODE_REVIEW', 'TESTING', 'TEST_CODE_REVIEW',
      'RELEASE_VERIFICATION', 'FINAL_REPORT',
    ];
    let revision = 1;
    for (const phase of path) {
      value.repository.apply(command('ADVANCE_PHASE', revision, { target_phase: phase }));
      revision += 1;
    }
    const completed = value.repository.apply(command('COMPLETE', revision, { outcome: 'READY_FOR_OPERATIONS_HANDOFF' }));
    assert.equal(completed.state.condition, 'TERMINAL');
    assert.equal(completed.state.outcome, 'READY_FOR_OPERATIONS_HANDOFF');
    assert.throws(() => value.repository.apply(command('SET_CANDIDATE', revision + 1, { candidate_commit: 'abc' })),
      (error) => error.code === 'CONTROL_WORKFLOW_TERMINAL');
  } finally { value.close(); }
});

test('control projections derive workflow, events, and active index from SQLite', () => {
  const value = fixture();
  const runtime = mkdtempSync(join(tmpdir(), 'control-projection-'));
  try {
    bootstrap(value.repository);
    assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='PENDING'").get().count, 1);
    const projected = exportControlProjections(value.database, runtime);
    assert.equal(projected.active_workflows, 1);
    const root = join(runtime, 'control', 'v2');
    const state = JSON.parse(readFileSync(join(root, 'workflows', WORKFLOW_ID, 'workflow.json'), 'utf8'));
    assert.equal(state.revision, 1);
    const active = JSON.parse(readFileSync(join(root, 'active-workflows.json'), 'utf8'));
    assert.equal(active.projection, 'READ_ONLY_DERIVED');
    assert.equal(active.workflows[0].workflow_id, WORKFLOW_ID);
    assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='APPLIED'").get().count, 1);
    assert.equal(auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true }).ok, true);
    value.repository.apply(command('QUARANTINE', 1));
    exportControlProjections(value.database, runtime);
    const terminalActive = JSON.parse(readFileSync(join(root, 'active-workflows.json'), 'utf8'));
    assert.deepEqual(terminalActive.workflows, []);
  } finally {
    value.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('projection audit detects drift and recoverable export restores it', () => {
  const value = fixture();
  const runtime = mkdtempSync(join(tmpdir(), 'control-projection-drift-'));
  try {
    bootstrap(value.repository);
    exportControlProjections(value.database, runtime);
    const path = join(runtime, 'control', 'v2', 'workflows', WORKFLOW_ID, 'workflow.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.phase = 'DEVELOPMENT';
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    const drifted = auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true });
    assert.equal(drifted.ok, false);
    assert.ok(drifted.errors.some((error) => error.code === 'CONTROL_PROJECTION_STATE_DRIFT'));
    exportControlProjections(value.database, runtime);
    assert.equal(auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true }).ok, true);
  } finally {
    value.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('database audit detects current state that no longer matches the immutable event chain', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const changed = value.repository.get(WORKFLOW_ID);
    changed.phase = 'DEVELOPMENT';
    value.database.prepare('UPDATE workflows SET phase=?, state_json=? WHERE workflow_id=?')
      .run(changed.phase, JSON.stringify(changed), WORKFLOW_ID);
    const audit = auditControlDatabase(value.database);
    assert.equal(audit.ok, false);
    assert.ok(audit.errors.some((error) => error.code === 'CONTROL_CURRENT_STATE_MISMATCH'));
  } finally { value.close(); }
});
