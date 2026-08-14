import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';
import { createSessionTailer } from '../monitor/session-tailer.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('session tailer exposes only user-visible assistant dialogue and waits for a complete JSONL line', () => {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-session-tailer-'));
  const sessionDirectory = join(directory, 'developer-agent', 'sessions');
  mkdirSync(sessionDirectory, { recursive: true });
  const path = join(sessionDirectory, 'session-1.jsonl');
  const assistant = { type: 'message', timestamp: '2026-08-06T12:10:00.000Z', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Implemented checkpoint' }, { type: 'tool_use', name: 'shell', id: 'tool-1' },
  ] } };
  const tool = { type: 'message', timestamp: '2026-08-06T12:10:01.000Z', message: { role: 'tool', toolName: 'shell', toolCallId: 'tool-1', isError: false, content: 'token=secret-value done' } };
  writeFileSync(path, `${JSON.stringify(assistant)}\n${JSON.stringify(tool)}\n{"type":"message"`);
  const database = openTelemetryDatabase(':memory:');
  try {
    const telemetry = createTelemetryRepository(ROOT, database);
    const taskSource = () => [{ workflow_id: 'WF-1', task_id: 'TASK-1', run_id: 'RUN-1', agent_id: 'developer-agent', session_id: 'session-1', dispatches: [{ dispatch_id: 'DSP-1' }] }];
    const tailer = createSessionTailer({ taskSource, telemetry, sessionRoot: directory });
    const first = tailer.scan();
    assert.equal(first.length, 1);
    assert.ok(first.every((event) => !JSON.stringify(event).includes('private')));
    assert.ok(first.every((event) => !JSON.stringify(event).includes('secret-value')));
    assert.equal(first[0].event_type, 'session.assistant_output');
    assert.equal(tailer.scan().length, 0);
    appendFileSync(path, '}\n');
    assert.equal(tailer.scan().length, 0);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
