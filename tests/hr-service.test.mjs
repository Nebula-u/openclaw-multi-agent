import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAssistantText } from '../scripts/hr/keywords.mjs';
import { createHrService, parseHrAgentOutput, resolveHrAutoMode } from '../scripts/hr/service.mjs';

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
    async getRunById() { return { runId: 'RUN-1', workflowId: 'WF-1' }; },
    async getTask() { return { taskId: 'TASK-1', kind: 'DEVELOPMENT', stepId: 'code', title: 'Implement scoped change',
      agentId: 'developer-agent', payload: { step: { rationale: 'Implement only the assigned change.' } } }; },
    async listHrJobs() { return jobs.map((value, index) => ({ jobId: `HRJ-${index}`, ...value })); },
    async queueHrJob(value) { jobs.push(value); return { jobId: `HRJ-${jobs.length}`, ...value }; },
  };
  const snapshots = {
    async list() { return [{ snapshotId: 'SNP-1', runId: 'RUN-1', taskId: 'TASK-1', agentId: 'developer-agent', sessionId: 'worker-session', inputCommit: '1'.repeat(40), outputCommit: '2'.repeat(40), changeSummary: {} }]; },
    async diff(_snapshotId, options) { assert.equal(options.binary, false); return { patch: 'diff', snapshot: null }; },
  };
  let suppliedBoundary = null;
  const dossierBuilder = ({ boundary }) => { suppliedBoundary = boundary; return { schema_version: 1, messages: [{ kind: 'FINAL_OUTPUT', text: 'done' }], git: {} }; };
  const service = createHrService({ repository, snapshots, dossierBuilder, projectRoot: process.cwd(), enabled: true, autoMode: 'off' });
  assert.equal((await service.queueReview({ workflowId: 'WF-1', triggerMode: 'MANUAL' })).length, 1);
  assert.equal((await service.queueReview({ workflowId: 'WF-1', triggerMode: 'MANUAL' })).length, 0);
  assert.equal((await service.queueReview({ workflowId: 'WF-1', triggerMode: 'AUTO_TASK' })).length, 0);
  assert.equal(jobs[0].kind, 'SESSION_REVIEW');
  assert.equal(jobs[0].reviewKey, 'SESSION:SNP-1:worker-session');
  assert.equal(suppliedBoundary.title, 'Implement scoped change');
  assert.equal(suppliedBoundary.mutation_policy, 'TARGET_REPOSITORY_ALLOWED');
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

test('HR automation modes independently gate task and daily queueing while manual review stays available', async () => {
  for (const [mode, expectedCalls] of Object.entries({ off: 1, task: 2, daily: 2, both: 3 })) {
    let calls = 0;
    const repository = { async listHrJobs() { return []; } };
    const snapshots = { async list() { calls += 1; return []; } };
    const service = createHrService({ repository, snapshots, projectRoot: process.cwd(), enabled: true, autoMode: mode });
    await service.queueReview({ taskId: 'TASK-manual', triggerMode: 'MANUAL' });
    await service.queueTaskDailyReport({ task: { taskId: 'TASK-auto' } });
    await service.queueDailyReview('2026-08-21');
    assert.equal(calls, expectedCalls, mode);
  }
});

test('HR review dates must be real UTC calendar dates in YYYY-MM-DD form', async () => {
  const repository = { async listHrJobs() { return []; } };
  const snapshots = { async list() { throw new Error('invalid dates must fail before snapshot lookup'); } };
  const service = createHrService({ repository, snapshots, projectRoot: process.cwd(), enabled: true, autoMode: 'off' });
  for (const date of ['2026-8-21', '2026-02-30', '9999-99-99', '21-08-2026']) {
    await assert.rejects(service.queueReview({ date }), (error) => error.code === 'HR_REVIEW_DATE_INVALID');
  }
});

test('HR Agent JSON envelope is reduced to validated three-category findings', () => {
  const report = parseHrAgentOutput(JSON.stringify({ status: 'ok', result: { payloads: [{ text: JSON.stringify({ findings: [{
    category: 'UNAUTHORIZED_ACTION', severity: 'HIGH', evidence_locator: 'git.patch:3', shortest_redacted_excerpt: 'edited protected file',
    explanation: 'The change exceeds the task boundary.', recommendation: 'Revert the protected-file edit.',
  }] }) }] } }));
  assert.equal(report.finding_count, 1);
  assert.equal(report.findings[0].category, 'UNAUTHORIZED_ACTION');
});

test('invalid HR categories fail only the HR job', async () => {
  const updates = [];
  const job = { jobId: 'HRJ-invalid', status: 'PENDING', input: {}, hrSessionId: null };
  const repository = {
    async listHrJobs() { return [job]; },
    async updateHrJob(_jobId, patch) { const value = { ...job, ...patch }; updates.push(value); return value; },
  };
  const runner = async () => ({ exitCode: 0, stdout: JSON.stringify({ status: 'ok', result: { payloads: [{ text: JSON.stringify({ findings: [{
    category: 'OTHER', severity: 'LOW', evidence_locator: 'final', shortest_redacted_excerpt: 'maybe', explanation: 'bad', recommendation: 'fix',
  }] }) }] } }), stderr: '' });
  const service = createHrService({ repository, projectRoot: process.cwd(), enabled: true, autoMode: 'off', runner });
  const results = await service.runPending();
  assert.equal(results[0].status, 'FAILED');
  assert.equal(results[0].lastError.code, 'HR_OUTPUT_INVALID');
  assert.equal(updates.some((value) => value.status === 'SUCCEEDED'), false);
});
