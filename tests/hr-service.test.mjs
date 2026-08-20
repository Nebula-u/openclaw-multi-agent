import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAssistantText } from '../scripts/hr/keywords.mjs';
import { createHrService } from '../scripts/hr/service.mjs';

test('HR local rules immediately find configured uncertainty words', () => {
  const matches = inspectAssistantText('我觉得这个方案可能需要再确认，perhaps check the API.');
  assert.deepEqual(matches.map((item) => item.keyword).sort(), ['我觉得', '可能', 'perhaps'].sort());
  assert.match(matches[0].context, /方案/u);
});

test('HR queues redacted output review and never reviews its own output', async () => {
  const jobs = [];
  const repository = { async queueHrJob(value) { jobs.push(value); return { jobId: 'HRJ-1', ...value }; } };
  const service = createHrService({ repository, projectRoot: process.cwd(), keywords: ['guess'], enabled: true });
  const own = await service.recordAssistantOutput({ agentId: 'hr-agent', sessionId: 'hr-session', text: 'guess secret=should-not-be-read' });
  assert.equal(own.job, null);
  const review = await service.recordAssistantOutput({ runId: 'RUN-1', taskId: 'TASK-1', agentId: 'developer-agent', sessionId: 'worker-session', text: 'guess secret=abc' });
  assert.equal(review.matches[0].keyword, 'guess');
  assert.equal(jobs.length, 1);
  assert.doesNotMatch(jobs[0].input.text, /secret=abc/u);
});

test('disabled HR neither queues new work nor executes existing jobs', async () => {
  const repository = {
    async queueHrJob() { throw new Error('HR queue must not be called while disabled'); },
    async listHrJobs() { throw new Error('HR runner must not read jobs while disabled'); },
  };
  const service = createHrService({ repository, projectRoot: process.cwd(), enabled: false });
  const review = await service.recordAssistantOutput({ runId: 'RUN-1', taskId: 'TASK-1', agentId: 'developer-agent', sessionId: 'worker-session', text: '可能需要确认' });
  assert.equal(service.enabled, false);
  assert.deepEqual(review, { matches: [], job: null, alert: null });
  assert.equal(await service.queueTaskDailyReport({ run: { runId: 'RUN-1' }, task: { taskId: 'TASK-1', agentId: 'developer-agent', payload: {} }, outcome: 'SUCCEEDED' }), null);
  assert.deepEqual(await service.runPending(), []);
});
