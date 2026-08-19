import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createForcedDispatcher } from '../scripts/stategraph/dispatcher.mjs';
import { loadStateGraphPolicy } from '../scripts/stategraph/policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');

test('dispatcher passes policy lease and heartbeat values to the Agent runner', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'control-kernel-heartbeat-'));
  try {
    const worktree = join(temp, 'worktree');
    const artifactRoot = join(ROOT, 'runtime', 'artifacts', 'WF-heartbeat-test', 'TASK-heartbeat-test');
    mkdirSync(worktree, { recursive: true });
    let launchOptions;
    const dispatcher = createForcedDispatcher({
      projectRoot: ROOT,
      policy: loadStateGraphPolicy(ROOT),
      launch(options) { launchOptions = options; return { launcher_pid: 42 }; },
    });
    const task = {
      workflow_id: 'WF-heartbeat-test', task_id: 'TASK-heartbeat-test', run_id: 'RUN-heartbeat-test-A1',
      step_id: 'manager-analysis', kind: 'MANAGER_ANALYSIS', agent_id: 'manager-agent', attempt: 1,
      max_attempts: 3, json_regenerations: 0, status: 'READY', session_id: null, current_cycle: null,
      required_gate_checks: [], worktree_path_abs: worktree, target_project_root_abs: ROOT,
      input_commit: 'a'.repeat(40), route_hash: null, artifact_root_abs: artifactRoot,
      dispatches: [], attempt_history: [], prompt: 'heartbeat wiring',
    };
    const started = await dispatcher.start(task);
    assert.equal(started.status, 'DISPATCHED');
    assert.equal(launchOptions.leaseSeconds, 120);
    assert.equal(launchOptions.heartbeatIntervalSeconds, 30);
    const launcher = JSON.parse(readFileSync(started.dispatches[0].launcher_path_abs, 'utf8'));
    assert.equal(launcher.lease_seconds, 120);
    assert.equal(launcher.heartbeat_interval_seconds, 30);
  } finally {
    rmSync(join(ROOT, 'runtime', 'artifacts', 'WF-heartbeat-test'), { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
