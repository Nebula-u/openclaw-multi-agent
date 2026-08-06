import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createArtifactWatcher } from '../monitor/artifact-watcher.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from '../monitor/telemetry-repository.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('artifact watcher emits metadata only when a declared output signature changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'monitor-artifact-'));
  const output = join(directory, 'result.json');
  writeFileSync(output, '{"ok":true}\n');
  const task = { workflow_id: 'WF-1', task_id: 'TASK-1', run_id: 'RUN-1', assigned_agent: 'developer-agent',
    structured_outputs: [{ path_abs: output, format: 'json', required: true }] };
  const controlDatabase = { prepare: () => ({ all: () => [{ task_json: JSON.stringify(task) }] }) };
  const database = openTelemetryDatabase(':memory:');
  try {
    const telemetry = createTelemetryRepository(ROOT, database);
    const watcher = createArtifactWatcher({ controlDatabase, telemetry });
    const first = watcher.scan();
    assert.equal(first.length, 1);
    assert.equal(first[0].payload.size > 0, true);
    assert.equal(watcher.scan().length, 0);
    writeFileSync(output, '{"ok":false}\n');
    assert.equal(watcher.scan().length, 1);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
