import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createControlSnapshot } from '../scripts/control-core/read-model.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('snapshot read model handles the first-phase target of 100 active workflows', () => {
  const database = openControlDatabase(':memory:');
  try {
    const controls = createControlRepository(ROOT, database);
    for (let index = 0; index < 100; index += 1) controls.apply({ schema_version: 1, command_id: `CMD-perf-${index}-${randomUUID()}`,
      workflow_id: `WF-perf-${String(index).padStart(3, '0')}`, expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent',
      occurred_at: `2026-08-06T15:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`, reason: 'performance fixture',
      payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) } });
    const started = performance.now();
    const snapshot = createControlSnapshot(database);
    const elapsed = performance.now() - started;
    assert.equal(snapshot.workflows.length, 100);
    assert.ok(elapsed < 500, `snapshot took ${elapsed.toFixed(1)}ms`);
  } finally { database.close(); }
});

test('telemetry retention removes old activity while preserving bounded event count', () => {
  const database = openTelemetryDatabase(':memory:');
  try {
    const telemetry = createTelemetryRepository(ROOT, database);
    for (let index = 0; index < 4; index += 1) telemetry.addEvent({ schema_version: 1, event_id: `MEVT-retention-${index}`, sequence: null,
      workflow_id: 'WF-retention', task_id: null, run_id: null, session_id: null, topic: 'monitor.health', event_type: 'health.updated',
      producer: 'test', source: 'HEALTH_CLASSIFIER', timestamp: `2026-08-0${index + 1}T00:00:00.000Z`, payload: {}, meta: { redacted: true, inferred: true, confidence: 'HIGH' } });
    const result = telemetry.prune({ maxEvents: 2, activityRetentionDays: 1, now: new Date('2026-08-06T00:00:00.000Z') });
    assert.equal(result.removed_events, 2);
    assert.equal(telemetry.events({}).length, 2);
  } finally { database.close(); }
});
