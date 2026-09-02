import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { acquireTestSandboxLease, buildTestSandboxPaths, createTestSandboxStager } from '../scripts/orchestrator/test-sandbox-staging.mjs';
import { sha256File } from '../scripts/runtime-core/atomic-store.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SANDBOX_PROFILE = {
  agent_id: 'test-agent', mode: 'all', backend: 'docker', scope: 'session', workspaceAccess: 'rw',
  docker: { image: 'openclaw-test-node:22-slim', workdir: '/workspace/.task-sandbox/repo', network: 'none', readOnlyRoot: true,
    capDrop: ['ALL'], pidsLimit: 256, memory: '2g', cpus: 2 },
};

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return String(result.stdout).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'test-sandbox-staging-'));
  const source = join(root, 'source');
  const workspace = join(root, 'test-agent-workspace');
  const artifactRootAbs = join(root, 'artifacts', 'WF-stage', 'TASK-stage');
  const inputRoot = join(artifactRootAbs, 'input');
  mkdirSync(source, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  chmodSync(workspace, 0o755);
  writeFileSync(join(source, 'app.js'), 'export const value = 1;\n');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  git(source, ['config', 'user.name', 'Test Runner']);
  git(source, ['add', 'app.js']);
  git(source, ['commit', '-m', 'initial']);
  mkdirSync(inputRoot, { recursive: true });
  const hostRawOutput = join(artifactRootAbs, '.agent-raw', 'result.json.raw');
  const hostPublishedOutput = join(artifactRootAbs, 'output', 'result.json');
  writeFileSync(join(inputRoot, 'task.json'), `${JSON.stringify({
    target_project_root_abs: source,
    worktree_path_abs: source,
    artifact_root_abs: artifactRootAbs,
    allowed_write_paths_abs: [source, join(artifactRootAbs, '.agent-raw')],
    forbidden_paths_abs: [inputRoot, join(artifactRootAbs, 'output')],
    original_request_path_abs: join(inputRoot, 'user-request.md'),
    prior_artifacts: [],
  })}\n`);
  writeFileSync(join(inputRoot, 'context-manifest.json'), `${JSON.stringify({
    task: 'stage', target_project_root_abs: source, worktree_path_abs: source, artifact_root_abs: artifactRootAbs,
    input_files: [{ path_abs: join(inputRoot, 'task.json'), sha256: 'a'.repeat(64), role: 'task' }],
    expected_output_paths_abs: [hostRawOutput, hostPublishedOutput],
  })}\n`);
  writeFileSync(join(inputRoot, 'user-request.md'), 'Test only this repository.\n');
  return {
    root,
    workspace,
    task: {
      workflowId: 'WF-stage',
      taskId: 'TASK-stage',
      runId: 'RUN-stage',
      attempt: 1,
      inputCommit: git(source, ['rev-parse', 'HEAD']),
      worktreePathAbs: source,
      artifactRootAbs,
      contextManifestPathAbs: join(inputRoot, 'context-manifest.json'),
    },
  };
}

