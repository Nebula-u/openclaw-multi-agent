import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertSandboxAttestation,
  assertTestSandboxPolicy,
  createSandboxAttestation,
  createSandboxMountPlan,
  loadTestSandboxPolicy,
  cleanupTestSandboxSession,
  prepareTestSandboxSession,
  sandboxPolicyDigest,
  TEST_SANDBOX_ISOLATION_MODE,
} from '../scripts/stategraph/sandbox-runtime.mjs';

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
  const inputFile = join(root, 'requirement.md');
  writeFileSync(inputFile, 'test\n');
  const manifest = join(artifact, 'context-manifest.json');
  const inputSha256 = createHash('sha256').update(readFileSync(inputFile)).digest('hex');
  writeFileSync(manifest, JSON.stringify({ input_files: [{ path_abs: inputFile, sha256: inputSha256 }] }));
  return { root, runtime, worktree, artifact, manifest, inputFile,
    task: { agent_id: 'test-agent', worktree_path_abs: worktree, artifact_root_abs: artifact, context_manifest_path_abs: manifest } };
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

test('stages task context and declared inputs into container-visible paths', () => {
  const value = setup();
  try {
    const { policy } = loadTestSandboxPolicy(ROOT);
    const plan = createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime });
    const stagedTask = JSON.parse(readFileSync(join(value.artifact, 'input', 'task.json'), 'utf8'));
    const stagedManifest = JSON.parse(readFileSync(join(value.artifact, 'input', 'context-manifest.json'), 'utf8'));
    assert.equal(stagedTask.worktree_path_abs, '/worktree');
    assert.equal(stagedTask.context_manifest_path_abs, '/input/context-manifest.json');
    assert.equal(stagedManifest.input_files[0].path_abs, '/input/files/01-requirement.md');
    assert.equal(stagedManifest.host_path_metadata.input_files[0].path_abs, value.inputFile);
    assert.equal(readFileSync(join(value.artifact, 'input', 'files', '01-requirement.md'), 'utf8'), 'test\n');
    assert.equal(plan.mounts.find((mount) => mount.name === 'input').mode, 'ro');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('prepares, verifies, and restores a sandbox session through the command boundary', async () => {
  const value = setup();
  try {
    const { policy } = loadTestSandboxPolicy(ROOT);
    const state = { binds: [], calls: [] };
    const runner = ({ executable, args }) => {
      state.calls.push({ executable, args });
      if (executable === 'openclaw' && args[0] === 'config' && args[1] === 'get') {
        return { exit_code: 0, stdout: JSON.stringify({ agents: { list: [{ id: 'test-agent', sandbox: {
          mode: 'all', backend: 'docker', scope: 'session', workspaceAccess: 'none', docker: {
            image: policy.docker.image, workdir: policy.docker.workdir, network: 'none', readOnlyRoot: true,
            capDrop: ['ALL'], pidsLimit: 256, memory: '2g', cpus: 2,
            dangerouslyAllowExternalBindSources: true, dangerouslyAllowReservedContainerTargets: false,
            binds: state.binds,
          } }, tools: { exec: { host: 'sandbox' }, elevated: { enabled: false } } }] } }), stderr: '' };
      }
      if (executable === 'openclaw' && args[0] === 'config' && args[1] === 'set') {
        const valueIndex = args.indexOf('--strict-json') - 1;
        if (valueIndex > 1) state.binds = JSON.parse(args[valueIndex]);
        return { exit_code: 0, stdout: '', stderr: '' };
      }
      if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'recreate') return { exit_code: 0, stdout: '', stderr: '' };
      if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'explain') return {
        exit_code: 0, stdout: JSON.stringify({ sandbox: { sessionIsSandboxed: true, mode: 'all', backend: 'docker', scope: 'session', workspaceAccess: 'none', workspaceMounts: [{}, {}, {}, {}] } }), stderr: '',
      };
      if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'list') return {
        exit_code: 0, stdout: JSON.stringify({ containers: [{ sessionKey: 'agent:test-agent:orchestrator:WF-test:TASK-test:RUN-test', running: true, runtimeLabel: 'container-test' }] }), stderr: '',
      };
      if (executable === 'docker' && args[0] === 'inspect') {
        const mountPlan = createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime });
        return { exit_code: 0, stdout: JSON.stringify([{ Id: 'container-test', Image: 'sha256:image-test', Config: { Image: policy.docker.image, WorkingDir: '/workspace' }, HostConfig: {
          NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], PidsLimit: 256, NanoCpus: 2_000_000_000, Memory: 2 * 1024 * 1024 * 1024,
        }, Mounts: mountPlan.mounts.map((mount) => ({ Destination: mount.container_path, Source: mount.host_path_abs, RW: mount.mode === 'rw' })) }]), stderr: '' };
      }
      throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
    };
    const prepared = await prepareTestSandboxSession({ projectRootInput: ROOT, task: value.task, sessionId: 'session-test',
      sessionKey: 'agent:test-agent:orchestrator:WF-test:TASK-test:RUN-test', runtimeRootAbs: value.runtime, commandRunner: runner });
    assert.equal(prepared.attestation.backend, 'docker');
    assert.equal(prepared.attestation.host_execution, false);
    await cleanupTestSandboxSession({ lease: prepared.lease, leasePath: prepared.leasePath, commandRunner: runner });
    assert.deepEqual(state.binds, []);
    assert.ok(state.calls.some((call) => call.executable === 'docker'));
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

