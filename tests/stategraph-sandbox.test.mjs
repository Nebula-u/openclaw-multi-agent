import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

function setup({ root: providedRoot = null, suffix = 'test' } = {}) {
  const root = providedRoot ?? mkdtempSync(join(tmpdir(), 'sandbox-runtime-'));
  const framework = join(root, 'framework');
  mkdirSync(join(framework, 'config'), { recursive: true });
  copyFileSync(join(ROOT, 'config', 'test-sandbox-policy.json'), join(framework, 'config', 'test-sandbox-policy.json'));
  const runtime = join(framework, 'runtime');
  const worktree = join(runtime, 'worktrees', `WF-${suffix}`, `TASK-${suffix}`, `RUN-${suffix}`, 'repo');
  const artifact = join(runtime, 'artifacts', `WF-${suffix}`, `TASK-${suffix}`, `RUN-${suffix}`);
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(artifact, 'input'), { recursive: true });
  mkdirSync(join(artifact, '.agent-raw'), { recursive: true });
  mkdirSync(join(artifact, 'raw-logs'), { recursive: true });
  const inputFile = join(root, `requirement-${suffix}.md`);
  writeFileSync(inputFile, 'test\n');
  const manifest = join(artifact, 'context-manifest.json');
  const inputSha256 = createHash('sha256').update(readFileSync(inputFile)).digest('hex');
  writeFileSync(manifest, JSON.stringify({ input_files: [{ path_abs: inputFile, sha256: inputSha256 }] }));
  return { root, framework, runtime, worktree, artifact, manifest, inputFile,
    task: { agent_id: 'test-agent', worktree_path_abs: worktree, artifact_root_abs: artifact, context_manifest_path_abs: manifest } };
}