function createStager(workspace, options = {}) {
  return createTestSandboxStager({
    projectRoot: ROOT,
    workspaceRoot: workspace,
    inspectSandbox: () => SANDBOX_PROFILE,
    platform: 'linux',
    acquireLease: async () => ({ async release() {} }),
    ...options,
  });
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    await delay(20);
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

function spawnLeaseWorker(workspace, statusPath) {
  const source = `
    import { once } from 'node:events';
    import { writeFileSync } from 'node:fs';
    const { acquireTestSandboxLease } = await import(process.env.TEST_SANDBOX_MODULE_URL);
    try {
      const lease = await acquireTestSandboxLease(process.env.TEST_SANDBOX_WORKSPACE);
      writeFileSync(process.env.TEST_SANDBOX_STATUS, 'acquired\\n');
      process.stdin.resume();
      await once(process.stdin, 'end');
      await lease.release();
    } catch (error) {
      writeFileSync(process.env.TEST_SANDBOX_STATUS, \`\${error.code ?? 'ERROR'}\\n\`);
      process.exitCode = error.code === 'TEST_SANDBOX_BUSY' ? 0 : 1;
    }
  `;
  return spawn(process.execPath, ['--input-type=module', '--eval', source], {
    env: {
      ...process.env,
      TEST_SANDBOX_MODULE_URL: pathToFileURL(join(ROOT, 'scripts', 'orchestrator', 'test-sandbox-staging.mjs')).href,
      TEST_SANDBOX_WORKSPACE: workspace,
      TEST_SANDBOX_STATUS: statusPath,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

test('container path construction stays POSIX when host paths are Windows paths', () => {
  const paths = buildTestSandboxPaths({ workspaceRoot: 'C:\\OpenClaw\\agents\\test-agent\\workspace', hostPath: win32 });
  assert.equal(paths.stagingRoot, 'C:\\OpenClaw\\agents\\test-agent\\workspace\\.task-sandbox');
  assert.equal(paths.containerWorktreeAbs, '/workspace/.task-sandbox/repo');
  assert.equal(paths.containerContextManifestPathAbs, '/workspace/.task-sandbox/input/execution-context-manifest.json');
  assert.equal(paths.containerRawOutputPath, '/workspace/.task-sandbox/output/result.json.raw');
  assert.equal(paths.containerWorktreeAbs.includes('\\'), false);
});

test('native Windows TEST staging fails closed because immutable input cannot be enforced', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createTestSandboxStager({
    workspaceRoot: value.workspace, inspectSandbox: () => SANDBOX_PROFILE, platform: 'win32',
  });

  await assert.rejects(stager.prepare(value.task), (error) => error.code === 'TEST_SANDBOX_NATIVE_LINUX_REQUIRED');
  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
});

test('OS-backed TEST lease recovers from process death and admits only one concurrent process', { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'test-sandbox-lease-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(workspace, '.task-sandbox.lock'), 'malformed legacy lock\n');
  writeFileSync(join(workspace, '.task-sandbox.lock.recover'), 'malformed legacy recovery lock\n');

  const firstStatus = join(root, 'first.status');
  const first = spawnLeaseWorker(workspace, firstStatus);
  assert.equal(await waitForFile(firstStatus), 'acquired');
  const firstExit = once(first, 'exit');
  first.kill('SIGKILL');
  await firstExit;

  const contenderStatuses = [join(root, 'contender-a.status'), join(root, 'contender-b.status')];
  const contenders = contenderStatuses.map((status) => spawnLeaseWorker(workspace, status));
  const statuses = await Promise.all(contenderStatuses.map(waitForFile));
  assert.deepEqual(statuses.toSorted(), ['TEST_SANDBOX_BUSY', 'acquired']);
  const winner = contenders[statuses.indexOf('acquired')];
  const loser = contenders[statuses.indexOf('TEST_SANDBOX_BUSY')];
  winner.stdin.end();
  await Promise.all([waitForExit(winner), waitForExit(loser)]);

  const lease = await acquireTestSandboxLease(workspace);
  const client = createConnection(lease.endpoint);
  await once(client, 'connect');
  await Promise.race([
    lease.release(),
    delay(500).then(() => assert.fail('a local client connection prevented TEST lease release')),
  ]);
  client.destroy();
});

test('OS-backed TEST lease serializes physical workspace aliases', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'test-sandbox-lease-alias-'));
  const workspace = join(root, 'workspace');
  const alias = join(root, 'workspace-alias');
  mkdirSync(workspace, { recursive: true });
  try { symlinkSync(workspace, alias, 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('creating directory symlinks requires Windows Developer Mode or elevated permission'); return; }
    throw error;
  }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lease = await acquireTestSandboxLease(workspace);
  let unexpectedAliasLease = null;

  try {
    await assert.rejects(acquireTestSandboxLease(alias).then((value) => {
      unexpectedAliasLease = value;
      return value;
    }), (error) => error.code === 'TEST_SANDBOX_BUSY');
  } finally {
    await unexpectedAliasLease?.release();
    await lease.release();
  }
});

test('staging exposes only the assigned input and repository clone', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);

  const staged = await stager.prepare(value.task);

  assert.equal(staged.executionRootAbs, join(value.workspace, '.task-sandbox'));
  assert.equal(staged.executionWorktreeAbs, join(value.workspace, '.task-sandbox', 'repo'));
  assert.equal(staged.executionInputRootAbs, join(value.workspace, '.task-sandbox', 'input'));
  assert.equal(readFileSync(join(staged.executionInputRootAbs, 'user-request.md'), 'utf8'), 'Test only this repository.\n');
  assert.equal(readFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n');
  const executionManifest = JSON.parse(readFileSync(staged.executionContextManifestPathAbs, 'utf8'));
  assert.equal(staged.containerWorktreeAbs, '/workspace/.task-sandbox/repo');
  assert.equal(executionManifest.worktree_path_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.execution_raw_output_path_abs, staged.containerRawOutputPath);
  assert.equal(executionManifest.target_project_root_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.artifact_root_abs, staged.containerRootAbs);
  assert.deepEqual(executionManifest.input_files.map((file) => file.path_abs), [`${staged.containerInputRootAbs}/task.json`]);
  assert.deepEqual(executionManifest.input_files.map((file) => file.sha256), [sha256File(join(staged.executionInputRootAbs, 'task.json'))]);
  assert.deepEqual(executionManifest.expected_output_paths_abs, [staged.containerRawOutputPath]);
  assert.deepEqual(executionManifest.result_identity, {
    worktree_path_abs: value.task.worktreePathAbs,
    artifact_root_abs: value.task.artifactRootAbs,
    input_commit: value.task.inputCommit,
    artifact_manifest_hash: null,
  });
  const stagedTask = JSON.parse(readFileSync(join(staged.executionInputRootAbs, 'task.json'), 'utf8'));
  assert.equal(stagedTask.worktree_path_abs, staged.containerWorktreeAbs);
  assert.equal(stagedTask.artifact_root_abs, staged.containerRootAbs);
  assert.deepEqual(stagedTask.allowed_write_paths_abs, [staged.containerWorktreeAbs, staged.containerOutputRootAbs, staged.containerRawLogsRootAbs]);
  assert.deepEqual(stagedTask.forbidden_paths_abs, [staged.containerInputRootAbs]);
  assert.deepEqual(stagedTask.result_identity, executionManifest.result_identity);
  const { result_identity: ignoredResultIdentity, ...executionView } = executionManifest;
  const { result_identity: ignoredTaskIdentity, ...executionTaskView } = stagedTask;
  assert.equal(JSON.stringify(executionView).includes(value.task.worktreePathAbs), false, 'execution manifest must not retain the host worktree outside result identity');
  assert.equal(JSON.stringify(executionView).includes(value.task.artifactRootAbs), false, 'execution manifest must not retain the host artifact root outside result identity');
  assert.equal(JSON.stringify(executionTaskView).includes(value.task.worktreePathAbs), false, 'staged task input must not retain the host worktree outside result identity');
  assert.equal(JSON.stringify(executionTaskView).includes(value.task.artifactRootAbs), false, 'staged task input must not retain the host artifact root outside result identity');
  assert.equal(existsSync(join(value.workspace, '.task-sandbox', 'sibling-task')), false);
  assert.equal(staged.attestation.input_commit, value.task.inputCommit);
  assert.equal(existsSync(staged.attestation.receipt_path_abs), true);
  assert.equal(staged.attestation.receipt_sha256, sha256File(staged.attestation.receipt_path_abs));
  const receipt = JSON.parse(readFileSync(staged.attestation.receipt_path_abs, 'utf8'));
  assert.equal(receipt.authority, 'orchestrator-host');
  assert.equal(receipt.verification.effective_openclaw_configuration, true);
  assert.equal(receipt.verification.staging_workspace, true);
  assert.equal(receipt.verification.runtime_container_inspected, false);
  assert.match(receipt.limitations[0], /per-run container ID/u);

  await stager.cleanup(staged);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
});

