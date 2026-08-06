import { randomUUID } from 'node:crypto';
import { redactValue } from './redactor.mjs';

function assertScope(controlDatabase, activity) {
  const workflow = controlDatabase.prepare('SELECT 1 AS present FROM workflows WHERE workflow_id=?').get(activity.workflow_id);
  if (!workflow) throw Object.assign(new Error('activity workflow does not exist'), { code: 'ACTIVITY_WORKFLOW_NOT_FOUND' });
  if (activity.task_id) {
    const task = controlDatabase.prepare('SELECT workflow_id, run_id, assigned_agent FROM tasks WHERE task_id=?').get(activity.task_id);
    if (!task || task.workflow_id !== activity.workflow_id || (activity.run_id && task.run_id !== activity.run_id)
      || task.assigned_agent !== activity.agent_id) throw Object.assign(new Error('activity task scope mismatch'), { code: 'ACTIVITY_SCOPE_MISMATCH' });
  }
  if (activity.dispatch_id) {
    const dispatch = controlDatabase.prepare('SELECT workflow_id, task_id, run_id, agent_id, session_id FROM dispatches WHERE dispatch_id=?').get(activity.dispatch_id);
    if (!dispatch || dispatch.workflow_id !== activity.workflow_id || (activity.task_id && dispatch.task_id !== activity.task_id)
      || (activity.run_id && dispatch.run_id !== activity.run_id) || dispatch.agent_id !== activity.agent_id
      || (activity.session_id && dispatch.session_id && dispatch.session_id !== activity.session_id)) {
      throw Object.assign(new Error('activity dispatch scope mismatch'), { code: 'ACTIVITY_SCOPE_MISMATCH' });
    }
  }
}

export function createActivityService({ controlDatabase, telemetry, publish }) {
  return {
    emit(input) {
      const activity = redactValue(input);
      assertScope(controlDatabase, activity);
      const event = {
        schema_version: 1,
        event_id: `MEVT-${randomUUID()}`,
        sequence: null,
        workflow_id: activity.workflow_id,
        task_id: activity.task_id ?? null,
        run_id: activity.run_id ?? null,
        session_id: activity.session_id ?? null,
        topic: 'agent.activity',
        event_type: `activity.${activity.kind.toLowerCase()}`,
        producer: 'activity-api',
        source: 'EXPLICIT_ACTIVITY',
        timestamp: activity.timestamp,
        payload: activity,
        meta: { redacted: true, inferred: false, confidence: 'HIGH' },
      };
      const stored = telemetry.addActivity(activity, event);
      if (!stored.idempotent_replay) publish?.('activity', stored.event, { source: 'EXPLICIT_ACTIVITY' });
      return { ok: true, ...stored };
    },
  };
}
