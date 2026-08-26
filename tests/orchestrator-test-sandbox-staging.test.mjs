import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildTestSandboxPaths, createTestSandboxStager } from '../scripts/orchestrator/test-sandbox-staging.mjs';
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

function createStager(workspace) {
  return createTestSandboxStager({ projectRoot: ROOT, workspaceRoot: workspace, inspectSandbox: () => SANDBOX_PROFILE });
}

test('container path construction stays POSIX when host paths are Windows paths', () => {
  const paths = buildTestSandboxPaths({ workspaceRoot: 'C:\\OpenClaw\\agents\\test-agent\\workspace', hostPath: win32 });
  assert.equal(paths.stagingRoot, 'C:\\OpenClaw\\agents\\test-agent\\workspace\\.task-sandbox');
  assert.equal(paths.containerWorktreeAbs, '/workspace/.task-sandbox/repo');
  assert.equal(paths.containerContextManifestPathAbs, '/workspace/.task-sandbox/input/execution-context-manifest.json');
  assert.equal(paths.containerRawOutputPath, '/workspace/.task-sandbox/output/result.json.raw');
  assert.equal(paths.containerWorktreeAbs.includes('\\'), false);
});

test('staging exposes only the assigned input and repository clone', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);

  const staged = stager.prepare(value.task);

  assert.equal(staged.executionRootAbs, join(value.workspace, '.task-sandbox'));
  assert.equal(staged.executionWorktreeAbs, join(value.workspace, '.task-sandbox', 'repo'));
  assert.equal(staged.executionInputRootAbs, join(value.workspace, '.task-sandbox', 'input'));
  assert.equal(readFileSync(join(staged.executionInputRootAbs, 'user-request.md'), 'utf8'), 'Test only this repository.\n');
  assert.equal(readFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'utf8'), 'export const value = 1;\n');
  const executionManifest = JSON.parse(readFileSync(staged.executionContextManifestPathAbs, 'utf8'));
  assert.equal(staged.containerWorktreeAbs, '/workspace/.task-sandbox/repo');
  assert.equal(executionManifest.worktree_path_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.execution_raw_output_path_abs, staged.containerRawOutputPath);
  assert.equal(executionManifest.target_project_root_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.artifact_root_abs, staged.containerRootAbs);
  assert.deepEqual(executionManifest.input_files.map((file) => file.path_abs), [join(staged.containerInputRootAbs, 'task.json')]);
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

  stager.cleanup(staged);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
});

test('staging rejects a second TEST task until the active staging is cleaned', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);
  const first = stager.prepare(value.task);

  assert.throws(() => stager.prepare({ ...value.task, taskId: 'TASK-other' }), (error) => error.code === 'TEST_SANDBOX_BUSY');

  stager.cleanup(first);
  const second = stager.prepare({ ...value.task, taskId: 'TASK-other' });
  stager.cleanup(second);
});

test('failed preparation removes the staging root and lock before propagating the error', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);

  assert.throws(() => stager.prepare({ ...value.task, worktreePathAbs: join(value.root, 'missing-worktree') }), (error) => error.code === 'TEST_SANDBOX_WORKTREE_MISSING');

  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox.lock')), false);
});

