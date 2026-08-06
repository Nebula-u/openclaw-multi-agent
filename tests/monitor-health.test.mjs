import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { classifyTaskHealth, createHealthClassifier } from '../monitor/health-classifier.mjs';
import { createWatchdog } from '../monitor/watchdog.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = new Date('2026-08-06T13:10:00.000Z');

function task(overrides = {}) {
  return { workflow_id: 'WF-health', task_id: 'TASK-health', run_id: 'RUN-health', status: 'RUNNING',
    updated_at: '2026-08-06T13:00:00.000Z', dispatches: [{ status: 'RUNNING', updated_at: '2026-08-06T13:00:00.000Z',
      intent: { lease_deadline: '2026-08-06T13:05:00.000Z' } }], ...overrides };
}

test('health classifier distinguishes waiting, active tool work and possible stall', () => {
  const telemetry = { latestActivity: () => null, latestEvent: () => null };
  assert.equal(classifyTaskHealth(task({ status: 'WAITING_HUMAN' }), { telemetry, now: NOW }).health, 'WAITING_HUMAN');
  const toolTelemetry = { latestActivity: () => ({ kind: 'TOOL_STARTED', status: 'RUNNING', timestamp: '2026-08-06T13:01:00.000Z', summary: 'long test' }), latestEvent: () => null };
  assert.equal(classifyTaskHealth(task(), { telemetry: toolTelemetry, now: NOW, thresholds: { toolRunningGraceSeconds: 900 } }).health, 'RUNNING');
  const stalled = classifyTaskHealth(task(), { telemetry, now: NOW, thresholds: { heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300 } });
  assert.equal(stalled.health, 'POSSIBLY_STALLED');
  assert.equal(stalled.confidence, 'MEDIUM');
  assert.ok(stalled.evidence.some((item) => item.type === 'SIGNAL_AGE' && item.lease_expired));
});

test('health classifier persists changes and watchdog shadow action is deduplicated per cooldown window', () => {
  const database = openTelemetryDatabase(':memory:');
  try {
    const telemetry = createTelemetryRepository(ROOT, database);
    const classifier = createHealthClassifier({ telemetry, now: () => NOW,
      thresholds: { heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300 } });
    const results = classifier.scan({ workflows: [{ workflow_id: 'WF-health', tasks: [task()] }] });
    assert.equal(results[0].health, 'POSSIBLY_STALLED');
    assert.equal(telemetry.health('TASK-health').health, 'POSSIBLY_STALLED');
    const watchdog = createWatchdog({ telemetry, shadowMode: true, cooldownSeconds: 300, now: () => NOW });
    const first = watchdog.scan(results);
    assert.equal(first.length, 1);
    assert.equal(first[0].event.event_type, 'watchdog.shadow_action');
    assert.equal(watchdog.scan(results).length, 0);
    assert.equal(telemetry.events({ workflowId: 'WF-health' }).filter((event) => event.source === 'WATCHDOG').length, 1);
  } finally { database.close(); }
});
