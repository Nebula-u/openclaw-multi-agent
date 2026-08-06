import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { redactValue } from './redactor.mjs';

function hashBuffer(value) { return createHash('sha256').update(value).digest('hex'); }
function eventId(path, signature) { return `MEVT-${createHash('sha256').update(`${path}:${signature}`).digest('hex').slice(0, 24)}`; }

export function createArtifactWatcher({ controlDatabase, telemetry, publish }) {
  return {
    scan() {
      const tasks = controlDatabase.prepare("SELECT task_json FROM tasks WHERE status NOT IN ('CANCELLED', 'SUPERSEDED') ORDER BY updated_at").all();
      const emitted = [];
      for (const row of tasks) {
        let task;
        try { task = JSON.parse(row.task_json); } catch { continue; }
        for (const output of task.structured_outputs ?? []) {
          const path = output.path_abs;
          if (!path || !existsSync(path)) continue;
          let stat;
          try { stat = statSync(path); } catch { continue; }
          if (!stat.isFile()) continue;
          const digest = stat.size <= 10 * 1024 * 1024 ? hashBuffer(readFileSync(path)) : null;
          const signature = `${stat.size}:${stat.mtimeMs}:${digest ?? 'large-file'}`;
          if (telemetry.getArtifactCursor(path) === signature) continue;
          telemetry.setArtifactCursor(path, signature, new Date().toISOString());
          const event = telemetry.addEvent({
            schema_version: 1, event_id: eventId(path, signature), sequence: null,
            workflow_id: task.workflow_id, task_id: task.task_id, run_id: task.run_id, session_id: null,
            topic: 'agent.output', event_type: 'artifact.updated', producer: 'artifact-watcher', source: 'ARTIFACT_WATCHER',
            timestamp: new Date(stat.mtimeMs).toISOString(),
            payload: redactValue({ agent_id: task.assigned_agent, path, format: output.format, required: output.required, size: stat.size, sha256: digest }),
            meta: { redacted: true, inferred: true, confidence: 'MEDIUM' },
          });
          emitted.push(event);
          publish?.('activity', event, { source: 'ARTIFACT_WATCHER' });
        }
      }
      return emitted;
    },
  };
}
