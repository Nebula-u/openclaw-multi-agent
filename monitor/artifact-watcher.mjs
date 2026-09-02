import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { redactValue } from './redactor.mjs';

function hashBuffer(value) { return createHash('sha256').update(value).digest('hex'); }
function eventId(path, signature) { return `MEVT-${createHash('sha256').update(`${path}:${signature}`).digest('hex').slice(0, 24)}`; }

export function createArtifactWatcher({ taskSource, telemetry, publish }) {
  return {
    scan() {
      const tasks = taskSource();
      const emitted = [];
      for (const task of tasks) {
        const outputs = [task.output_path_abs, task.local_gate_path_abs].filter(Boolean).map((path) => ({ path_abs: path, format: 'json', required: true }));
        for (const output of outputs) {
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
            payload: redactValue({ agent_id: task.agent_id, path, format: output.format, required: output.required, size: stat.size, sha256: digest }),
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
