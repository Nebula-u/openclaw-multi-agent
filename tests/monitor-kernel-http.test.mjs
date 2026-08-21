import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const snapshot = { snapshotId: 'SNP-monitor', runId: run.runId, taskId: 'TASK-monitor', agentId: 'developer-agent', sessionId: 'session-monitor',
    inputCommit: '1'.repeat(40), outputCommit: '2'.repeat(40), snapshotKind: 'ACCEPTED', changeSummary: { modified: ['app.js'] } };
  const privateReasoning = 'private-reasoning-must-not-reach-monitor';
  const sessionRoot = join(temp, 'sessions'); const hrSessionId = 'hr-monitor';
  mkdirSync(join(sessionRoot, 'hr-agent', 'sessions'), { recursive: true });
  writeFileSync(join(sessionRoot, 'hr-agent', 'sessions', `${hrSessionId}.jsonl`), `${JSON.stringify({ type: 'message', message: {
    role: 'assistant', content: [{ type: 'text', text: privateReasoning }] }, timestamp: new Date().toISOString() })}\n`);
  const hrJob = { jobId: 'HRJ-monitor', reviewKey: 'MANUAL:SNP-monitor:session-monitor', runId: run.runId,
    taskId: snapshot.taskId, kind: 'SESSION_REVIEW', triggerMode: 'MANUAL', sourceAgentId: snapshot.agentId,
    sourceSessionId: snapshot.sessionId, input: { messages: [{ kind: 'THINKING', text: privateReasoning }] },
    result: { session_id: hrSessionId, schema_version: 1, finding_count: 1, findings: [{ category: 'UNCLEAR_BOUNDARY', severity: 'LOW',
      evidence_locator: 'final:1', shortest_redacted_excerpt: 'scope unclear', explanation: 'The scope was not stated.', recommendation: 'State the scope.' }] },
    hrSessionId, status: 'SUCCEEDED', attempts: 1, lastError: null,
    createdAt: new Date().toISOString(), startedAt: null, finishedAt: null };
  const repository = { listHrJobs: async () => [hrJob], listNotifications: async () => [], listSnapshots: async () => [snapshot] };
  const snapshots = { async diff(snapshotId) { assert.equal(snapshotId, snapshot.snapshotId); return { snapshot, patch: 'diff --git a/app.js b/app.js\n+changed\n' }; } };
  const monitor = createKernelMonitorServer({ projectRoot: ROOT, sessionRoot, monitorDatabasePath: ':memory:', host: '127.0.0.1', port: 0, allowedOrigins: ['null'], reconcileIntervalMs: 1000, sseRetention: 10 }, { kernel, repository, snapshots });
  const address = await monitor.start();
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const workflows = await fetch(`${base}/api/workflows`, { headers: { origin: 'null' } });
    assert.equal(workflows.status, 200); const workflowBody = await workflows.json();
    assert.equal(workflowBody.workflows[0].workflow_id, workflowId);
    assert.doesNotMatch(JSON.stringify(workflowBody), new RegExp(privateReasoning, 'u'));
    assert.equal('input' in workflowBody.hr_jobs[0], false);
    const alerts = await fetch(`${base}/api/hr/alerts`, { headers: { origin: 'null' } });
    assert.equal(alerts.status, 200); assert.deepEqual((await alerts.json()).alerts, []);
    const hrJobs = await fetch(`${base}/api/hr/jobs`, { headers: { origin: 'null' } });
    const hrJobsBody = await hrJobs.json(); assert.equal(hrJobs.status, 200);
    assert.doesNotMatch(JSON.stringify(hrJobsBody), new RegExp(privateReasoning, 'u'));
    assert.equal('input' in hrJobsBody.jobs[0], false);
    const hrOutputs = await fetch(`${base}/api/hr/outputs`, { headers: { origin: 'null' } });
    const hrOutputsBody = await hrOutputs.json(); assert.equal(hrOutputs.status, 200);
    assert.equal(hrOutputsBody.outputs[0].report.findings[0].category, 'UNCLEAR_BOUNDARY');
    assert.doesNotMatch(JSON.stringify(hrOutputsBody), new RegExp(privateReasoning, 'u'));
    const privateHrSession = await fetch(`${base}/api/agents/hr-agent/sessions/${hrSessionId}/messages`, { headers: { origin: 'null' } });
    assert.equal(privateHrSession.status, 403); assert.equal((await privateHrSession.json()).error, 'HR_SESSION_PRIVATE');
    const stream = await fetch(`${base}/api/workflows/stream`, { headers: { origin: 'null' } });
    const reader = stream.body.getReader(); const firstEvent = await reader.read(); await reader.cancel();
    assert.doesNotMatch(new TextDecoder().decode(firstEvent.value), new RegExp(privateReasoning, 'u'));
    const clientConfig = await fetch(`${base}/api/client-config`, { headers: { origin: 'null' } });
    assert.equal((await clientConfig.json()).source, 'SQLITE_CONTROL_KERNEL');
    const snapshotList = await fetch(`${base}/api/snapshots`, { headers: { origin: 'null' } });
    assert.equal((await snapshotList.json()).snapshots[0].agentId, 'developer-agent');
    const snapshotDiff = await fetch(`${base}/api/snapshots/SNP-monitor/diff`, { headers: { origin: 'null' } });
    assert.equal(snapshotDiff.status, 200); assert.match((await snapshotDiff.json()).patch, /\+changed/u);
    const write = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(write.status, 403); assert.equal((await write.json()).error, 'MONITOR_READ_ONLY');
    const unauthorizedRetry = await fetch(`${base}/internal/notifications/retry`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorizedRetry.status, 403); assert.equal((await unauthorizedRetry.json()).error, 'MONITOR_READ_ONLY');
    const retry = await fetch(`${base}/internal/notifications/retry`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/json', 'x-monitor-internal-token': 'monitor-test-token' }, body: JSON.stringify({ notification_ids: ['NTF-1'] }) });
    assert.equal(retry.status, 403); assert.equal((await retry.json()).error, 'MONITOR_READ_ONLY');
  } finally { await monitor.close(); rmSync(temp, { recursive: true, force: true }); }
});
