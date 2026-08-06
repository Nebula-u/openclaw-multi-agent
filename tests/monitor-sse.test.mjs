import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('SSE sends an initial snapshot and replays retained monitor events', async () => {
  const database = openControlDatabase(':memory:');
  const controls = createControlRepository(ROOT, database);
  const workflowId = 'WF-monitor-sse';
  controls.apply({
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent',
    occurred_at: '2026-08-06T11:00:00.000Z', reason: 'monitor SSE test',
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
  });
  const monitor = createMonitorServer({ projectRoot: ROOT, databasePath: ':memory:', host: '127.0.0.1', port: 0,
    token: 'sse-token', allowedOrigins: ['null'], reconcileIntervalMs: 1000, sseRetention: 10, requestBodyLimit: 65536 }, { database });
  const address = await monitor.start();
  const controller = new AbortController();
  try {
    monitor.hub.publish('health', { status: 'RUNNING' });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workflows/${workflowId}/stream?token=sse-token&after=0`,
      { headers: { origin: 'null' }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: health')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    assert.match(text, /event: snapshot/u);
    assert.match(text, /WF-monitor-sse/u);
    assert.match(text, /event: health/u);
  } finally {
    controller.abort();
    await monitor.close();
  }
});