test('collection copies only staged result and raw logs to the canonical artifact root', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createStager(value.workspace);
  const staged = stager.prepare(value.task);
  mkdirSync(staged.executionRawLogsRootAbs, { recursive: true });
  writeFileSync(staged.executionRawOutputPath, '{"result_status":"BLOCKED"}\n');
  writeFileSync(join(staged.executionRawLogsRootAbs, 'test.stdout.log'), 'real test output\n');

  const collected = stager.collect(value.task, staged);

  assert.equal(readFileSync(join(value.task.artifactRootAbs, '.agent-raw', 'result.json.raw'), 'utf8'), '{"result_status":"BLOCKED"}\n');
  assert.equal(readFileSync(join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log'), 'utf8'), 'real test output\n');
  assert.deepEqual(collected.rawLogs, [join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log')]);
  assert.equal(collected.referencePathMap[staged.containerRawLogsRootAbs + '/test.stdout.log'], join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log'));
  stager.cleanup(staged);
});

test('staging permissions let configured image UID 10001 write repo/output/logs while input stays read-only', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = sandbox.prepare(value.task);

  assert.notEqual(statSync(staged.executionWorktreeAbs).mode & 0o002, 0);
  assert.notEqual(statSync(join(staged.executionWorktreeAbs, 'app.js')).mode & 0o002, 0);
  assert.notEqual(statSync(staged.executionOutputRootAbs).mode & 0o002, 0);
  assert.notEqual(statSync(staged.executionRawLogsRootAbs).mode & 0o002, 0);
  assert.equal(statSync(staged.executionInputRootAbs).mode & 0o222, 0);
  assert.equal(statSync(join(staged.executionInputRootAbs, 'task.json')).mode & 0o222, 0);
  sandbox.cleanup(staged);
});

test('Docker configured image can use a real staged bind without writing immutable input', { timeout: 30_000 }, (t) => {
  const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false });
  const image = SANDBOX_PROFILE.docker.image;
  const inspected = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', shell: false });
  if (daemon.status !== 0 || inspected.status !== 0) return t.skip(`Docker daemon/configured image unavailable: ${image}`);
  const value = fixture();
  const sandbox = createStager(value.workspace);
  const staged = sandbox.prepare(value.task);
  t.after(() => { sandbox.cleanup(staged); rmSync(value.root, { recursive: true, force: true }); });

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

test('staging safely recovers a dead-owner lock and preserves a live-owner lock', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const lockPath = join(value.workspace, '.task-sandbox.lock');
  writeFileSync(lockPath, `${JSON.stringify({ schema_version: 1, pid: 2147483647, token: 'dead', created_at: '2026-08-26T00:00:00.000Z' })}\n`);
  const recovered = createStager(value.workspace);
  const staged = recovered.prepare(value.task);
  recovered.cleanup(staged);

  writeFileSync(lockPath, `${JSON.stringify({ schema_version: 1, pid: process.pid, token: 'live', created_at: new Date().toISOString() })}\n`);
  assert.throws(() => createStager(value.workspace).prepare(value.task), (error) => error.code === 'TEST_SANDBOX_BUSY');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'live');
});

test('staging copies prior artifacts to immutable container-visible paths with host-computed hashes', (t) => {
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

  const staged = sandbox.prepare(value.task);

  const stagedTask = JSON.parse(readFileSync(join(staged.executionInputRootAbs, 'task.json'), 'utf8'));
  assert.deepEqual(stagedTask.prior_artifacts, [{
    path_abs: '/workspace/.task-sandbox/input/prior-artifacts/001-result.json',
    sha256: sha256File(prior),
  }]);
  const stagedPrior = join(staged.executionInputRootAbs, 'prior-artifacts', '001-result.json');
  assert.equal(readFileSync(stagedPrior, 'utf8'), '{"result_status":"COMPLETED"}\n');
  assert.equal(statSync(stagedPrior).mode & 0o222, 0);
  sandbox.cleanup(staged);
});

test('validated TEST commit is imported into the canonical assigned worktree before staging cleanup', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = sandbox.prepare(value.task);
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
  assert.equal(readFileSync(join(value.task.worktreePathAbs, 'tests', 'new.test.js'), 'utf8'), 'assert.equal(1, 1);\n');
  sandbox.cleanup(staged);
  assert.equal(git(value.task.worktreePathAbs, ['cat-file', '-t', outputCommit]), 'commit');
});

test('TEST commit import rejects production paths and leaves the canonical worktree unchanged', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const sandbox = createStager(value.workspace);
  const staged = sandbox.prepare(value.task);
  writeFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'export const value = 2;\n');
  git(staged.executionWorktreeAbs, ['config', 'user.email', 'test-agent@example.invalid']);
  git(staged.executionWorktreeAbs, ['config', 'user.name', 'Test Agent']);
  git(staged.executionWorktreeAbs, ['add', 'app.js']);
  git(staged.executionWorktreeAbs, ['commit', '-m', 'test-agent: changed production']);
  const outputCommit = git(staged.executionWorktreeAbs, ['rev-parse', 'HEAD']);

  assert.throws(() => sandbox.integrateCommit(value.task, staged, outputCommit), (error) => error.code === 'TEST_SANDBOX_CHANGE_PATH_UNAUTHORIZED');
  assert.equal(git(value.task.worktreePathAbs, ['rev-parse', 'HEAD']), value.task.inputCommit);
  sandbox.cleanup(staged);
});
