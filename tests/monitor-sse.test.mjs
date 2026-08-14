import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('SSE sends an initial checkpoint snapshot and replays retained monitor events', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'monitor-sse-'));
  const workflowId = 'WF-monitor-sse';
  const stateRuntime = {
    list: async () => [{ workflowId, revision: 1, phase: 'MANAGER_ANALYSIS', condition: 'ACTIVE', outcome: null,
      request: { text: 'SSE test' }, routePlan: null, approvalPlan: [], pendingApproval: null, currentStepIndex: 0,
      steps: [], managerReports: [], tasks: [], createdAt: '2026-08-06T11:00:00.000Z', updatedAt: '2026-08-06T11:00:00.000Z' }],
    audit: async () => ({ ok: true, database: 'LANGGRAPH_CHECKPOINTS', workflows: [] }),
    run: async () => ({ condition: 'ACTIVE', stop_reason: 'TASK_RUNNING' }),
  };
  const monitor = createMonitorServer({ projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), monitorDatabasePath: ':memory:',
    sessionRoot: join(temp, 'sessions'), host: '127.0.0.1', port: 0, allowedOrigins: ['null'], reconcileIntervalMs: 1000,
    sseRetention: 10, requestBodyLimit: 65536, telemetryMaxEvents: 1000, activityRetentionDays: 30,
    maintenanceIntervalMs: 3600000, heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300, startingTimeoutSeconds: 120,
    toolRunningGraceSeconds: 900, workflowContinuationEnabled: false, workflowContinuationMaxTurns: 8 }, { stateRuntime });
  const address = await monitor.start();
  const controller = new AbortController();
  try {
    monitor.hub.publish('health', { status: 'RUNNING' });
    const response = await fetch('http://127.0.0.1:' + address.port + '/api/workflows/' + workflowId + '/stream?after=0',
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
    rmSync(temp, { recursive: true, force: true });
  }
});