function controlledRunner({ policy, plans, invalidDocker = false } = {}) {
  const state = { binds: [], calls: [], currentSession: null };
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
      if (valueIndex > 1 && !args.includes('--dry-run')) state.binds = JSON.parse(args[valueIndex]);
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'recreate') {
      state.currentSession = args[args.indexOf('--session') + 1];
      return { exit_code: 0, stdout: '', stderr: '' };
    }
    if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'explain') return {
      exit_code: 0, stdout: JSON.stringify({ sandbox: { sessionIsSandboxed: true, mode: 'all', backend: 'docker', scope: 'session', workspaceAccess: 'none', workspaceMounts: [{}, {}, {}, {}] } }), stderr: '',
    };
    if (executable === 'openclaw' && args[0] === 'sandbox' && args[1] === 'list') return {
      exit_code: 0, stdout: JSON.stringify({ containers: [{ sessionKey: state.currentSession, running: true, runtimeLabel: `container-${state.currentSession}` }] }), stderr: '',
    };
    if (executable === 'docker' && args[0] === 'inspect') {
      const mountPlan = plans.get(state.currentSession);
      assert.ok(mountPlan, `missing mount plan for ${state.currentSession}`);
      return { exit_code: 0, stdout: JSON.stringify([{ Id: `container-${state.currentSession}`, Image: 'sha256:image-test', Config: { Image: policy.docker.image, WorkingDir: '/workspace' }, HostConfig: {
        NetworkMode: invalidDocker ? 'bridge' : 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], PidsLimit: 256, NanoCpus: 2_000_000_000, Memory: 2 * 1024 * 1024 * 1024,
      }, Mounts: mountPlan.mounts.map((mount) => ({ Destination: mount.container_path, Source: mount.host_path_abs, RW: mount.mode === 'rw' })) }]), stderr: '' };
    }
    throw new Error(`unexpected command: ${executable} ${args.join(' ')}`);
  };
  return { state, runner };
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
    assert.equal(stagedManifest.input_files[0].path_abs, '/input/files/01-requirement-test.md');
    assert.equal(stagedManifest.host_path_metadata.input_files[0].path_abs, value.inputFile);
    assert.equal(readFileSync(join(value.artifact, 'input', 'files', '01-requirement-test.md'), 'utf8'), 'test\n');
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
    const prepared = await prepareTestSandboxSession({ projectRootInput: value.framework, task: value.task, sessionId: 'session-test',
      sessionKey: 'agent:test-agent:orchestrator:WF-test:TASK-test:RUN-test', runtimeRootAbs: value.runtime, commandRunner: runner });
    assert.equal(prepared.attestation.backend, 'docker');
    assert.equal(prepared.attestation.host_execution, false);
    assert.equal(prepared.lease.global_lock.path, join(value.framework, 'runtime', 'stategraph', 'test-sandbox-global.lock'));
    await cleanupTestSandboxSession({ lease: prepared.lease, leasePath: prepared.leasePath, commandRunner: runner });
    assert.deepEqual(state.binds, []);
    assert.equal(existsSync(join(value.framework, 'runtime', 'stategraph', 'test-sandbox-global.lock')), false);
    assert.ok(state.calls.some((call) => call.executable === 'docker'));
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('global sandbox lease rejects a concurrent test session without consuming or replacing the owner lock', async () => {
  const value = setup({ suffix: 'concurrent' });
  try {
    const { policy } = loadTestSandboxPolicy(value.framework);
    const sessionKey = 'agent:test-agent:stategraph:WF-concurrent:TASK-concurrent:RUN-concurrent';
    const plans = new Map([[sessionKey, createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime })]]);
    const { state, runner } = controlledRunner({ policy, plans });
    const first = await prepareTestSandboxSession({ projectRootInput: value.framework, task: value.task, sessionId: 'session-first',
      sessionKey, runtimeRootAbs: value.runtime, commandRunner: runner });
    await assert.rejects(() => prepareTestSandboxSession({ projectRootInput: value.framework, task: value.task, sessionId: 'session-second',
      sessionKey: `${sessionKey}-second`, runtimeRootAbs: value.runtime, commandRunner: runner }), (error) => error.code === 'SANDBOX_GLOBAL_BUSY');
    assert.equal(existsSync(first.lease.global_lock.path), true);
    await cleanupTestSandboxSession({ lease: first.lease, leasePath: first.leasePath, commandRunner: runner });
    assert.deepEqual(state.binds, []);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('sandbox preparation restores binds and releases the lease when runtime attestation fails', async () => {
  const value = setup({ suffix: 'rollback' });
  try {
    const { policy } = loadTestSandboxPolicy(value.framework);
    const sessionKey = 'agent:test-agent:stategraph:WF-rollback:TASK-rollback:RUN-rollback';
    const plans = new Map([[sessionKey, createSandboxMountPlan({ task: value.task, policy, runtimeRootAbs: value.runtime })]]);
    const { state, runner } = controlledRunner({ policy, plans, invalidDocker: true });
    await assert.rejects(() => prepareTestSandboxSession({ projectRootInput: value.framework, task: value.task, sessionId: 'session-rollback',
      sessionKey, runtimeRootAbs: value.runtime, commandRunner: runner }), (error) => error.code === 'SANDBOX_RUNTIME_POLICY_MISMATCH');
    assert.deepEqual(state.binds, []);
    const lockPath = join(value.framework, 'runtime', 'stategraph', 'test-sandbox-global.lock');
    assert.equal(existsSync(lockPath), false);
    const lease = JSON.parse(readFileSync(join(value.artifact, '.stategraph', 'test-sandbox-lease.json'), 'utf8'));
    assert.ok(lease.recovered_at);
    assert.equal(lease.recovery_reason, 'SANDBOX_RUNTIME_POLICY_MISMATCH');
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test('a stale sandbox lease restores the crashed session before a new test session acquires the global config', async () => {
  const firstValue = setup({ suffix: 'stale-first' });
  const secondValue = setup({ root: firstValue.root, suffix: 'stale-second' });
  try {
    const { policy } = loadTestSandboxPolicy(firstValue.framework);
    const firstKey = 'agent:test-agent:stategraph:WF-stale-first:TASK-stale-first:RUN-stale-first';
    const secondKey = 'agent:test-agent:stategraph:WF-stale-second:TASK-stale-second:RUN-stale-second';
    const plans = new Map([
      [firstKey, createSandboxMountPlan({ task: firstValue.task, policy, runtimeRootAbs: firstValue.runtime })],
      [secondKey, createSandboxMountPlan({ task: secondValue.task, policy, runtimeRootAbs: secondValue.runtime })],
    ]);
    const { state, runner } = controlledRunner({ policy, plans });
    const first = await prepareTestSandboxSession({ projectRootInput: firstValue.framework, task: firstValue.task, sessionId: 'session-stale-first',
      sessionKey: firstKey, runtimeRootAbs: firstValue.runtime, commandRunner: runner });
    const staleAt = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(first.lease.global_lock.path, staleAt, staleAt);
    const second = await prepareTestSandboxSession({ projectRootInput: secondValue.framework, task: secondValue.task, sessionId: 'session-stale-second',
      sessionKey: secondKey, runtimeRootAbs: secondValue.runtime, commandRunner: runner });
    const recovered = JSON.parse(readFileSync(first.leasePath, 'utf8'));
    assert.equal(recovered.recovery_reason, 'STALE_GLOBAL_LEASE');
    assert.deepEqual(state.binds, second.lease.desired_binds);
    await cleanupTestSandboxSession({ lease: second.lease, leasePath: second.leasePath, commandRunner: runner });
    assert.deepEqual(state.binds, []);
  } finally { rmSync(firstValue.root, { recursive: true, force: true }); }
});