test('staging rejects a second TEST task until the active staging is cleaned', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);
  const first = await stager.prepare(value.task);

  await assert.rejects(stager.prepare({ ...value.task, taskId: 'TASK-other' }), (error) => error.code === 'TEST_SANDBOX_BUSY');

  await stager.cleanup(first);
  const second = await stager.prepare({ ...value.task, taskId: 'TASK-other' });
  await stager.cleanup(second);
});

test('failed preparation removes staging and releases the OS lease before propagating the error', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);

  await assert.rejects(stager.prepare({ ...value.task, worktreePathAbs: join(value.root, 'missing-worktree') }), (error) => error.code === 'TEST_SANDBOX_WORKTREE_MISSING');

  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
  const lease = await acquireTestSandboxLease(value.workspace);
  await lease.release();
});

test('failed preparation identifies the failing staging phase and original filesystem error', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const original = Object.assign(new Error('permission denied while cloning'), {
    code: 'EACCES', syscall: 'open', path: value.task.worktreePathAbs,
  });
  const stager = createStager(value.workspace, { runGit: () => { throw original; } });

  await assert.rejects(stager.prepare(value.task), (error) => {
    assert.equal(error.code, 'EACCES');
    assert.equal(error.details.preparation_phase, 'CLONE_WORKTREE');
    assert.equal(error.details.syscall, 'open');
    assert.equal(error.details.path, value.task.worktreePathAbs);
    assert.equal(error.cause, original);
    return true;
  });
});

