const TERMINAL = new Map([['COMPLETED', 'COMPLETED'], ['ACCEPTED', 'COMPLETED'], ['SUCCEEDED', 'COMPLETED'], ['FAILED', 'FAILED'], ['LOST', 'LOST'], ['CANCELLED', 'FAILED'], ['SUPERSEDED', 'FAILED']]);

function ageSeconds(now, value) {
  const time = Date.parse(value ?? '');
  return Number.isFinite(time) ? Math.max(0, (now.valueOf() - time) / 1000) : Number.POSITIVE_INFINITY;
}

function evidence(type, source, at, details = {}) { return { type, source, at: at ?? null, ...details }; }

export function classifyTaskHealth(task, { telemetry, now = new Date(), thresholds = {} } = {}) {
  const stale = thresholds.heartbeatStaleSeconds ?? 180;
  const stalled = thresholds.possiblyStalledSeconds ?? 300;
  const starting = thresholds.startingTimeoutSeconds ?? 120;
  const dispatch = task.dispatches?.at(-1) ?? null;
  const activity = telemetry.latestActivity(task.task_id);
  const event = telemetry.latestEvent(task.task_id);
  const items = [evidence('TASK_STATUS', 'CONTROL_DB', task.updated_at, { status: task.status })];
  if (dispatch) items.push(evidence('DISPATCH_STATUS', 'CONTROL_DB', dispatch.updated_at, { status: dispatch.status, lease_deadline: dispatch.intent?.lease_deadline ?? null }));
  if (activity) items.push(evidence('EXPLICIT_ACTIVITY', 'EXPLICIT_ACTIVITY', activity.timestamp, { kind: activity.kind, status: activity.status, summary: activity.summary }));
  if (event && event.source !== 'EXPLICIT_ACTIVITY') items.push(evidence('INFERRED_ACTIVITY', event.source, event.timestamp, { event_type: event.event_type }));

  if (TERMINAL.has(task.status)) return { health: TERMINAL.get(task.status), confidence: 'HIGH', evidence: items };
  if (task.status === 'WAITING_HUMAN' || activity?.kind === 'WAITING_HUMAN') return { health: 'WAITING_HUMAN', confidence: 'HIGH', evidence: items };
  if (task.status === 'BLOCKED' || activity?.kind === 'BLOCKED') return { health: 'BLOCKED', confidence: 'HIGH', evidence: items };
  if (activity?.kind === 'WAITING_CHILD') return { health: 'WAITING_CHILD', confidence: 'HIGH', evidence: items };
  if (!dispatch) return { health: ['CREATED', 'READY'].includes(task.status) ? 'NOT_STARTED' : 'UNKNOWN', confidence: 'HIGH', evidence: items };
  if (dispatch.status === 'PREPARED') return { health: 'NOT_STARTED', confidence: 'HIGH', evidence: items };
  const lastSignal = [activity?.timestamp, event?.timestamp, dispatch.updated_at, task.updated_at]
    .filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const signalAge = ageSeconds(now, lastSignal);
  if (['SENT', 'ACKNOWLEDGED'].includes(dispatch.status) && signalAge > starting) return { health: 'STALE', confidence: 'HIGH', evidence: items };
  if (['SENT', 'ACKNOWLEDGED'].includes(dispatch.status)) return { health: 'STARTING', confidence: 'HIGH', evidence: items };
  if (signalAge <= stale) return { health: 'RUNNING', confidence: activity ? 'HIGH' : event ? 'MEDIUM' : 'LOW', evidence: items };
  if (signalAge <= stalled) return { health: 'STALE', confidence: activity ? 'HIGH' : event ? 'MEDIUM' : 'LOW', evidence: items };
  const leaseExpired = dispatch.intent?.lease_deadline ? Date.parse(dispatch.intent.lease_deadline) < now.valueOf() : false;
  items.push(evidence('SIGNAL_AGE', 'HEALTH_CLASSIFIER', lastSignal, { age_seconds: Math.round(signalAge), lease_expired: leaseExpired }));
  return { health: 'POSSIBLY_STALLED', confidence: activity ? 'HIGH' : event || dispatch ? 'MEDIUM' : 'LOW', evidence: items };
}

export function createHealthClassifier({ telemetry, thresholds = {}, publish, now = () => new Date() }) {
  return {
    scan(snapshot) {
      const results = [];
      for (const workflow of snapshot.workflows) {
        for (const task of workflow.tasks ?? []) {
          const classified = classifyTaskHealth(task, { telemetry, thresholds, now: now() });
          const value = { workflow_id: workflow.workflow_id, task_id: task.task_id, run_id: task.run_id,
            dispatch_id: task.dispatches?.at(-1)?.dispatch_id ?? null, target_agent_id: task.assigned_agent ?? task.agent_id ?? null,
            ...classified, calculated_at: now().toISOString() };
          const prior = telemetry.health(task.task_id);
          telemetry.saveHealth(value);
          if (!prior || prior.health !== value.health || prior.confidence !== value.confidence) publish?.('health', value, { source: 'HEALTH_CLASSIFIER' });
          results.push(value);
        }
      }
      return results;
    },
  };
}
