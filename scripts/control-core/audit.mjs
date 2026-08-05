import { canonicalJson } from '../runtime-core/atomic-store.mjs';
import { auditProjectionFiles } from './projections.mjs';
import { listEvents, listWorkflows, storedEventHash } from './repository.mjs';

const ZERO_HASH = '0'.repeat(64);

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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
  return { ok: errors.length === 0, errors, workflows: workflows.length, events: eventCount, commands: commandCount, outbox };
}
