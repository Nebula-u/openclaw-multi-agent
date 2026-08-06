import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-monitor-http';

async function setup() {
  const database = openControlDatabase(':memory:');
  const controls = createControlRepository(ROOT, database);
  controls.apply({
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: WORKFLOW_ID,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent',
    occurred_at: '2026-08-06T10:00:00.000Z', reason: 'monitor HTTP test',
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
  });
  const monitor = createMonitorServer({
    projectRoot: ROOT, databasePath: ':memory:', host: '127.0.0.1', port: 0, token: 'test-token',
    allowedOrigins: ['null'], reconcileIntervalMs: 20, sseRetention: 100, requestBodyLimit: 65536,
  }, { database });
  const address = await monitor.start();
  return { monitor, database, base: `http://127.0.0.1:${address.port}`, close: () => monitor.close() };
}

test('monitor HTTP exposes health, workflows and workflow snapshot', async () => {
  const value = await setup();
  try {
    const health = await fetch(`${value.base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'HEALTHY');
    const clientConfig = await (await fetch(`${value.base}/api/client-config`, { headers: { origin: 'null' } })).json();
    assert.equal(clientConfig.token, 'test-token');
    assert.equal(clientConfig.local_only, true);
    const workflows = await (await fetch(`${value.base}/api/workflows`)).json();
    assert.equal(workflows.workflows[0].workflow_id, WORKFLOW_ID);
    const snapshot = await (await fetch(`${value.base}/api/workflows/${WORKFLOW_ID}/snapshot`)).json();
    assert.equal(snapshot.snapshot.workflows[0].workflow_id, WORKFLOW_ID);
    const missing = await fetch(`${value.base}/api/workflows/WF-missing/snapshot`);
    assert.equal(missing.status, 404);
  } finally { await value.close(); }
});

test('monitor rejects unknown origins and requires token for supervision writes', async () => {
  const value = await setup();
  try {
    const rejectedOrigin = await fetch(`${value.base}/api/workflows`, { headers: { origin: 'https://example.invalid' } });
    assert.equal(rejectedOrigin.status, 403);
    const body = {
      schema_version: 1, request_id: 'SUP-monitor-http', idempotency_key: `${WORKFLOW_ID}/NUDGE/window-1`,
      workflow_id: WORKFLOW_ID, request_type: 'NUDGE', source: 'LOCAL_USER', reason: 'Please report progress',
      evidence: { source: 'dashboard' }, requested_at: '2026-08-06T10:00:01.000Z',
    };
    const unauthorized = await fetch(`${value.base}/api/supervision/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: JSON.stringify(body),
    });
    assert.equal(unauthorized.status, 401);
    const created = await fetch(`${value.base}/api/supervision/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-monitor-token': 'test-token', origin: 'null' },
      body: JSON.stringify(body),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).request.status, 'REQUESTED');
    const listed = await (await fetch(`${value.base}/api/supervision`)).json();
    assert.equal(listed.requests.length, 1);
  } finally { await value.close(); }
});

test('monitor accepts explicit activity and exposes agent activity history', async () => {
  const value = await setup();
  try {
    const activity = {
      schema_version: 1, activity_id: 'ACT-monitor-http', workflow_id: WORKFLOW_ID, agent_id: 'manager-agent',
      kind: 'HEARTBEAT', status: 'RUNNING', current_action: 'Monitoring workflow', summary: 'Control state is healthy',
      checkpoint: null, progress: null, tool: null, visibility: 'USER_SAFE', timestamp: '2026-08-06T10:00:02.000Z',
    };
    const response = await fetch(`${value.base}/api/activity`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-monitor-token': 'test-token', origin: 'null' },
      body: JSON.stringify(activity),
    });
    assert.equal(response.status, 201);
    const history = await (await fetch(`${value.base}/api/agents/manager-agent/activity`)).json();
    assert.equal(history.activities[0].activity_id, activity.activity_id);
  } finally { await value.close(); }
});
