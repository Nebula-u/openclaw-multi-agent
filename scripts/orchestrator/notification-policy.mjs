// Events retained in the control plane but too noisy for the Manager conversation.
const SUPPRESSED_MANAGER_EVENTS = new Set([
  'TASK_STARTED',
  'TASK_RETRY_READY',
  'TASK_JSON_REGENERATION_REQUESTED',
  'TASK_FAILED',
  'HR_DAILY_REPORT_QUEUE_FAILED',
  'HUMAN_APPROVAL_RESOLVED',
  'TASK_RETRY_BATCH_APPROVED',
  'TASK_REWORK_APPROVED',
  'WORKFLOW_PAUSED',
  'WORKFLOW_RESUMED_FROM_HOLD',
]);

export function shouldNotifyManager(type) {
  return !SUPPRESSED_MANAGER_EVENTS.has(type);
}
