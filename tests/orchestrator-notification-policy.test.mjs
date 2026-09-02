import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldNotifyManager } from '../scripts/orchestrator/notification-policy.mjs';

test('静默自动生命周期事件，保留需要用户关注的事件', () => {
  assert.equal(shouldNotifyManager('TASK_STARTED'), false);
  assert.equal(shouldNotifyManager('TASK_RETRY_READY'), false);
  assert.equal(shouldNotifyManager('TASK_JSON_REGENERATION_REQUESTED'), false);
  assert.equal(shouldNotifyManager('HR_DAILY_REPORT_QUEUE_FAILED'), false);
  assert.equal(shouldNotifyManager('HUMAN_APPROVAL_REQUIRED'), true);
  assert.equal(shouldNotifyManager('TASK_RETRY_EXHAUSTED'), true);
  assert.equal(shouldNotifyManager('WORKFLOW_TERMINAL'), true);
});
