import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSessionRecord } from './session-parser.mjs';

function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

export function createSessionTailer({ controlDatabase, telemetry, sessionRoot, publish }) {
  return {
    scan() {
      const dispatches = controlDatabase.prepare(`SELECT dispatch_id, workflow_id, task_id, run_id, agent_id, session_id
        FROM dispatches WHERE session_id IS NOT NULL AND status IN ('SENT', 'ACKNOWLEDGED', 'RUNNING') ORDER BY updated_at`).all();
      const emitted = [];
      for (const dispatch of dispatches) {
        const path = resolve(join(sessionRoot, dispatch.agent_id, 'sessions', `${dispatch.session_id}.jsonl`));
        if (!existsSync(path)) continue;
        const offset = telemetry.getSessionCursor(path);
        const buffer = readFileSync(path);
        if (offset > buffer.length) telemetry.setSessionCursor(path, 0, new Date().toISOString());
        const start = offset > buffer.length ? 0 : offset;
        const remainder = buffer.subarray(start);
        const lastNewline = remainder.lastIndexOf(0x0a);
        if (lastNewline < 0) continue;
        const complete = remainder.subarray(0, lastNewline + 1);
        let relativeOffset = 0;
        for (const line of complete.toString('utf8').split(/\r?\n/u)) {
          const lineBytes = Buffer.byteLength(`${line}\n`);
          if (line.trim()) {
            for (const parsed of parseSessionRecord(line)) {
              const event = telemetry.addEvent({
                schema_version: 1, event_id: `MEVT-${hash(`${path}:${start + relativeOffset}:${parsed.event_type}`)}`, sequence: null,
                workflow_id: dispatch.workflow_id, task_id: dispatch.task_id, run_id: dispatch.run_id,
                session_id: dispatch.session_id, topic: parsed.kind.startsWith('TOOL_') ? 'agent.output' : 'agent.activity',
                event_type: parsed.event_type, producer: 'session-tailer', source: 'SESSION_TAILER', timestamp: parsed.timestamp,
                payload: { agent_id: dispatch.agent_id, dispatch_id: dispatch.dispatch_id, kind: parsed.kind, ...parsed.payload },
                meta: { redacted: true, inferred: true, confidence: parsed.confidence },
              });
              emitted.push(event);
              publish?.('activity', event, { source: 'SESSION_TAILER' });
            }
          }
          relativeOffset += lineBytes;
        }
        telemetry.setSessionCursor(path, start + complete.length, new Date().toISOString());
      }
      return emitted;
    },
  };
}

