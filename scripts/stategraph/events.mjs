import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value), 'utf8').digest('hex');
}

export function appendStateEvent(state, changes, type, payload, occurredAt) {
  const revision = Number(state.revision ?? 0) + 1;
  const previous = state.events?.at(-1)?.event_hash ?? null;
  const body = {
    schema_version: 1,
    workflow_id: state.workflowId,
    revision,
    type,
    payload: payload ?? {},
    occurred_at: occurredAt,
    previous_event_hash: previous,
  };
  const event = { ...body, event_hash: sha256(body) };
  return {
    ...changes,
    revision,
    updatedAt: occurredAt,
    events: [...(state.events ?? []), event],
    lastAction: type,
  };
}

export function auditEventChain(state) {
  let previous = null;
  let expectedRevision = 1;
  const errors = [];
  for (const event of state.events ?? []) {
    const { event_hash: recorded, ...body } = event;
    if (event.revision !== expectedRevision) errors.push({ code: 'EVENT_REVISION_GAP', revision: event.revision, expected: expectedRevision });
    if (event.previous_event_hash !== previous) errors.push({ code: 'EVENT_PREVIOUS_HASH_MISMATCH', revision: event.revision });
    if (sha256(body) !== recorded) errors.push({ code: 'EVENT_HASH_MISMATCH', revision: event.revision });
    previous = recorded;
    expectedRevision += 1;
  }
  if ((state.revision ?? 0) !== (state.events?.at(-1)?.revision ?? 0)) {
    errors.push({ code: 'STATE_REVISION_MISMATCH', state_revision: state.revision, event_revision: state.events?.at(-1)?.revision ?? 0 });
  }
  return { ok: errors.length === 0, workflow_id: state.workflowId, revision: state.revision, errors };
}
