import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';

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
      (error) => error.code === 'CONTROL_PHASE_TRANSITION_INVALID');
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
