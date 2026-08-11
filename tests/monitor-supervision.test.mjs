import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { openControlDatabase, createControlRepository } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';
import { createControlSnapshot } from '../scripts/control-core/read-model.mjs';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-supervision-test';
const REQUEST_ID = 'SUP-supervision-test';
const NOW = '2026-08-06T08:00:00.000Z';

function setup() {
  const database = openControlDatabase(':memory:');
  const controls = createControlRepository(ROOT, database);
  controls.apply({
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: WORKFLOW_ID,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent', occurred_at: NOW,
    reason: 'supervision test', payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
  });
  createTaskRepository(ROOT, database);
  const supervision = createSupervisionRepository(ROOT, database);
  return { database, supervision, close() { database.close(); } };
}

function request(overrides = {}) {
  return {
    schema_version: 1,
    request_id: REQUEST_ID,
    idempotency_key: `${WORKFLOW_ID}/NUDGE/window-1`,
    workflow_id: WORKFLOW_ID,
    request_type: 'NUDGE',
    source: 'WATCHDOG',
    reason: 'No reliable progress signals in threshold window',
    evidence: { health: 'POSSIBLY_STALLED', confidence: 'HIGH' },
    requested_at: NOW,
    ...overrides,
  };
}

test('supervision request, claim, completion and wake outbox are durable and idempotent', () => {
  const value = setup();
  try {
    const first = value.supervision.request(request());
    assert.equal(first.request.status, 'REQUESTED');
    assert.equal(first.wake.status, 'PENDING');
    assert.equal(value.supervision.request(request()).idempotent_replay, true);
    assert.equal(value.supervision.list().length, 1);
    assert.equal(value.supervision.events(REQUEST_ID).length, 2);
    assert.equal(value.supervision.wakeOutbox().length, 1);

    const claimed = value.supervision.claim({
      schema_version: 1, operation_id: 'OP-claim-1', request_id: REQUEST_ID,
      claimed_by: 'manager-agent', claimed_at: '2026-08-06T08:01:00.000Z',
    });
    assert.equal(claimed.request.status, 'CLAIMED');
    assert.equal(value.supervision.claim({
      schema_version: 1, operation_id: 'OP-claim-1', request_id: REQUEST_ID,
      claimed_by: 'manager-agent', claimed_at: '2026-08-06T08:01:00.000Z',
    }).idempotent_replay, true);

    const completed = value.supervision.complete({
      schema_version: 1, operation_id: 'OP-complete-1', request_id: REQUEST_ID,
      status: 'SUCCEEDED', completed_at: '2026-08-06T08:02:00.000Z',
      result_code: 'NUDGE_ACKNOWLEDGED', result_summary: 'Original session reported progress.',
    });
    assert.equal(completed.request.status, 'SUCCEEDED');
    assert.equal(value.supervision.events(REQUEST_ID).at(-1).event_type, 'REQUEST_COMPLETED');
    assert.equal(auditControlDatabase(value.database).ok, true);
  } finally { value.close(); }
});

test('supervision request validates workflow scope and idempotency conflicts', () => {
  const value = setup();
  try {
    value.supervision.request(request());
    assert.throws(() => value.supervision.request(request({ request_id: 'SUP-other' })),
      (error) => error.code === 'SUPERVISION_IDEMPOTENCY_CONFLICT');
    assert.throws(() => value.supervision.request(request({
      request_id: 'SUP-missing-workflow', idempotency_key: 'missing/window', workflow_id: 'WF-missing',
    })), (error) => error.code === 'SUPERVISION_WORKFLOW_NOT_FOUND');
  } finally { value.close(); }
});

