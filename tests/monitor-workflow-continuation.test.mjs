import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';
import { createWorkflowContinuation } from '../scripts/orchestrator/workflow-continuation.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('workflow continuation advances deterministic phases and wakes manager only when a task package is needed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-continuation-'));
  const databasePath = join(directory, 'control.db');
  const database = openControlDatabase(databasePath);
  const workflowId = 'WF-continuation-test';
  try {
    const controls = createControlRepository(ROOT, database);
    controls.apply({ schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: workflowId,
      expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'local-orchestrator',
      occurred_at: '2026-08-11T02:00:00.000Z', reason: 'continuation test',
      payload: { contract_set_id: 'continuation-test', agent_bundle_id: 'a'.repeat(64) } });
    createTaskRepository(ROOT, database);
    const supervision = createSupervisionRepository(ROOT, database);
    const continuation = createWorkflowContinuation({ projectRoot: ROOT, databasePath, controlDatabase: database,
      supervision, enabled: true, now: () => new Date('2026-08-11T02:01:00.000Z') });

    await continuation.scan();
    const state = controls.get(workflowId);
    assert.equal(state.phase, 'REQUIREMENTS');
    assert.equal(state.revision, 2);
    assert.equal(supervision.list().length, 1);
    assert.equal(supervision.list()[0].request_type, 'SEND_MESSAGE');
    assert.equal(supervision.wakeOutbox().length, 1);

    await continuation.scan();
    assert.equal(supervision.list().length, 1, 'the same durable stop must not create repeated manager wakes');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
