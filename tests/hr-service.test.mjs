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
  const service = createHrService({ repository, projectRoot: process.cwd(), keywords: ['guess'] });
  const own = await service.recordAssistantOutput({ agentId: 'hr-agent', sessionId: 'hr-session', text: 'guess secret=should-not-be-read' });
  assert.equal(own.job, null);
  const review = await service.recordAssistantOutput({ runId: 'RUN-1', taskId: 'TASK-1', agentId: 'developer-agent', sessionId: 'worker-session', text: 'guess secret=abc' });
  assert.equal(review.matches[0].keyword, 'guess');
  assert.equal(jobs.length, 1);
  assert.doesNotMatch(jobs[0].input.text, /secret=abc/u);
});