test('collection copies only staged result and raw logs to the canonical artifact root', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);
  const staged = await stager.prepare(value.task);
  mkdirSync(staged.executionRawLogsRootAbs, { recursive: true });
  writeFileSync(staged.executionRawOutputPath, '{"result_status":"BLOCKED"}\n');
  writeFileSync(join(staged.executionRawLogsRootAbs, 'test.stdout.log'), 'real test output\n');

  const collected = stager.collect(value.task, staged);

  assert.equal(readFileSync(join(value.task.artifactRootAbs, '.agent-raw', 'result.json.raw'), 'utf8'), '{"result_status":"BLOCKED"}\n');
  assert.equal(readFileSync(join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log'), 'utf8'), 'real test output\n');
  assert.deepEqual(collected.rawLogs, [join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log')]);
  assert.equal(collected.referencePathMap[staged.containerRawLogsRootAbs + '/test.stdout.log'], join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log'));
  await stager.cleanup(staged);
});

test('staging permissions let configured image UID 10001 write repo/output/logs while input stays read-only', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);

  assert.notEqual(statSync(staged.executionWorktreeAbs).mode & 0o002, 0);
  assert.notEqual(statSync(join(staged.executionWorktreeAbs, 'app.js')).mode & 0o002, 0);
  assert.notEqual(statSync(staged.executionOutputRootAbs).mode & 0o002, 0);
  assert.notEqual(statSync(staged.executionRawLogsRootAbs).mode & 0o002, 0);
  assert.equal(statSync(staged.executionInputRootAbs).mode & 0o222, 0);
  assert.equal(statSync(join(staged.executionInputRootAbs, 'task.json')).mode & 0o222, 0);
  await sandbox.cleanup(staged);
});

test('staging builds execution context from read-only source input and locks the staged input afterwards', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const inputRoot = join(value.task.artifactRootAbs, 'input');
  chmodSync(join(inputRoot, 'task.json'), 0o444);
  chmodSync(join(inputRoot, 'context-manifest.json'), 0o444);
  const sandbox = createStager(value.workspace);

  const staged = await sandbox.prepare(value.task);

  assert.equal(statSync(join(staged.executionInputRootAbs, 'task.json')).mode & 0o222, 0);
  assert.equal(statSync(join(staged.executionInputRootAbs, 'execution-context-manifest.json')).mode & 0o222, 0);
  assert.equal(statSync(staged.executionInputRootAbs).mode & 0o222, 0);
  assert.notEqual(statSync(staged.executionWorktreeAbs).mode & 0o222, 0);
  assert.notEqual(statSync(staged.executionOutputRootAbs).mode & 0o222, 0);
  assert.notEqual(statSync(staged.executionRawLogsRootAbs).mode & 0o222, 0);
  await sandbox.cleanup(staged);
});

