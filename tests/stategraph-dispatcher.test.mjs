import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createForcedDispatcher } from '../scripts/stategraph/dispatcher.mjs';
import { loadStateGraphPolicy } from '../scripts/stategraph/policy.mjs';
import { rawOutputPath } from '../scripts/stategraph/output-ingestion.mjs';
import { releaseEphemeralSchema, schemaBindingPath } from '../scripts/stategraph/ephemeral-schema.mjs';
import { assertExecutor, createOpenClawExecutor } from '../scripts/stategraph/agent-executor/index.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('OpenClaw executor preserves the launcher contract while exposing a replaceable boundary', async () => {
  const received = [];
  const executor = createOpenClawExecutor({ launch: async (input) => {
    received.push(input);
    return { launcher_pid: 987 };
  } });
  assert.equal(assertExecutor(executor), executor);
  assert.deepEqual(await executor.start({ task: { task_id: 'TASK-executor' } }), { launcher_pid: 987 });
  assert.equal(received[0].task.task_id, 'TASK-executor');
  assert.throws(() => assertExecutor({}), { code: 'AGENT_EXECUTOR_INVALID' });
});

test('invalid JSON is regenerated in the same session at most twice before task failure', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-json-retry-'));
  try {
    const worktree = join(temp, 'worktree');
    mkdirSync(worktree, { recursive: true });
    const task = {
      workflow_id: 'WF-json-retry', task_id: 'TASK-json-retry-plan', run_id: 'RUN-json-retry-plan-A1', step_id: 'manager-analysis',
      kind: 'MANAGER_ANALYSIS', agent_id: 'manager-agent', attempt: 1, max_attempts: 3, manual_retry_batch: 0,
      json_regenerations: 0, max_json_regenerations: 2, status: 'READY', session_id: '00000000-0000-4000-8000-000000000001',
      current_cycle: null, required_gate_checks: [], worktree_path_abs: worktree,
      target_project_root_abs: worktree, input_commit: 'a'.repeat(40), route_hash: null,
      artifact_root_abs: join(ROOT, 'runtime', 'artifacts', 'WF-json-retry', 'TASK-json-retry-plan'), dispatches: [], attempt_history: [], prompt: 'test',
    };
    const sessions = [];
    const dispatcher = createForcedDispatcher({ projectRoot: ROOT, policy: loadStateGraphPolicy(ROOT), launch({ task: launchedTask, paths, cycle }) {
      sessions.push(launchedTask.session_id);
      mkdirSync(join(launchedTask.artifact_root_abs, '.agent-raw'), { recursive: true });
      writeFileSync(rawOutputPath(launchedTask), '{ invalid json', 'utf8');
      writeFileSync(paths.result_path_abs, JSON.stringify({ state: 'SUCCEEDED', cycle }), 'utf8');
      return { launcher_pid: 123 };
    } });
    let current = await dispatcher.start(task);
    let result = dispatcher.reconcile(current);
    assert.equal(result.kind, 'JSON_REPAIR');
    current = await dispatcher.start(result.task);
    result = dispatcher.reconcile(current);
    assert.equal(result.kind, 'JSON_REPAIR');
    current = await dispatcher.start(result.task);
    result = dispatcher.reconcile(current);
    assert.equal(result.kind, 'ERROR');
    assert.equal(result.code, 'AGENT_OUTPUT_JSON_INVALID');
    assert.deepEqual(sessions, [task.session_id, task.session_id, task.session_id]);
  } finally {
    releaseEphemeralSchema(schemaBindingPath(ROOT, '00000000-0000-4000-8000-000000000001'));
    rmSync(join(ROOT, 'runtime', 'artifacts', 'WF-json-retry'), { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a failed Agent launcher releases its temporary JSON schema binding', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-launch-failure-'));
  const workflowId = 'WF-launch-failure';
  const sessionId = '00000000-0000-4000-8000-000000000099';
  try {
    const worktree = join(temp, 'worktree');
    mkdirSync(worktree, { recursive: true });
    const task = {
      workflow_id: workflowId, task_id: 'TASK-launch-failure-plan', run_id: 'RUN-launch-failure-plan-A1', step_id: 'manager-analysis',
      kind: 'MANAGER_ANALYSIS', agent_id: 'manager-agent', attempt: 1, max_attempts: 3, manual_retry_batch: 0,
      json_regenerations: 0, max_json_regenerations: 2, status: 'READY', session_id: sessionId,
      current_cycle: null, required_gate_checks: [], worktree_path_abs: worktree,
      target_project_root_abs: worktree, input_commit: 'a'.repeat(40), route_hash: null,
      artifact_root_abs: join(ROOT, 'runtime', 'artifacts', workflowId, 'TASK-launch-failure-plan'), dispatches: [], attempt_history: [], prompt: 'test',
    };
    const dispatcher = createForcedDispatcher({ projectRoot: ROOT, policy: loadStateGraphPolicy(ROOT), launch() { throw Object.assign(new Error('launcher failed'), { code: 'TEST_LAUNCH_FAILED' }); } });
    await assert.rejects(dispatcher.start(task), { code: 'TEST_LAUNCH_FAILED' });
    assert.equal(existsSync(schemaBindingPath(ROOT, sessionId)), false);
  } finally {
    rmSync(join(ROOT, 'runtime', 'artifacts', workflowId), { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
