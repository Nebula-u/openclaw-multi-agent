import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAssistantText } from '../scripts/hr/keywords.mjs';
import { createHrService, resolveHrAutoMode } from '../scripts/hr/service.mjs';

test('HR local rules immediately find configured uncertainty words', () => {
  const matches = inspectAssistantText('我觉得这个方案可能需要再确认，perhaps check the API.');
  assert.deepEqual(matches.map((item) => item.keyword).sort(), ['我觉得', '可能', 'perhaps'].sort());
  assert.match(matches[0].context, /方案/u);
});

test('HR automatic mode defaults to off', () => {
  assert.equal(resolveHrAutoMode(process.cwd(), {}), 'off');
});

test('manual review queues one dossier per Agent Session and deduplicates review keys', async () => {
  const jobs = [];
  const repository = {
    async getRun() { return { runId: 'RUN-1' }; },
    async listHrJobs() { return jobs.map((value, index) => ({ jobId: `HRJ-${index}`, ...value })); },
    async queueHrJob(value) { jobs.push(value); return { jobId: `HRJ-${jobs.length}`, ...value }; },
  };
  const snapshots = {
    async list() { return [{ snapshotId: 'SNP-1', runId: 'RUN-1', taskId: 'TASK-1', agentId: 'developer-agent', sessionId: 'worker-session', inputCommit: '1'.repeat(40), outputCommit: '2'.repeat(40), changeSummary: {} }]; },
    async diff() { return { patch: 'diff', snapshot: null }; },
  };
  const dossierBuilder = () => ({ schema_version: 1, messages: [{ kind: 'FINAL_OUTPUT', text: 'done' }], git: {} });
  const service = createHrService({ repository, snapshots, dossierBuilder, projectRoot: process.cwd(), enabled: true, autoMode: 'off' });
  assert.equal((await service.queueReview({ workflowId: 'WF-1', triggerMode: 'MANUAL' })).length, 1);
  assert.equal((await service.queueReview({ workflowId: 'WF-1', triggerMode: 'MANUAL' })).length, 0);
  assert.equal(jobs[0].kind, 'SESSION_REVIEW');
  assert.equal(jobs[0].reviewKey, 'MANUAL:SNP-1:worker-session');
});

test('disabled HR neither queues new work nor executes existing jobs', async () => {
  const repository = {
    async queueHrJob() { throw new Error('HR queue must not be called while disabled'); },
    async listHrJobs() { throw new Error('HR runner must not read jobs while disabled'); },
  };
  const service = createHrService({ repository, projectRoot: process.cwd(), enabled: false });
  assert.equal(service.enabled, false);
  assert.equal(await service.queueTaskDailyReport({ run: { runId: 'RUN-1' }, task: { taskId: 'TASK-1', agentId: 'developer-agent', payload: {} }, outcome: 'SUCCEEDED' }), null);
  assert.deepEqual(await service.queueReview({ taskId: 'TASK-1' }), []);
  assert.deepEqual(await service.runPending(), []);
});