test('staging preserves special workspace mode bits while adding container traversal', {
  skip: process.platform !== 'linux' && 'requires a native Linux filesystem for POSIX special mode bits',
}, async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  chmodSync(value.workspace, 0o2700);
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);

  assert.equal(statSync(value.workspace).mode & 0o7777, 0o2705);
  await sandbox.cleanup(staged);
});

test('Docker configured image can use a real staged bind without writing immutable input', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('requires a native Linux Docker Engine host to verify bind-mount immutability');
  const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false });
  const image = SANDBOX_PROFILE.docker.image;
  const inspected = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', shell: false });
  if (daemon.status !== 0 || inspected.status !== 0) return t.skip(`Docker daemon/configured image unavailable: ${image}`);
  const value = fixture();
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  t.after(async () => { await sandbox.cleanup(staged); rmSync(value.root, { recursive: true, force: true }); });

  const script = [
    'test "$(id -u):$(id -g)" = "10001:10001"',
    'printf "changed\\n" >> /workspace/.task-sandbox/repo/app.js',
    'mkdir /workspace/.task-sandbox/repo/tests',
    'printf "assert.equal(1, 1);\\n" > /workspace/.task-sandbox/repo/tests/container.test.js',
    'git -C /workspace/.task-sandbox/repo config user.email test-agent@example.invalid',
    'git -C /workspace/.task-sandbox/repo config user.name "Test Agent"',
    'git -C /workspace/.task-sandbox/repo add app.js tests/container.test.js',
    'git -C /workspace/.task-sandbox/repo commit -m "test-agent: container commit"',
    'printf "{}\\n" > /workspace/.task-sandbox/output/result.json.raw',
    'printf "log\\n" > /workspace/.task-sandbox/raw-logs/e2e.log',
    'if printf "tamper\\n" >> /workspace/.task-sandbox/input/task.json 2>/dev/null; then exit 42; fi',
  ].join(' && ');
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--pids-limit', '256',
    '--memory', '2g', '--cpus', '2', '--volume', `${value.workspace}:/workspace`, '--workdir', staged.containerWorktreeAbs, image, 'bash', '-lc', script],
  { encoding: 'utf8', shell: false, timeout: 25_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(readFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'utf8'), /changed/u);
  assert.equal(readFileSync(join(staged.executionWorktreeAbs, 'tests', 'container.test.js'), 'utf8'), 'assert.equal(1, 1);\n');
  assert.equal(readFileSync(staged.executionRawOutputPath, 'utf8'), '{}\n');
  assert.equal(readFileSync(join(staged.executionRawLogsRootAbs, 'e2e.log'), 'utf8'), 'log\n');
});

