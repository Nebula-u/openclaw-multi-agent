import { canonicalJson } from '../runtime-core/atomic-store.mjs';
import { auditProjectionFiles } from './projections.mjs';
import { listEvents, listWorkflows, storedEventHash } from './repository.mjs';
import { storedTaskEventHash } from './task-repository.mjs';
import { storedSupervisionEventHash } from './supervision-repository.mjs';

const ZERO_HASH = '0'.repeat(64);

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function auditTasks(database, errors) {
  if (!tableExists(database, 'tasks')) return { tasks: 0, task_events: 0, dispatches: 0, dispatch_outbox: [] };
  const rows = database.prepare('SELECT * FROM tasks ORDER BY task_id').all();
  for (const row of rows) {
    let task;
    try { task = JSON.parse(row.task_json); }
    catch (error) { errors.push({ code: 'TASK_STATE_JSON_INVALID', task_id: row.task_id, message: error.message }); continue; }
    for (const key of ['task_id', 'workflow_id', 'run_id', 'attempt', 'assigned_agent', 'task_type', 'status', 'output_contract_version']) {
      if (task[key] !== row[key]) errors.push({ code: 'TASK_STATE_COLUMN_MISMATCH', task_id: row.task_id, field: key });
    }
    const run = database.prepare('SELECT * FROM task_runs WHERE run_id=?').get(row.run_id);
    if (!run || run.task_id !== row.task_id || run.attempt !== row.attempt || run.status !== row.status
      || run.contract_set_id !== row.contract_set_id || run.output_contract_version !== row.output_contract_version) {
      errors.push({ code: 'TASK_RUN_MISMATCH', task_id: row.task_id, run_id: row.run_id });
    }
    const events = database.prepare('SELECT * FROM task_events WHERE task_id=? ORDER BY seq').all(row.task_id);
    let priorHash = ZERO_HASH;
    let priorStatus = null;
    for (let index = 0; index < events.length; index += 1) {
      const stored = events[index];
      let payload;
      try { payload = JSON.parse(stored.payload_json); }
      catch (error) { errors.push({ code: 'TASK_EVENT_JSON_INVALID', task_id: row.task_id, seq: stored.seq, message: error.message }); continue; }
      const event = {
        task_id: stored.task_id, seq: stored.seq, event_id: stored.event_id, event_type: stored.event_type,
        occurred_at: stored.occurred_at, from_status: stored.from_status, to_status: stored.to_status,
        payload, previous_event_hash: stored.previous_event_hash, event_hash: stored.event_hash,
      };
      if (event.seq !== index + 1) errors.push({ code: 'TASK_EVENT_SEQUENCE', task_id: row.task_id, seq: event.seq, expected: index + 1 });
      if (event.previous_event_hash !== priorHash) errors.push({ code: 'TASK_EVENT_PREVIOUS_HASH', task_id: row.task_id, seq: event.seq });
      if (event.event_hash !== storedTaskEventHash(event)) errors.push({ code: 'TASK_EVENT_HASH', task_id: row.task_id, seq: event.seq });
      if (event.from_status !== priorStatus) errors.push({ code: 'TASK_EVENT_FROM_STATUS', task_id: row.task_id, seq: event.seq });
      priorHash = event.event_hash;
      priorStatus = event.to_status;
    }
    if (events.length === 0 || priorStatus !== row.status) errors.push({ code: 'TASK_CURRENT_STATUS_MISMATCH', task_id: row.task_id, status: row.status, event_status: priorStatus });
  }
  const dispatchRows = database.prepare('SELECT * FROM dispatches ORDER BY dispatch_id').all();
  for (const row of dispatchRows) {
    let intent; let receipt; let completion;
    try {
      intent = JSON.parse(row.intent_json);
      receipt = row.latest_receipt_json ? JSON.parse(row.latest_receipt_json) : null;
      completion = row.completion_json ? JSON.parse(row.completion_json) : null;
    } catch (error) { errors.push({ code: 'DISPATCH_JSON_INVALID', dispatch_id: row.dispatch_id, message: error.message }); continue; }
    for (const key of ['dispatch_id', 'idempotency_key', 'workflow_id', 'task_id', 'run_id', 'agent_id', 'attempt', 'session_key', 'input_manifest_sha256']) {
      if (intent[key] !== row[key]) errors.push({ code: 'DISPATCH_INTENT_COLUMN_MISMATCH', dispatch_id: row.dispatch_id, field: key });
    }
    if ((receipt?.session_id ?? null) !== row.session_id) errors.push({ code: 'DISPATCH_SESSION_MISMATCH', dispatch_id: row.dispatch_id });
    const expectedStatus = completion?.status ?? receipt?.status ?? 'PREPARED';
    if (row.status !== expectedStatus) errors.push({ code: 'DISPATCH_STATUS_MISMATCH', dispatch_id: row.dispatch_id, status: row.status, expected: expectedStatus });
    const outbox = database.prepare('SELECT status FROM dispatch_outbox WHERE dispatch_id=?').get(row.dispatch_id);
    // A failed completion without a receipt means the local process did not
    // establish an Agent session (for example, spawn openclaw -> ENOENT).
    // failDispatch deliberately marks that outbox entry FAILED.  Error codes
    // from the operating system are not necessarily ORCHESTRATOR_* codes.
    const localExecutionFailure = completion?.status === 'FAILED'
      && (!receipt || /^(?:ORCHESTRATOR_|TASK_OUTPUT_|TASK_OUTPUT_INGESTION_)/u.test(String(completion.error_code ?? '')));
    const expectedOutboxStatus = localExecutionFailure ? 'FAILED' : receipt ? 'DELIVERED' : 'PENDING';
    if (!outbox || outbox.status !== expectedOutboxStatus) {
      errors.push({ code: 'DISPATCH_OUTBOX_MISMATCH', dispatch_id: row.dispatch_id, outbox_status: outbox?.status ?? null });
    }
  }
  return {
    tasks: rows.length,
    task_events: database.prepare('SELECT COUNT(*) AS count FROM task_events').get().count,
    dispatches: dispatchRows.length,
    dispatch_outbox: database.prepare('SELECT status, COUNT(*) AS count FROM dispatch_outbox GROUP BY status').all(),
  };
}