test('manager wake record updates outbox and supervision event chain', () => {
  const value = setup();
  try {
    value.supervision.request(request());
    const wakeId = `WAKE-${REQUEST_ID.slice(4)}`;
    const failed = value.supervision.recordWake({
      schema_version: 1, operation_id: 'OP-wake-failed', wake_id: wakeId, status: 'FAILED',
      attempted_at: '2026-08-06T08:00:10.000Z', manager_session_key: null,
      error: 'gateway unavailable', next_attempt_at: '2026-08-06T08:00:40.000Z',
    });
    assert.equal(failed.wake.status, 'FAILED');
    const delivered = value.supervision.recordWake({
      schema_version: 1, operation_id: 'OP-wake-delivered', wake_id: wakeId, status: 'DELIVERED',
      attempted_at: '2026-08-06T08:00:40.000Z', manager_session_key: 'agent:manager-agent:main',
      error: null, next_attempt_at: null,
    });
    assert.equal(delivered.wake.status, 'DELIVERED');
    assert.equal(value.supervision.wakeOutbox().length, 0);
    assert.equal(auditControlDatabase(value.database).ok, true);
  } finally { value.close(); }
});

test('control snapshot joins workflow and supervision state without mutating control data', () => {
  const value = setup();
  try {
    value.supervision.request(request());
    const snapshot = createControlSnapshot(value.database, { workflowId: WORKFLOW_ID });
    assert.equal(snapshot.schema_version, 1);
    assert.equal(snapshot.workflows.length, 1);
    assert.equal(snapshot.workflows[0].workflow_id, WORKFLOW_ID);
    assert.deepEqual(snapshot.workflows[0].tasks, []);
    assert.equal(snapshot.supervision[0].request_id, REQUEST_ID);
    assert.equal(snapshot.supervision[0].status, 'REQUESTED');
  } finally { value.close(); }
});

test('manager context snapshot omits historical and payload-heavy control details', () => {
  const value = setup();
  try {
    const snapshot = createControlSnapshot(value.database, { workflowId: WORKFLOW_ID, view: 'manager' });
    assert.equal(snapshot.view, 'manager-context');
    assert.equal(snapshot.workflow.workflow_id, WORKFLOW_ID);
    assert.deepEqual(snapshot.active_tasks, []);
    assert.deepEqual(snapshot.pending_approvals, []);
    assert.deepEqual(snapshot.dispatch_outbox, []);
    assert.equal(snapshot.omitted.historical_events, true);
    assert.equal(snapshot.omitted.completion_payloads, true);
  } finally { value.close(); }
});

test('audit detects a tampered supervision event hash', () => {
  const value = setup();
  try {
    value.supervision.request(request());
    value.database.exec('DROP TRIGGER supervision_events_no_update');
    value.database.prepare("UPDATE supervision_events SET event_hash=? WHERE request_id=? AND seq=1")
      .run('f'.repeat(64), REQUEST_ID);
    const audit = auditControlDatabase(value.database);
    assert.equal(audit.ok, false);
    assert.ok(audit.errors.some((error) => error.code === 'SUPERVISION_EVENT_HASH'));
  } finally { value.close(); }
});

test('manual pause, resume, cancel, retry review and escalation remain requests without direct state mutation', () => {
  const value = setup();
  try {
    const before = value.database.prepare('SELECT state_json FROM workflows WHERE workflow_id=?').get(WORKFLOW_ID).state_json;
    const types = ['SEND_MESSAGE', 'RECONCILE', 'RETRY_REVIEW', 'PAUSE_REQUEST', 'RESUME_REQUEST', 'CANCEL_REQUEST', 'ESCALATE'];
    types.forEach((requestType, index) => value.supervision.request(request({
      request_id: `SUP-manual-${index}`, idempotency_key: `${WORKFLOW_ID}/${requestType}/${index}`,
      request_type: requestType, source: 'LOCAL_USER', reason: `manual ${requestType}`,
      requested_at: `2026-08-06T08:${String(10 + index).padStart(2, '0')}:00.000Z`,
    })));
    assert.equal(value.supervision.list().length, types.length);
    const after = value.database.prepare('SELECT state_json FROM workflows WHERE workflow_id=?').get(WORKFLOW_ID).state_json;
    assert.equal(after, before);
    assert.equal(auditControlDatabase(value.database).ok, true);
  } finally { value.close(); }
});
