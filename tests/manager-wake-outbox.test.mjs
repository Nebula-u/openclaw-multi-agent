import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('manager wake outbox survives process restart until a delivered receipt is recorded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'manager-wake-outbox-'));
  const path = join(directory, 'control.db');
  let database = openControlDatabase(path);
  try {
    const controls = createControlRepository(ROOT, database);
    createTaskRepository(ROOT, database);
    const workflowId = 'WF-wake-restart';
    controls.apply({
      schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
      expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent',
      occurred_at: '2026-08-06T09:00:00.000Z', reason: 'wake restart test',
      payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
    });
    const supervision = createSupervisionRepository(ROOT, database);
    supervision.request({
      schema_version: 1, request_id: 'SUP-wake-restart', idempotency_key: `${workflowId}/NUDGE/window-1`,
      workflow_id: workflowId, request_type: 'NUDGE', source: 'WATCHDOG', reason: 'stalled', evidence: {},
      requested_at: '2026-08-06T09:00:01.000Z',
    });
    assert.equal(supervision.wakeOutbox().length, 1);
    database.close();

    database = openControlDatabase(path);
    createTaskRepository(ROOT, database);
    const reopened = createSupervisionRepository(ROOT, database);
    const [wake] = reopened.wakeOutbox();
    assert.equal(wake.wake_id, 'WAKE-wake-restart');
    reopened.recordWake({
      schema_version: 1, operation_id: 'OP-wake-restart-delivered', wake_id: wake.wake_id,
      status: 'DELIVERED', attempted_at: '2026-08-06T09:00:10.000Z',
      manager_session_key: 'agent:manager-agent:main', error: null, next_attempt_at: null,
    });
    assert.deepEqual(reopened.wakeOutbox(), []);
  } finally {
    try { database.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});
