import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createStateGraphRuntime } from '../scripts/stategraph/runtime.mjs';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
async function setup() {
  const workflowId = `WF-monitor-http-${process.pid}-${Date.now().toString(36)}`;
  const temp = mkdtempSync(join(tmpdir(), 'monitor-stategraph-'));
  const target = join(temp, 'target');
  mkdirSync(target, { recursive: true });
  execFileSync('git', ['init'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'monitor-test@example.invalid'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Monitor Test'], { cwd: target, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', '初始化监控测试仓库'], { cwd: target, stdio: 'ignore' });
  const runtime = createStateGraphRuntime({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), skipAuthority: true,
    dispatcher: { start: (task) => task, reconcile: (task) => ({ kind: 'WAITING', task }) } });
  await runtime.bootstrap({ workflowId, request: { text: 'monitor HTTP test', project_path_abs: target } });
  const monitor = createMonitorServer({
    projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), monitorDatabasePath: ':memory:', host: '127.0.0.1', port: 0,
    allowedOrigins: ['null'], reconcileIntervalMs: 2000, sseRetention: 100, requestBodyLimit: 65536,
    telemetryMaxEvents: 1000, activityRetentionDays: 30, maintenanceIntervalMs: 3600000,
    heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300, startingTimeoutSeconds: 120, toolRunningGraceSeconds: 900,
    workflowContinuationEnabled: false, workflowContinuationMaxTurns: 8, sessionRoot: join(temp, 'sessions'),
  }, { stateRuntime: runtime });
  const address = await monitor.start();
  return { monitor, runtime, workflowId, temp, base: 'http://127.0.0.1:' + address.port, async close() { await monitor.close(); runtime.close(); rmSync(temp, { recursive: true, force: true }); } };
}

test('monitor reads workflows only from latest LangGraph checkpoints', async () => {
  const value = await setup();
  try {
    const dashboard = await fetch(value.base + '/');
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /OpenClaw Mission Monitor/u);
    assert.match(await (await fetch(value.base + '/app.js')).text(), /EventSource/u);
    assert.match(await (await fetch(value.base + '/styles.css')).text(), /conversation-history/u);
    const health = await fetch(value.base + '/api/health');
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.status, 'HEALTHY');
    assert.equal(healthBody.audit.database, 'LANGGRAPH_CHECKPOINTS');
    const clientConfig = await (await fetch(value.base + '/api/client-config', { headers: { origin: 'null' } })).json();
    assert.equal(clientConfig.local_only, true);
    assert.equal(clientConfig.read_only, true);
    assert.equal(clientConfig.source, 'LANGGRAPH_CHECKPOINTS');
    const workflows = await (await fetch(value.base + '/api/workflows')).json();
    assert.equal(workflows.workflows[0].workflow_id, value.workflowId);
    assert.equal(workflows.workflows[0].protocol_version, 'stategraph-checkpoint-v1');
    const snapshot = await (await fetch(value.base + '/api/workflows/' + value.workflowId + '/snapshot')).json();
    assert.equal(snapshot.snapshot.workflows[0].workflow_id, value.workflowId);
    assert.equal((await fetch(value.base + '/api/workflows/WF-missing/snapshot')).status, 404);
  } finally { await value.close(); }
});

test('monitor remains reachable while reporting a tampered checkpoint event chain', async () => {
  const value = await setup();
  try {
    const state = await value.runtime.state(value.workflowId);
    const tampered = state.events.map((event, index) => index === 0 ? { ...event, type: 'TAMPERED' } : event);
    await value.runtime.graph.updateState({ configurable: { thread_id: value.workflowId, checkpoint_ns: '' } }, { events: tampered });
    const health = await fetch(value.base + '/api/health');
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.api_reachable, true);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'DEGRADED');
  } finally { await value.close(); }
});

test('monitor rejects unknown origins and exposes no mutation endpoint', async () => {
  const value = await setup();
  try {
    assert.equal((await fetch(value.base + '/api/workflows', { headers: { origin: 'https://example.invalid' } })).status, 403);
    assert.equal((await fetch(value.base + '/api/activity', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' })).status, 404);
    assert.equal((await fetch(value.base + '/api/approve', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' })).status, 404);
  } finally { await value.close(); }
});
