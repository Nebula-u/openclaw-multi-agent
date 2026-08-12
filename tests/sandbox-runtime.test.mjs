import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertSandboxAttestation,
  assertTestSandboxPolicy,
  createSandboxAttestation,
  createSandboxMountPlan,
  loadTestSandboxPolicy,
  sandboxPolicyDigest,
  TEST_SANDBOX_ISOLATION_MODE,
} from '../scripts/orchestrator/sandbox-runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-runtime-'));
  const runtime = join(root, 'runtime');
  const worktree = join(runtime, 'worktrees', 'WF-test', 'TASK-test', 'RUN-test', 'repo');
  const artifact = join(runtime, 'artifacts', 'WF-test', 'TASK-test', 'RUN-test');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(artifact, 'input'), { recursive: true });
  mkdirSync(join(artifact, '.agent-raw'), { recursive: true });
  mkdirSync(join(artifact, 'raw-logs'), { recursive: true });
  writeFileSync(join(artifact, 'input', 'context.md'), 'test\n');
  return { root, runtime, worktree, artifact, task: { assigned_agent: 'test-agent', worktree_path_abs: worktree, artifact_root_abs: artifact } };
}

test('loads and validates the fail-closed Docker test sandbox policy', () => {
  const { policy } = loadTestSandboxPolicy(ROOT);
  assertTestSandboxPolicy(policy);
  assert.equal(policy.isolation_mode, TEST_SANDBOX_ISOLATION_MODE);
  assert.equal(policy.docker.network, 'none');
  assert.equal(policy.docker.read_only_root, true);
  assert.equal(sandboxPolicyDigest(policy).length, 64);
});

test('creates an exact per-run mount plan under runtime roots', () => {
  const value = setup();
  try {
    const { policy } = loadTestSandboxPolicy(ROOT);
    const plan = createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime });
    assert.equal(plan.isolation_mode, 'SANDBOXED_DOCKER');
    assert.deepEqual(plan.container_paths, {
      worktree: '/worktree', input: '/input', agent_raw: '/agent-raw', raw_logs: '/raw-logs',
    });
    assert.equal(plan.mounts.length, 4);
    assert.equal(plan.mounts.find((mount) => mount.name === 'input').mode, 'ro');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('creates and verifies a Docker sandbox attestation', () => {
  const value = setup();
  try {
    const { policy } = loadTestSandboxPolicy(ROOT);
    const mountPlan = createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime });
    const attestation = createSandboxAttestation({
      policy, mountPlan, runtimeId: 'agent:test-agent:orchestrator:RUN-test', containerId: 'container-test', imageDigest: 'sha256:test',
    });
    assert.equal(assertSandboxAttestation(attestation, mountPlan), true);
    assert.equal(attestation.host_execution, false);
    assert.throws(() => assertSandboxAttestation({ ...attestation, network: 'bridge' }, mountPlan), (error) => error.code === 'SANDBOX_ATTESTATION_WEAK');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('rejects a worktree outside the runtime worktrees root', () => {
  const value = setup();
  try {
    const { policy } = loadTestSandboxPolicy(ROOT);
    assert.throws(() => createSandboxMountPlan({
      task: { ...value.task, worktree_path_abs: join(value.root, 'outside') }, policy, runtimeRootAbs: value.runtime,
    }), (error) => error.code === 'SANDBOX_PATH_MISSING' || error.code === 'SANDBOX_PATH_ESCAPE');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
