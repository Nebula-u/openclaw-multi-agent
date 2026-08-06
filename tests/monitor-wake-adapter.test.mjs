import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';
import { createWakeAdapter } from '../monitor/wake-adapter.mjs';
import { createWatchdog } from '../monitor/watchdog.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function setup() {
  const database = openControlDatabase(':memory:');
  const workflowId = 'WF-wake-adapter';
  createControlRepository(ROOT, database).apply({ schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent', occurred_at: '2026-08-06T14:00:00.000Z',
    reason: 'wake adapter test', payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) } });
  createTaskRepository(ROOT, database);
  const supervision = createSupervisionRepository(ROOT, database);
  supervision.request({ schema_version: 1, request_id: 'SUP-wake-adapter', idempotency_key: `${workflowId}/NUDGE/1`, workflow_id: workflowId,
    request_type: 'NUDGE', source: 'LOCAL_USER', reason: 'status update', evidence: {}, requested_at: '2026-08-06T14:00:01.000Z' });
  return { database, supervision, workflowId };
}

test('wake adapter audits, verifies manager session and records delivered receipt', async () => {
  const value = setup();
  const calls = [];
  try {
    const runner = async (_command, args) => { calls.push(args); return args[0] === 'sessions'
      ? { exitCode: 0, stdout: JSON.stringify({ sessions: [{ key: 'agent:manager-agent:main' }] }), stderr: '', timedOut: false }
      : { exitCode: 0, stdout: '{"ok":true}', stderr: '', timedOut: false }; };
    const adapter = createWakeAdapter({ controlDatabase: value.database, supervision: value.supervision, enabled: true,
      managerSessionKey: 'agent:manager-agent:main', runner, now: () => new Date('2026-08-06T14:00:10.000Z') });
    const result = await adapter.scan();
    assert.equal(result[0].wake.status, 'DELIVERED');
    assert.equal(value.supervision.wakeOutbox().length, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('SUPERVISION_REQUEST SUP-wake-adapter\nRun Control Kernel audit, query the bound workflow/task/dispatch and original session, then claim and process this request. Do not retry or spawn until the original session is confirmed FAILED or LOST.'));
  } finally { value.database.close(); }
});

test('wake adapter fails closed without configured manager session key', async () => {
  const value = setup();
  try {
    const adapter = createWakeAdapter({ controlDatabase: value.database, supervision: value.supervision, enabled: true,
      managerSessionKey: null, runner: async () => { throw new Error('runner must not be called'); },
      now: () => new Date('2026-08-06T14:00:10.000Z') });
    const result = await adapter.scan();
    assert.equal(result[0].wake.status, 'FAILED');
    assert.equal(result[0].wake.last_error, 'MANAGER_SESSION_KEY_REQUIRED');
  } finally { value.database.close(); }
});

test('non-shadow watchdog submits a complete supervision request through the repository boundary', () => {
  const telemetryDb = openTelemetryDatabase(':memory:');
  try {
    const telemetry = createTelemetryRepository(ROOT, telemetryDb);
    const submitted = [];
    const supervision = { request: (request) => { submitted.push(request); return { request: { ...request, status: 'REQUESTED' } }; } };
    const watchdog = createWatchdog({ telemetry, supervision, shadowMode: false, now: () => new Date('2026-08-06T14:05:00.000Z') });
    const actions = watchdog.scan([{ workflow_id: 'WF-watchdog-auto', task_id: 'TASK-watchdog-auto', run_id: 'RUN-watchdog-auto', dispatch_id: 'DSP-watchdog-auto',
      target_agent_id: 'developer-agent', health: 'POSSIBLY_STALLED', confidence: 'MEDIUM', evidence: [] }]);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].request.request.status, 'REQUESTED');
    assert.equal(submitted[0].schema_version, 1);
    assert.equal(submitted[0].source, 'WATCHDOG');
    assert.equal(submitted[0].dispatch_id, 'DSP-watchdog-auto');
  } finally { telemetryDb.close(); }
});