function auditSupervision(database, errors) {
  if (!tableExists(database, 'supervision_requests')) return { supervision_requests: 0, supervision_events: 0, manager_wake_outbox: [] };
  const rows = database.prepare('SELECT * FROM supervision_requests ORDER BY request_id').all();
  for (const row of rows) {
    let request;
    try { request = JSON.parse(row.request_json); }
    catch (error) { errors.push({ code: 'SUPERVISION_REQUEST_JSON_INVALID', request_id: row.request_id, message: error.message }); continue; }
    for (const key of ['request_id', 'idempotency_key', 'workflow_id', 'task_id', 'run_id', 'dispatch_id', 'target_agent_id', 'request_type', 'source', 'reason', 'requested_at']) {
      if ((request[key] ?? null) !== (row[key] ?? null)) errors.push({ code: 'SUPERVISION_REQUEST_COLUMN_MISMATCH', request_id: row.request_id, field: key });
    }
    const workflow = database.prepare('SELECT 1 AS present FROM workflows WHERE workflow_id=?').get(row.workflow_id);
    if (!workflow) errors.push({ code: 'SUPERVISION_WORKFLOW_MISSING', request_id: row.request_id, workflow_id: row.workflow_id });
    if (row.task_id) {
      const task = database.prepare('SELECT workflow_id, run_id, assigned_agent FROM tasks WHERE task_id=?').get(row.task_id);
      if (!task || task.workflow_id !== row.workflow_id || (row.run_id && task.run_id !== row.run_id)
        || (row.target_agent_id && task.assigned_agent !== row.target_agent_id)) {
        errors.push({ code: 'SUPERVISION_TASK_SCOPE_MISMATCH', request_id: row.request_id });
      }
    }
    if (row.dispatch_id) {
      const dispatch = database.prepare('SELECT workflow_id, task_id, run_id, agent_id FROM dispatches WHERE dispatch_id=?').get(row.dispatch_id);
      if (!dispatch || dispatch.workflow_id !== row.workflow_id || (row.task_id && dispatch.task_id !== row.task_id)
        || (row.run_id && dispatch.run_id !== row.run_id) || (row.target_agent_id && dispatch.agent_id !== row.target_agent_id)) {
        errors.push({ code: 'SUPERVISION_DISPATCH_SCOPE_MISMATCH', request_id: row.request_id });
      }
    }
    const events = database.prepare('SELECT * FROM supervision_events WHERE request_id=? ORDER BY seq').all(row.request_id);
    let priorHash = ZERO_HASH;
    for (let index = 0; index < events.length; index += 1) {
      const stored = events[index];
      let payload;
      try { payload = JSON.parse(stored.payload_json); }
      catch (error) { errors.push({ code: 'SUPERVISION_EVENT_JSON_INVALID', request_id: row.request_id, seq: stored.seq, message: error.message }); continue; }
      const event = { request_id: stored.request_id, seq: stored.seq, event_id: stored.event_id, event_type: stored.event_type,
        occurred_at: stored.occurred_at, payload, previous_event_hash: stored.previous_event_hash, event_hash: stored.event_hash };
      if (event.seq !== index + 1) errors.push({ code: 'SUPERVISION_EVENT_SEQUENCE', request_id: row.request_id, seq: event.seq, expected: index + 1 });
      if (event.previous_event_hash !== priorHash) errors.push({ code: 'SUPERVISION_EVENT_PREVIOUS_HASH', request_id: row.request_id, seq: event.seq });
      if (event.event_hash !== storedSupervisionEventHash(event)) errors.push({ code: 'SUPERVISION_EVENT_HASH', request_id: row.request_id, seq: event.seq });
      priorHash = event.event_hash;
    }
    if (events.length === 0 || events[0].event_type !== 'REQUEST_CREATED') errors.push({ code: 'SUPERVISION_REQUEST_EVENT_MISSING', request_id: row.request_id });
    if (row.status === 'CLAIMED' && !events.some((event) => event.event_type === 'REQUEST_CLAIMED')) errors.push({ code: 'SUPERVISION_CLAIM_EVENT_MISSING', request_id: row.request_id });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status) && !events.some((event) => ['REQUEST_COMPLETED', 'REQUEST_FAILED', 'REQUEST_CANCELLED'].includes(event.event_type))) {
      errors.push({ code: 'SUPERVISION_COMPLETION_EVENT_MISSING', request_id: row.request_id });
    }
  }
  const wakeRows = database.prepare('SELECT * FROM manager_wake_outbox ORDER BY wake_id').all();
  for (const wake of wakeRows) {
    const request = database.prepare('SELECT source FROM supervision_requests WHERE request_id=?').get(wake.request_id);
    if (!request || request.source === 'MANAGER') errors.push({ code: 'MANAGER_WAKE_SCOPE_MISMATCH', wake_id: wake.wake_id });
    if (wake.status === 'DELIVERED' && !wake.delivered_at) errors.push({ code: 'MANAGER_WAKE_DELIVERY_TIME_MISSING', wake_id: wake.wake_id });
  }
  return {
    supervision_requests: rows.length,
    supervision_events: database.prepare('SELECT COUNT(*) AS count FROM supervision_events').get().count,
    manager_wake_outbox: database.prepare('SELECT status, COUNT(*) AS count FROM manager_wake_outbox GROUP BY status').all(),
  };
}

