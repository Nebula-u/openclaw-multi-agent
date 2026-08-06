import { createHash } from 'node:crypto';

function shortHash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

export function createWatchdog({ telemetry, supervision = null, shadowMode = true, enabled = true,
  cooldownSeconds = 300, publish, now = () => new Date() }) {
  return {
    scan(healthResults) {
      if (!enabled) return [];
      const actions = [];
      for (const health of healthResults) {
        if (health.health !== 'POSSIBLY_STALLED' || !['HIGH', 'MEDIUM'].includes(health.confidence)) continue;
        const window = Math.floor(now().valueOf() / (cooldownSeconds * 1000));
        const key = `${health.workflow_id}/${health.task_id}/${health.run_id ?? 'none'}/NUDGE/${window}`;
        const eventId = `MEVT-${shortHash(`watchdog:${key}`)}`;
        if (telemetry.eventById(eventId)) continue;
        const proposed = { schema_version: 1, request_id: `SUP-${shortHash(key)}`, request_type: 'NUDGE',
          idempotency_key: key, workflow_id: health.workflow_id, task_id: health.task_id, run_id: health.run_id,
          dispatch_id: health.dispatch_id ?? null, target_agent_id: health.target_agent_id ?? null, source: 'WATCHDOG',
          reason: 'Task has no reliable progress signal beyond the configured threshold',
          requested_at: now().toISOString(),
          evidence: { health: health.health, confidence: health.confidence, signals: health.evidence } };
        const event = telemetry.addEvent({
          schema_version: 1, event_id: eventId, sequence: null, workflow_id: health.workflow_id, task_id: health.task_id,
          run_id: health.run_id ?? null, session_id: null, topic: 'task.possibly_stalled',
          event_type: shadowMode ? 'watchdog.shadow_action' : 'watchdog.action_requested', producer: 'watchdog', source: 'WATCHDOG',
          timestamp: now().toISOString(), payload: { shadow_mode: shadowMode, proposed_request: proposed },
          meta: { redacted: true, inferred: true, confidence: health.confidence },
        });
        if (!shadowMode && supervision) actions.push({ event, request: supervision.request(proposed) });
        else actions.push({ event, proposed_request: proposed });
        publish?.('health', event, { source: 'WATCHDOG' });
      }
      return actions;
    },
  };
}
