import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openControlDatabase } from '../scripts/control-core/repository.mjs';
import { SqliteCheckpointSaver } from '../scripts/orchestrator/sqlite-checkpointer.mjs';

test('SQLite checkpointer persists checkpoints and pending writes in control.db', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-checkpointer-'));
  const database = openControlDatabase(join(directory, 'control.db'));
  try {
    const saver = new SqliteCheckpointSaver(database);
    const config = { configurable: { thread_id: 'WF-checkpoint-test', checkpoint_ns: 'workflow' } };
    const checkpoint = { v: 4, id: '00000000-0000-6000-8000-000000000001', ts: '2026-08-12T00:00:00.000Z',
      channel_values: { phase: 'REQUIREMENTS' }, channel_versions: { phase: 1 }, versions_seen: {} };
    const stored = await saver.put(config, checkpoint, { source: 'input', step: -1, parents: {}, marker: 'test' }, {});
    await saver.putWrites(stored, [['phase', 'ARCHITECTURE']], 'task-1');
    const tuple = await saver.getTuple(config);
    assert.equal(tuple.checkpoint.channel_values.phase, 'REQUIREMENTS');
    assert.equal(tuple.metadata.marker, 'test');
    assert.deepEqual(tuple.pendingWrites, [['task-1', 'phase', 'ARCHITECTURE']]);
    database.close();

    const reopened = openControlDatabase(join(directory, 'control.db'));
    try {
      const persisted = await new SqliteCheckpointSaver(reopened).getTuple(config);
      assert.equal(persisted.checkpoint.id, checkpoint.id);
      assert.equal(persisted.pendingWrites.length, 1);
    } finally { reopened.close(); }
  } finally {
    try { database.close(); } catch { /* already closed */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow turns create durable LangGraph checkpoints keyed by workflow id', async () => {
  const { runWorkflowTurn } = await import('../scripts/workflow-runner.mjs');
  const { createControlRepository } = await import('../scripts/control-core/repository.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'workflow-checkpoint-'));
  const databasePath = join(directory, 'control.db');
  const workflowId = 'WF-checkpoint-integration';
  const database = openControlDatabase(databasePath);
  try {
    createControlRepository(process.cwd(), database).apply({ schema_version: 1, command_id: 'CMD-checkpoint-bootstrap',
      workflow_id: workflowId, expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'test',
      occurred_at: '2026-08-12T00:00:00.000Z', reason: 'checkpoint integration test',
      payload: { contract_set_id: 'test', agent_bundle_id: 'a'.repeat(64) } });
  } finally { database.close(); }
  try {
    const result = await runWorkflowTurn({ projectRoot: process.cwd(), databasePath, workflowId,
      graphRunId: 'GR-checkpoint-integration' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const reopened = openControlDatabase(databasePath);
    try {
      const count = reopened.prepare('SELECT COUNT(*) AS count FROM langgraph_checkpoints WHERE thread_id=?').get(workflowId).count;
      assert.ok(count > 0);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