test('staging makes a restrictive host workspace traversable by the configured test container', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('requires a native Linux Docker Engine host to verify workspace traversal');
  const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false });
  const image = SANDBOX_PROFILE.docker.image;
  const inspected = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', shell: false });
  if (daemon.status !== 0 || inspected.status !== 0) return t.skip(`Docker daemon/configured image unavailable: ${image}`);
  const value = fixture();
  chmodSync(value.workspace, 0o700);
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  t.after(async () => { await sandbox.cleanup(staged); rmSync(value.root, { recursive: true, force: true }); });

  const script = [
    'test "$(id -u):$(id -g)" = "10001:10001"',
    'test ! -w /workspace',
    'test -r /workspace/.task-sandbox/input/task.json',
    'test ! -w /workspace/.task-sandbox/input/task.json',
    'test -w /workspace/.task-sandbox/repo',
    'test -w /workspace/.task-sandbox/output',
    'test -w /workspace/.task-sandbox/raw-logs',
  ].join(' && ');
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--pids-limit', '256',
    '--memory', '2g', '--cpus', '2', '--volume', `${value.workspace}:/workspace`, image, 'bash', '-lc', script],
  { encoding: 'utf8', shell: false, timeout: 25_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('cleanup handles restrictive container-owned staging and releases the OS lease', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'linux') return t.skip('requires a native Linux Docker Engine host to verify container-owned file cleanup');
  const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false });
  const image = SANDBOX_PROFILE.docker.image;
  const inspected = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', shell: false });
  if (daemon.status !== 0 || inspected.status !== 0) return t.skip(`Docker daemon/configured image unavailable: ${image}`);
  const value = fixture();
  t.after(() => {
    if (existsSync(join(value.workspace, '.task-sandbox'))) spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--volume', `${value.workspace}:/workspace`, image, 'bash', '-lc', 'chmod -R a+rwx /workspace/.task-sandbox'], { encoding: 'utf8', shell: false });
    rmSync(value.root, { recursive: true, force: true });
  });
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--volume', `${value.workspace}:/workspace`, image, 'bash', '-lc',
    'mkdir -m 0700 /workspace/.task-sandbox/repo/container-owned && printf "leftover\\n" > /workspace/.task-sandbox/repo/container-owned/file.txt'],
  { encoding: 'utf8', shell: false, timeout: 25_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await sandbox.cleanup(staged);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
  const next = createStager(value.workspace);
  const restaged = await next.prepare(value.task);
  await next.cleanup(restaged);
});

test('staging copies prior artifacts to immutable container-visible paths with host-computed hashes', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const prior = join(value.root, 'prior-artifacts', 'result.json');
  mkdirSync(join(value.root, 'prior-artifacts'), { recursive: true });
  writeFileSync(prior, '{"result_status":"COMPLETED"}\n');
  const taskPath = join(value.task.artifactRootAbs, 'input', 'task.json');
  const taskInput = JSON.parse(readFileSync(taskPath, 'utf8'));
  taskInput.prior_artifacts = [prior];
  writeFileSync(taskPath, `${JSON.stringify(taskInput)}\n`);
  const sandbox = createStager(value.workspace);

  const staged = await sandbox.prepare(value.task);

  const stagedTask = JSON.parse(readFileSync(join(staged.executionInputRootAbs, 'task.json'), 'utf8'));
  assert.deepEqual(stagedTask.prior_artifacts, [{
    path_abs: '/workspace/.task-sandbox/input/prior-artifacts/001-result.json',
    sha256: sha256File(prior),
  }]);
  const stagedPrior = join(staged.executionInputRootAbs, 'prior-artifacts', '001-result.json');
  assert.equal(readFileSync(stagedPrior, 'utf8'), '{"result_status":"COMPLETED"}\n');
  assert.equal(statSync(stagedPrior).mode & 0o222, 0);
  await sandbox.cleanup(staged);
});

test('validated TEST commit is imported into the canonical assigned worktree before staging cleanup', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  mkdirSync(join(staged.executionWorktreeAbs, 'tests'), { recursive: true });
  writeFileSync(join(staged.executionWorktreeAbs, 'tests', 'new.test.js'), 'assert.equal(1, 1);\n');
  git(staged.executionWorktreeAbs, ['config', 'user.email', 'test-agent@example.invalid']);
  git(staged.executionWorktreeAbs, ['config', 'user.name', 'Test Agent']);
  git(staged.executionWorktreeAbs, ['add', 'tests/new.test.js']);
  git(staged.executionWorktreeAbs, ['commit', '-m', 'test-agent: add regression']);
  const outputCommit = git(staged.executionWorktreeAbs, ['rev-parse', 'HEAD']);

  const imported = sandbox.integrateCommit(value.task, staged, outputCommit);

  assert.equal(imported.outputCommit, outputCommit);
  assert.deepEqual(imported.changedPaths, ['tests/new.test.js']);
  assert.equal(git(value.task.worktreePathAbs, ['rev-parse', 'HEAD']), outputCommit);
  assert.equal(git(value.task.worktreePathAbs, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  assert.equal(readFileSync(join(value.task.worktreePathAbs, 'tests', 'new.test.js'), 'utf8').replaceAll('\r\n', '\n'), 'assert.equal(1, 1);\n');
  await sandbox.cleanup(staged);
  assert.equal(git(value.task.worktreePathAbs, ['cat-file', '-t', outputCommit]), 'commit');
});

test('TEST commit import rejects production paths and leaves the canonical worktree unchanged', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  writeFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'export const value = 2;\n');
  git(staged.executionWorktreeAbs, ['config', 'user.email', 'test-agent@example.invalid']);
  git(staged.executionWorktreeAbs, ['config', 'user.name', 'Test Agent']);
  git(staged.executionWorktreeAbs, ['add', 'app.js']);
  git(staged.executionWorktreeAbs, ['commit', '-m', 'test-agent: changed production']);
  const outputCommit = git(staged.executionWorktreeAbs, ['rev-parse', 'HEAD']);

  assert.throws(() => sandbox.integrateCommit(value.task, staged, outputCommit), (error) => error.code === 'TEST_SANDBOX_CHANGE_PATH_UNAUTHORIZED');
  assert.equal(git(value.task.worktreePathAbs, ['rev-parse', 'HEAD']), value.task.inputCommit);
  await sandbox.cleanup(staged);
});