export function auditControlDatabase(database, { runtimeRoot = null, projections = false } = {}) {
  const errors = [];
  const integrity = database.prepare('PRAGMA integrity_check').all();
  for (const row of integrity) {
    const value = row.integrity_check ?? Object.values(row)[0];
    if (value !== 'ok') errors.push({ code: 'CONTROL_SQLITE_INTEGRITY', message: String(value) });
  }
  let workflows;
  try {
    workflows = listWorkflows(database);
  } catch (error) {
    errors.push({ code: 'CONTROL_STATE_JSON_INVALID', message: error.message });
    return { ok: false, errors, workflows: 0, events: 0, commands: 0, outbox: [] };
  }
  for (const state of workflows) {
    let events;
    try {
      events = listEvents(database, state.workflow_id);
    } catch (error) {
      errors.push({ code: 'CONTROL_EVENT_JSON_INVALID', workflow_id: state.workflow_id, message: error.message });
      continue;
    }
    let previousHash = ZERO_HASH;
    let previousState = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const expectedSeq = index + 1;
      if (event.seq !== expectedSeq || event.revision !== expectedSeq) {
        errors.push({ code: 'CONTROL_EVENT_SEQUENCE', workflow_id: state.workflow_id, seq: event.seq, expected: expectedSeq });
      }
      if (event.previous_event_hash !== previousHash) {
        errors.push({ code: 'CONTROL_EVENT_PREVIOUS_HASH', workflow_id: state.workflow_id, seq: event.seq });
      }
      if (event.event_hash !== storedEventHash(event)) {
        errors.push({ code: 'CONTROL_EVENT_HASH', workflow_id: state.workflow_id, seq: event.seq });
      }
      if (!same(event.from_state, previousState)) {
        errors.push({ code: 'CONTROL_EVENT_FROM_STATE', workflow_id: state.workflow_id, seq: event.seq });
      }
      if (event.to_state.revision !== event.revision || event.to_state.workflow_id !== state.workflow_id) {
        errors.push({ code: 'CONTROL_EVENT_TO_STATE', workflow_id: state.workflow_id, seq: event.seq });
      }
      const command = database.prepare('SELECT workflow_id, result_json FROM control_commands WHERE command_id=?').get(event.command_id);
      if (!command || command.workflow_id !== state.workflow_id) {
        errors.push({ code: 'CONTROL_EVENT_COMMAND_MISSING', workflow_id: state.workflow_id, seq: event.seq, command_id: event.command_id });
      }
      previousHash = event.event_hash;
      previousState = event.to_state;
    }
    if (events.length !== state.revision) {
      errors.push({ code: 'CONTROL_REVISION_EVENT_COUNT', workflow_id: state.workflow_id, revision: state.revision, event_count: events.length });
    }
    if (!same(previousState, state)) {
      errors.push({ code: 'CONTROL_CURRENT_STATE_MISMATCH', workflow_id: state.workflow_id });
    }
    const active = database.prepare('SELECT 1 AS present FROM active_workflows WHERE workflow_id=?').get(state.workflow_id);
    if ((state.condition !== 'TERMINAL') !== Boolean(active)) {
      errors.push({ code: 'CONTROL_ACTIVE_VIEW_MISMATCH', workflow_id: state.workflow_id });
    }
  }
  const eventCount = database.prepare('SELECT COUNT(*) AS count FROM workflow_events').get().count;
  const commandCount = database.prepare('SELECT COUNT(*) AS count FROM control_commands').get().count;
  if (eventCount !== commandCount) errors.push({ code: 'CONTROL_COMMAND_EVENT_COUNT', event_count: eventCount, command_count: commandCount });
  if (projections) {
    if (!runtimeRoot) errors.push({ code: 'CONTROL_RUNTIME_ROOT_REQUIRED', message: 'projection audit requires runtimeRoot' });
    else errors.push(...auditProjectionFiles(database, runtimeRoot));
  }
  const outbox = database.prepare(`SELECT status, COUNT(*) AS count FROM projection_outbox GROUP BY status`).all();
  const taskAudit = auditTasks(database, errors);
  const supervisionAudit = auditSupervision(database, errors);
  return { ok: errors.length === 0, errors, workflows: workflows.length, events: eventCount, commands: commandCount, outbox, ...taskAudit, ...supervisionAudit };
}
