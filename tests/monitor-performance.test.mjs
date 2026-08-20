import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function workflows(count, tasksPerWorkflow) {
  return Array.from({ length: count }, (_, workflowIndex) => ({
    workflowId: `WF-performance-${workflowIndex}`,
    revision: 10,
    phase: 'ROUTING',
    condition: 'ACTIVE',
    outcome: null,
    statusReason: 'performance fixture',
    request: { text: `workflow ${workflowIndex}` },
    routePlan: { summary: `workflow ${workflowIndex}`, route_hash: 'a'.repeat(64), status: 'FROZEN' },
    approvalPlan: [],
    pendingApproval: null,
    currentStepIndex: 1,
    steps: [],
    managerReports: [],
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:01.000Z',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, taskIndex) => ({
      task_id: `TASK-performance-${workflowIndex}-${taskIndex}`,
      run_id: `RUN-performance-${workflowIndex}-${taskIndex}`,
      kind: taskIndex % 2 === 0 ? 'DEVELOPMENT' : 'TEST',
      title: `task ${taskIndex}`,
      status: 'ACCEPTED',
      attempt: 1,
      max_attempts: 3,
      json_regenerations: 0,
      max_json_regenerations: 2,
      agent_id: taskIndex % 2 === 0 ? 'developer-agent' : 'test-agent',
      session_id: `session-${workflowIndex}-${taskIndex}`,
      updated_at: '2026-08-14T00:00:01.000Z',
      dispatches: [],
    })),
  }));
}

test('Node monitor materializes a large checkpoint read model within the local refresh budget', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'monitor-performance-'));
  mkdirSync(join(temp, 'sessions'), { recursive: true });
  let listCalls = 0;
  const stateRuntime = {
    async list() { listCalls += 1; return workflows(500, 4); },
    async audit() { return { ok: true, database: 'LANGGRAPH_CHECKPOINTS', workflows: [] }; },
  };
  const monitor = createMonitorServer({
    projectRoot: ROOT, databasePath: join(temp, 'checkpoints.db'), monitorDatabasePath: ':memory:', host: '127.0.0.1', port: 0,
    allowedOrigins: ['null'], reconcileIntervalMs: 60000, sseRetention: 100, requestBodyLimit: 65536,
    telemetryMaxEvents: 1000, activityRetentionDays: 30, maintenanceIntervalMs: 3600000,
    heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300, startingTimeoutSeconds: 120, toolRunningGraceSeconds: 900,
    workflowContinuationEnabled: false, workflowContinuationMaxTurns: 8, sessionRoot: join(temp, 'sessions'),
  }, { stateRuntime });
  try {
    const started = performance.now();
    const snapshot = await monitor.refresh();
    const elapsedMs = performance.now() - started;
    assert.equal(snapshot.source, 'LANGGRAPH_CHECKPOINTS');
    assert.equal(snapshot.workflows.length, 500);
    assert.equal(snapshot.workflows.reduce((count, workflow) => count + workflow.tasks.length, 0), 2000);
    assert.equal(listCalls, 1);
    assert.ok(elapsedMs < 2500, `checkpoint refresh took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await monitor.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
