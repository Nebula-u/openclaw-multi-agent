import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createKernelMonitorServer } from '../monitor/kernel-server.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('Kernel Monitor exposes read-only workflow, HR and session endpoints', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'kernel-monitor-'));
  const workflowId = 'WF-monitor-kernel';
  const run = { runId: 'RUN-monitor', workflowId, state: 'ACTIVE', outcome: null, statusReason: null, routeHash: 'a'.repeat(64), routePlan: { display_title: 'Review', summary: 'Review', steps: [], skipped_stages: [] }, currentStepIndex: 0, managerSessionId: 'manager-session', managerDelivery: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const kernel = { listRuns: async () => [run], listTasks: async () => [], listExecutions: async () => [] };
  const repository = { listHrJobs: async () => [], listNotifications: async () => [] };
  const monitor = createKernelMonitorServer({ projectRoot: ROOT, sessionRoot: join(temp, 'sessions'), monitorDatabasePath: ':memory:', host: '127.0.0.1', port: 0, allowedOrigins: ['null'], reconcileIntervalMs: 1000, sseRetention: 10 }, { kernel, repository });
  const address = await monitor.start();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const workflows = await fetch(`${base}/api/workflows`, { headers: { origin: 'null' } });
    assert.equal(workflows.status, 200); assert.equal((await workflows.json()).workflows[0].workflow_id, workflowId);
    const alerts = await fetch(`${base}/api/hr/alerts`, { headers: { origin: 'null' } });
    assert.equal(alerts.status, 200); assert.deepEqual((await alerts.json()).alerts, []);
    const write = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 403); assert.equal((await write.json()).error, 'MONITOR_READ_ONLY');
  } finally { await monitor.close(); rmSync(temp, { recursive: true, force: true }); }
});
