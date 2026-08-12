import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { createManagerSessionContext } from '../scripts/orchestrator/manager-context.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-manager-context';

function fixture() {
  const database = openControlDatabase(':memory:');
  const controls = createControlRepository(ROOT, database);
  controls.apply({
    schema_version: 1,
    command_id: `CMD-${randomUUID()}`,
    workflow_id: WORKFLOW_ID,
    expected_revision: 0,
    command_type: 'BOOTSTRAP',
    actor: 'test',
    occurred_at: '2026-08-11T01:00:00.000Z',
    reason: 'manager context test',
    payload: { contract_set_id: 'manager-context-test', agent_bundle_id: 'a'.repeat(64) },
  });
  createTaskRepository(ROOT, database);
  return database;
}

test('manager context keeps the session below the configured soft budget', () => {
  const database = fixture();
  try {
    const value = createManagerSessionContext({ projectRoot: ROOT, database, workflowId: WORKFLOW_ID, estimatedTokens: 50000 });
    assert.equal(value.session_policy.action, 'CONTINUE');
    assert.equal(value.session_policy.remaining_soft_budget_tokens, 26800);
    assert.equal(value.session_policy.model_context_window_tokens, 128000);
    assert.equal(value.session_policy.max_session_tokens, 200000);
    assert.equal(value.prompt_context.view, 'manager-context');
    assert.equal(value.session_policy.visible_output.mode, 'summary_only');
  } finally { database.close(); }
});

test('manager context requires a new session at the soft budget', () => {
  const database = fixture();
  try {
    const value = createManagerSessionContext({ projectRoot: ROOT, database, workflowId: WORKFLOW_ID, estimatedTokens: 76800 });
    assert.equal(value.session_policy.action, 'START_NEW_MANAGER_SESSION');
    assert.equal(value.session_policy.remaining_soft_budget_tokens, 0);
    assert.equal(value.prompt_context.omitted.historical_events, true);
  } finally { database.close(); }
});

test('manager context does not assume budget when usage is unavailable', () => {
  const database = fixture();
  try {
    const value = createManagerSessionContext({ projectRoot: ROOT, database, workflowId: WORKFLOW_ID });
    assert.equal(value.session_policy.action, 'MEASURE_CONTEXT');
    assert.equal(value.session_policy.estimated_tokens, null);
  } finally { database.close(); }
});
