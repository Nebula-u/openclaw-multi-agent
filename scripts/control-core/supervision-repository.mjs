import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../runtime-core/atomic-store.mjs';
import { ControlTransitionError } from './reducer.mjs';

const ZERO_HASH = '0'.repeat(64);

function json(value) { return JSON.stringify(value); }
function parseJson(value) { return value == null ? null : JSON.parse(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(code, message, details = {}) { throw new ControlTransitionError(code, message, details); }

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertValid(validate, value, code) {
  if (!validate(value)) fail(code, 'JSON Schema validation failed', { errors: structuredClone(validate.errors ?? []) });
}

function initialize(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS supervision_requests (
      request_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      dispatch_id TEXT,
      target_agent_id TEXT,
      request_type TEXT NOT NULL,
      source TEXT NOT NULL,
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('REQUESTED', 'CLAIMED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
      requested_at TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      completed_at TEXT,
      result_code TEXT,
      result_summary TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id),
      FOREIGN KEY (run_id) REFERENCES task_runs(run_id),
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(dispatch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS supervision_events (
      request_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      PRIMARY KEY(request_id, seq),
      FOREIGN KEY (request_id) REFERENCES supervision_requests(request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS manager_wake_outbox (
      wake_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DELIVERED', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      manager_session_key TEXT,
      FOREIGN KEY (request_id) REFERENCES supervision_requests(request_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS supervision_operations (
      operation_id TEXT PRIMARY KEY,
      operation_sha256 TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS supervision_events_no_update
      BEFORE UPDATE ON supervision_events BEGIN SELECT RAISE(ABORT, 'supervision events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS supervision_events_no_delete
      BEFORE DELETE ON supervision_events BEGIN SELECT RAISE(ABORT, 'supervision events are immutable'); END;
  `);
}

export function storedSupervisionEventHash(event) {
  return sha256(canonicalJson({
    request_id: event.request_id,
    seq: event.seq,
    event_id: event.event_id,
    event_type: event.event_type,
    occurred_at: event.occurred_at,
    payload: event.payload,
    previous_event_hash: event.previous_event_hash,
  }));
}

function appendEvent(database, requestId, eventType, occurredAt, payload) {
  const prior = database.prepare('SELECT seq, event_hash FROM supervision_events WHERE request_id=? ORDER BY seq DESC LIMIT 1').get(requestId);
  const seq = (prior?.seq ?? 0) + 1;
  const event = {
    request_id: requestId,
    seq,
    event_id: `SEV-${requestId.slice(4)}-${seq}`,
    event_type: eventType,
    occurred_at: occurredAt,
    payload,
    previous_event_hash: prior?.event_hash ?? ZERO_HASH,
  };
  event.event_hash = storedSupervisionEventHash(event);
  database.prepare(`INSERT INTO supervision_events(request_id, seq, event_id, event_type, occurred_at,
    payload_json, previous_event_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.request_id, event.seq, event.event_id, event.event_type, event.occurred_at,
      json(event.payload), event.previous_event_hash, event.event_hash);
  return event;
}

function rowToRequest(row) {
  if (!row) return null;
  return {
    ...parseJson(row.request_json),
    status: row.status,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    result_code: row.result_code,
    result_summary: row.result_summary,
    attempt: row.attempt,
  };
}

function replay(database, operationId, value) {
  const hash = sha256(canonicalJson(value));
  const row = database.prepare('SELECT operation_sha256, result_json FROM supervision_operations WHERE operation_id=?').get(operationId);
  if (!row) return { hash, result: null };
  if (row.operation_sha256 !== hash) fail('SUPERVISION_IDEMPOTENCY_CONFLICT', `operation_id already used: ${operationId}`);
  return { hash, result: { ...parseJson(row.result_json), idempotent_replay: true } };
}

function saveOperation(database, operationId, hash, value, result, occurredAt) {
  database.prepare(`INSERT INTO supervision_operations(operation_id, operation_sha256, operation_json, result_json, committed_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(operationId, hash, canonicalJson(value), json(result), occurredAt);
}

function transactional(database, operationId, value, occurredAt, callback) {
  const prior = replay(database, operationId, value);
  if (prior.result) return prior.result;
  database.exec('BEGIN IMMEDIATE');
  try {
    const afterLock = replay(database, operationId, value);
    if (afterLock.result) {
      database.exec('COMMIT');
      return afterLock.result;
    }
    const result = callback();
    saveOperation(database, operationId, afterLock.hash, value, result, occurredAt);
    database.exec('COMMIT');
    return { ...result, idempotent_replay: false };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* transaction may be closed */ }
    throw error;
  }
}

function assertScope(database, request) {
  const workflow = database.prepare('SELECT workflow_id FROM workflows WHERE workflow_id=?').get(request.workflow_id);
  if (!workflow) fail('SUPERVISION_WORKFLOW_NOT_FOUND', `workflow does not exist: ${request.workflow_id}`);
  if (request.task_id) {
    const task = database.prepare('SELECT workflow_id, run_id, assigned_agent FROM tasks WHERE task_id=?').get(request.task_id);
    if (!task) fail('SUPERVISION_TASK_NOT_FOUND', `task does not exist: ${request.task_id}`);
    if (task.workflow_id !== request.workflow_id) fail('SUPERVISION_SCOPE_MISMATCH', 'task does not belong to workflow');
    if (request.run_id && task.run_id !== request.run_id) fail('SUPERVISION_SCOPE_MISMATCH', 'run does not match task current run');
    if (request.target_agent_id && task.assigned_agent !== request.target_agent_id) fail('SUPERVISION_AGENT_MISMATCH', 'target agent does not match task');
  }
  if (request.run_id) {
    const run = database.prepare('SELECT task_id FROM task_runs WHERE run_id=?').get(request.run_id);
    if (!run) fail('SUPERVISION_RUN_NOT_FOUND', `run does not exist: ${request.run_id}`);
    if (request.task_id && run.task_id !== request.task_id) fail('SUPERVISION_SCOPE_MISMATCH', 'run does not belong to task');
  }
  if (request.dispatch_id) {
    const dispatch = database.prepare('SELECT workflow_id, task_id, run_id, agent_id FROM dispatches WHERE dispatch_id=?').get(request.dispatch_id);
    if (!dispatch) fail('SUPERVISION_DISPATCH_NOT_FOUND', `dispatch does not exist: ${request.dispatch_id}`);
    for (const [key, expected] of [['workflow_id', request.workflow_id], ['task_id', request.task_id], ['run_id', request.run_id], ['agent_id', request.target_agent_id]]) {
      if (expected && dispatch[key] !== expected) fail('SUPERVISION_SCOPE_MISMATCH', `dispatch ${key} mismatch`);
    }
  }
}

export function createSupervisionRepository(projectRootInput, database) {
  initialize(database);
  const projectRoot = resolve(projectRootInput);
  const readSchema = (name) => JSON.parse(readFileSync(join(projectRoot, 'contracts', name), 'utf8'));
  const validators = {
    request: compile(readSchema('supervision-request.schema.json')),
    claim: compile(readSchema('supervision-claim.schema.json')),
    receipt: compile(readSchema('supervision-receipt.schema.json')),
    wake: compile(readSchema('manager-wake-record.schema.json')),
  };

  return {
    request(request) {
      assertValid(validators.request, request, 'SUPERVISION_REQUEST_SCHEMA_INVALID');
      const operationId = `REQUEST:${request.request_id}`;
      return transactional(database, operationId, request, request.requested_at, () => {
        const byKey = database.prepare('SELECT request_json FROM supervision_requests WHERE idempotency_key=?').get(request.idempotency_key);
        if (byKey) {
          const existing = parseJson(byKey.request_json);
          if (canonicalJson(existing) !== canonicalJson(request)) fail('SUPERVISION_IDEMPOTENCY_CONFLICT', 'idempotency_key already used with different request');
          return { ok: true, command: 'supervision-request', request: rowToRequest(database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(existing.request_id)) };
        }
        assertScope(database, request);
        database.prepare(`INSERT INTO supervision_requests(request_id, idempotency_key, workflow_id, task_id, run_id,
          dispatch_id, target_agent_id, request_type, source, reason, evidence_json, request_json, status, requested_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'REQUESTED', ?)`)
          .run(request.request_id, request.idempotency_key, request.workflow_id, request.task_id ?? null,
            request.run_id ?? null, request.dispatch_id ?? null, request.target_agent_id ?? null,
            request.request_type, request.source, request.reason, json(request.evidence), json(request), request.requested_at);
        const event = appendEvent(database, request.request_id, 'REQUEST_CREATED', request.requested_at,
          { request_type: request.request_type, source: request.source, evidence: request.evidence });
        let wake = null;
        if (request.source !== 'MANAGER') {
          wake = { wake_id: `WAKE-${request.request_id.slice(4)}`, request_id: request.request_id, status: 'PENDING', attempts: 0, created_at: request.requested_at };
          database.prepare(`INSERT INTO manager_wake_outbox(wake_id, request_id, status, attempts, created_at)
            VALUES (?, ?, 'PENDING', 0, ?)`).run(wake.wake_id, wake.request_id, wake.created_at);
          appendEvent(database, request.request_id, 'MANAGER_WAKE_QUEUED', request.requested_at, { wake_id: wake.wake_id });
        }
        return { ok: true, command: 'supervision-request', request: rowToRequest(database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(request.request_id)), event, wake };
      });
    },
    claim(claim) {
      assertValid(validators.claim, claim, 'SUPERVISION_CLAIM_SCHEMA_INVALID');
      return transactional(database, claim.operation_id, claim, claim.claimed_at, () => {
        const row = database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(claim.request_id);
        if (!row) fail('SUPERVISION_REQUEST_NOT_FOUND', `request does not exist: ${claim.request_id}`);
        if (row.status !== 'REQUESTED') fail('SUPERVISION_STATUS_INVALID', `cannot claim request in ${row.status}`);
        database.prepare(`UPDATE supervision_requests SET status='CLAIMED', claimed_by=?, claimed_at=?, attempt=attempt+1 WHERE request_id=?`)
          .run(claim.claimed_by, claim.claimed_at, claim.request_id);
        const event = appendEvent(database, claim.request_id, 'REQUEST_CLAIMED', claim.claimed_at, { claimed_by: claim.claimed_by });
        return { ok: true, command: 'supervision-claim', request: rowToRequest(database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(claim.request_id)), event };
      });
    },
    complete(receipt) {
      assertValid(validators.receipt, receipt, 'SUPERVISION_RECEIPT_SCHEMA_INVALID');
      return transactional(database, receipt.operation_id, receipt, receipt.completed_at, () => {
        const row = database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(receipt.request_id);
        if (!row) fail('SUPERVISION_REQUEST_NOT_FOUND', `request does not exist: ${receipt.request_id}`);
        if (!['REQUESTED', 'CLAIMED'].includes(row.status)) fail('SUPERVISION_STATUS_INVALID', `cannot complete request in ${row.status}`);
        database.prepare(`UPDATE supervision_requests SET status=?, completed_at=?, result_code=?, result_summary=? WHERE request_id=?`)
          .run(receipt.status, receipt.completed_at, receipt.result_code, receipt.result_summary, receipt.request_id);
        const eventType = receipt.status === 'SUCCEEDED' ? 'REQUEST_COMPLETED' : receipt.status === 'FAILED' ? 'REQUEST_FAILED' : 'REQUEST_CANCELLED';
        const event = appendEvent(database, receipt.request_id, eventType, receipt.completed_at,
          { result_code: receipt.result_code, result_summary: receipt.result_summary });
        return { ok: true, command: 'supervision-complete', request: rowToRequest(database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(receipt.request_id)), event };
      });
    },
    recordWake(record) {
      assertValid(validators.wake, record, 'MANAGER_WAKE_RECORD_SCHEMA_INVALID');
      return transactional(database, record.operation_id, record, record.attempted_at, () => {
        const wake = database.prepare('SELECT * FROM manager_wake_outbox WHERE wake_id=?').get(record.wake_id);
        if (!wake) fail('MANAGER_WAKE_NOT_FOUND', `wake does not exist: ${record.wake_id}`);
        if (wake.status === 'DELIVERED') fail('MANAGER_WAKE_ALREADY_DELIVERED', 'wake already delivered');
        database.prepare(`UPDATE manager_wake_outbox SET status=?, attempts=attempts+1, next_attempt_at=?, last_error=?,
          delivered_at=?, manager_session_key=? WHERE wake_id=?`)
          .run(record.status, record.next_attempt_at ?? null, record.error ?? null,
            record.status === 'DELIVERED' ? record.attempted_at : null, record.manager_session_key ?? null, record.wake_id);
        const event = appendEvent(database, wake.request_id, record.status === 'DELIVERED' ? 'MANAGER_WAKE_SENT' : 'MANAGER_WAKE_FAILED',
          record.attempted_at, { wake_id: record.wake_id, error: record.error ?? null, manager_session_key: record.manager_session_key ?? null });
        return { ok: true, command: 'wake-record', wake: database.prepare('SELECT * FROM manager_wake_outbox WHERE wake_id=?').get(record.wake_id), event };
      });
    },
    get(requestId) { return rowToRequest(database.prepare('SELECT * FROM supervision_requests WHERE request_id=?').get(requestId)); },
    list({ status = null } = {}) {
      const rows = status
        ? database.prepare('SELECT * FROM supervision_requests WHERE status=? ORDER BY requested_at').all(status)
        : database.prepare('SELECT * FROM supervision_requests ORDER BY requested_at').all();
      return rows.map(rowToRequest);
    },
    events(requestId) {
      return database.prepare('SELECT * FROM supervision_events WHERE request_id=? ORDER BY seq').all(requestId).map((row) => ({
        request_id: row.request_id, seq: row.seq, event_id: row.event_id, event_type: row.event_type,
        occurred_at: row.occurred_at, payload: parseJson(row.payload_json), previous_event_hash: row.previous_event_hash,
        event_hash: row.event_hash,
      }));
    },
    wakeOutbox() { return database.prepare("SELECT * FROM manager_wake_outbox WHERE status <> 'DELIVERED' ORDER BY created_at").all(); },
  };
}

