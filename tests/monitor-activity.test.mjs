import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';
import { createActivityService } from '../monitor/activity-api.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('explicit activity is validated, redacted, persisted and idempotent', () => {
  const control = openControlDatabase(':memory:');
  const telemetryDb = openTelemetryDatabase(':memory:');
  try {
    const workflowId = 'WF-activity-test';
    createControlRepository(ROOT, control).apply({
      schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
      expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent', occurred_at: '2026-08-06T12:00:00.000Z',
      reason: 'activity test', payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
    });
    createTaskRepository(ROOT, control);
    const telemetry = createTelemetryRepository(ROOT, telemetryDb);
    const published = [];
    const service = createActivityService({ controlDatabase: control, telemetry, publish: (...args) => published.push(args) });
    const activity = {
      schema_version: 1, activity_id: 'ACT-activity-test', workflow_id: workflowId, agent_id: 'manager-agent',
      kind: 'PROGRESS', status: 'RUNNING', current_action: 'Checking token=secret-value',
      summary: 'Progress without private reasoning', checkpoint: null, progress: { completed: 1, total: 2, percent: 50 },
      tool: null, visibility: 'USER_SAFE', timestamp: '2026-08-06T12:00:01.000Z',
    };
    const first = service.emit(activity);
    assert.equal(first.idempotent_replay, false);
    assert.doesNotMatch(first.activity.current_action, /secret-value/u);
    assert.equal(telemetry.activities({ agentId: 'manager-agent' }).length, 1);
    assert.equal(published.length, 1);
    assert.equal(service.emit(activity).idempotent_replay, true);
    assert.equal(published.length, 1);
  } finally { control.close(); telemetryDb.close(); }
});