test('TEST commit import rejects a production file renamed into an allowed test path', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  mkdirSync(join(staged.executionWorktreeAbs, 'tests'), { recursive: true });
  git(staged.executionWorktreeAbs, ['mv', 'app.js', 'tests/app.test.js']);
  git(staged.executionWorktreeAbs, ['config', 'user.email', 'test-agent@example.invalid']);
  git(staged.executionWorktreeAbs, ['config', 'user.name', 'Test Agent']);
  git(staged.executionWorktreeAbs, ['commit', '-m', 'test-agent: disguise production deletion as test rename']);
  const outputCommit = git(staged.executionWorktreeAbs, ['rev-parse', 'HEAD']);

  assert.throws(() => sandbox.integrateCommit(value.task, staged, outputCommit), (error) => error.code === 'TEST_SANDBOX_CHANGE_PATH_UNAUTHORIZED');
  assert.equal(git(value.task.worktreePathAbs, ['rev-parse', 'HEAD']), value.task.inputCommit);
  assert.equal(readFileSync(join(value.task.worktreePathAbs, 'app.js'), 'utf8'), 'export const value = 1;\n');
  await sandbox.cleanup(staged);
});

test('TEST commit import preserves leading whitespace when authorizing NUL-delimited Git paths', async (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const disguisedDirectory = join(value.task.worktreePathAbs, ' tests');
  mkdirSync(disguisedDirectory);
  writeFileSync(join(disguisedDirectory, 'app.js'), 'export const disguised = 1;\n');
  git(value.task.worktreePathAbs, ['add', ' tests/app.js']);
  git(value.task.worktreePathAbs, ['commit', '-m', 'add production directory with leading whitespace']);
  value.task.inputCommit = git(value.task.worktreePathAbs, ['rev-parse', 'HEAD']);
  const sandbox = createStager(value.workspace);
  const staged = await sandbox.prepare(value.task);
  t.after(() => sandbox.cleanup(staged));
  writeFileSync(join(staged.executionWorktreeAbs, ' tests', 'app.js'), 'export const disguised = 2;\n');
  git(staged.executionWorktreeAbs, ['config', 'user.email', 'test-agent@example.invalid']);
  git(staged.executionWorktreeAbs, ['config', 'user.name', 'Test Agent']);
  git(staged.executionWorktreeAbs, ['add', ' tests/app.js']);
  git(staged.executionWorktreeAbs, ['commit', '-m', 'test-agent: modify disguised production path']);
  const outputCommit = git(staged.executionWorktreeAbs, ['rev-parse', 'HEAD']);

  assert.throws(() => sandbox.integrateCommit(value.task, staged, outputCommit), (error) => error.code === 'TEST_SANDBOX_CHANGE_PATH_UNAUTHORIZED');
  assert.equal(readFileSync(join(value.task.worktreePathAbs, ' tests', 'app.js'), 'utf8'), 'export const disguised = 1;\n');
  await sandbox.cleanup(staged);
});
