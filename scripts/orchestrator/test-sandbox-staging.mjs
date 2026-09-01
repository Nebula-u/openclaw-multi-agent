import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import * as nodePath from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { inputRootForAttempt, rawOutputPath } from './context-manifest.mjs';
import { atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { openClawSpawnSpec } from './process-utils.mjs';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const TEST_PATH_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixture', 'fixtures', 'testdata', 'test-data']);
const TEST_CONFIG_NAMES = new Set(['pytest.ini', 'tox.ini', '.coveragerc', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
  'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts', 'playwright.config.js', 'playwright.config.ts']);

export class TestSandboxStagingError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TestSandboxStagingError'; this.code = code; this.details = details; }
}

function fail(code, message, details = {}) { throw new TestSandboxStagingError(code, message, details); }
function inside(root, path) {
  const value = nodePath.relative(nodePath.resolve(root), nodePath.resolve(path));
  return value === '' || (!value.startsWith(`..${nodePath.sep}`) && value !== '..' && !nodePath.isAbsolute(value));
}
function regular(path, code) {
  if (!existsSync(path)) fail(code, `required staging file is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail(code, `staging file must be a single-link regular non-symlink file: ${path}`);
}
function safeTree(path, code) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(code, `staging source may not contain symbolic links: ${path}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) safeTree(nodePath.join(path, entry.name), code);
}
function chmodReadOnly(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) chmodReadOnly(nodePath.join(path, entry.name));
    try { chmodSync(path, 0o555); } catch { /* hashes remain authoritative where POSIX modes are unavailable */ }
  } else {
    try { chmodSync(path, 0o444); } catch { /* hashes remain authoritative where POSIX modes are unavailable */ }
  }
}
function chmodHostWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) chmodHostWritable(nodePath.join(path, entry.name));
    try { chmodSync(path, 0o755); } catch { /* best effort for cleanup on Windows */ }
  } else {
    try { chmodSync(path, 0o644); } catch { /* parent directory removal remains available */ }
  }
}
function chmodContainerWritable(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) chmodContainerWritable(nodePath.join(path, entry.name));
    try { chmodSync(path, 0o777); } catch { /* Windows bind sharing does not use POSIX mode bits */ }
  } else {
    try { chmodSync(path, 0o666); } catch { /* Windows bind sharing does not use POSIX mode bits */ }
  }
}
function ensureContainerWorkspaceTraversal(path) {
  const mode = statSync(path).mode & 0o777;
  const requiredMode = mode | 0o005;
  if (requiredMode !== mode) chmodSync(path, requiredMode);
}
function defaultGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) fail('TEST_SANDBOX_GIT_FAILED', `git ${args.join(' ')} failed`, { cwd, stderr: String(result.stderr ?? '').trim() });
  const stdout = String(result.stdout ?? '');
  return args.includes('-z') ? stdout : stdout.trim();
}

function defaultInspectSandbox() {
  const command = openClawSpawnSpec(['config', 'get', 'agents.list', '--json']);
  const result = spawnSync(command.file, command.args, { ...command.options, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) fail('TEST_SANDBOX_CONFIG_UNVERIFIED', 'effective OpenClaw test-agent sandbox configuration could not be read', {
    status: result.status ?? null, stderr: String(result.stderr ?? '').trim(),
  });
  let agents;
  try { agents = JSON.parse(String(result.stdout ?? '')); } catch { fail('TEST_SANDBOX_CONFIG_UNVERIFIED', 'effective OpenClaw agents.list was not valid JSON'); }
  const matches = Array.isArray(agents) ? agents.filter((agent) => agent?.id === 'test-agent') : [];
  if (matches.length !== 1) fail('TEST_SANDBOX_CONFIG_UNVERIFIED', 'effective OpenClaw configuration must contain exactly one test-agent');
  return { agent_id: 'test-agent', ...(matches[0].sandbox ?? {}) };
}

function verifiedSandboxProfile(inspectSandbox) {
  const source = inspectSandbox();
  const profile = source?.sandbox ? { agent_id: source.id ?? source.agent_id, ...source.sandbox } : source;
  const docker = profile?.docker ?? {};
  const valid = profile?.agent_id === 'test-agent' && profile.mode === 'all' && profile.backend === 'docker' && profile.scope === 'session'
    && profile.workspaceAccess === 'rw' && docker.image === 'openclaw-test-node:22-slim'
    && docker.workdir === '/workspace/.task-sandbox/repo' && docker.network === 'none' && docker.readOnlyRoot === true
    && JSON.stringify(docker.capDrop) === '["ALL"]' && docker.pidsLimit === 256 && docker.memory === '2g' && docker.cpus === 2
    && !Object.hasOwn(docker, 'binds');
  if (!valid) fail('TEST_SANDBOX_CONFIG_MISMATCH', 'effective OpenClaw test-agent sandbox does not match the required hardened profile');
  return {
    agent_id: 'test-agent', mode: profile.mode, backend: profile.backend, scope: profile.scope, workspace_access: profile.workspaceAccess,
    docker: { image: docker.image, workdir: docker.workdir, network: docker.network, read_only_root: docker.readOnlyRoot,
      cap_drop: docker.capDrop, pids_limit: docker.pidsLimit, memory: docker.memory, cpus: docker.cpus, external_binds_absent: true },
  };
}

export function buildTestSandboxPaths({ workspaceRoot, hostPath = nodePath } = {}) {
  if (!workspaceRoot) throw new TypeError('workspaceRoot is required');
  const workspaceRootAbs = hostPath.resolve(workspaceRoot);
  const stagingRoot = hostPath.join(workspaceRootAbs, '.task-sandbox');
  const containerRootAbs = '/workspace/.task-sandbox';
  return {
    workspaceRoot: workspaceRootAbs, stagingRoot, lockPath: hostPath.join(workspaceRootAbs, '.task-sandbox.lock'),
    recoveryLockPath: hostPath.join(workspaceRootAbs, '.task-sandbox.lock.recover'),
    executionInputRootAbs: hostPath.join(stagingRoot, 'input'), executionWorktreeAbs: hostPath.join(stagingRoot, 'repo'),
    executionOutputRootAbs: hostPath.join(stagingRoot, 'output'), executionRawLogsRootAbs: hostPath.join(stagingRoot, 'raw-logs'),
    executionRawOutputPath: hostPath.join(stagingRoot, 'output', 'result.json.raw'),
    executionContextManifestPathAbs: hostPath.join(stagingRoot, 'input', 'execution-context-manifest.json'),
    containerRootAbs, containerInputRootAbs: nodePath.posix.join(containerRootAbs, 'input'),
    containerWorktreeAbs: nodePath.posix.join(containerRootAbs, 'repo'), containerOutputRootAbs: nodePath.posix.join(containerRootAbs, 'output'),
    containerRawLogsRootAbs: nodePath.posix.join(containerRootAbs, 'raw-logs'),
    containerRawOutputPath: nodePath.posix.join(containerRootAbs, 'output', 'result.json.raw'),
    containerContextManifestPathAbs: nodePath.posix.join(containerRootAbs, 'input', 'execution-context-manifest.json'),
  };
}

function stagePriorArtifacts({ source, executionInputRootAbs, containerInputRootAbs }) {
  const values = [];
  for (const [index, item] of (source.prior_artifacts ?? []).entries()) {
    const sourcePath = typeof item === 'string' ? item : item?.path_abs;
    if (!nodePath.isAbsolute(sourcePath ?? '')) fail('TEST_SANDBOX_PRIOR_ARTIFACT_UNSAFE', 'prior artifact path must be absolute', { source_path_abs: sourcePath ?? null });
    regular(sourcePath, 'TEST_SANDBOX_PRIOR_ARTIFACT_UNSAFE');
    const actualSha256 = sha256File(sourcePath);
    if (typeof item === 'object' && item?.sha256 && item.sha256 !== actualSha256) {
      fail('TEST_SANDBOX_PRIOR_ARTIFACT_HASH_MISMATCH', 'prior artifact hash differs from its immutable source', { source_path_abs: sourcePath });
    }
    const safeName = nodePath.basename(sourcePath).replaceAll(/[^A-Za-z0-9._-]/gu, '_') || 'artifact';
    const name = `${String(index + 1).padStart(3, '0')}-${safeName}`;
    const hostTarget = nodePath.join(executionInputRootAbs, 'prior-artifacts', name);
    mkdirSync(nodePath.dirname(hostTarget), { recursive: true });
    copyFileSync(sourcePath, hostTarget);
    values.push({ path_abs: nodePath.posix.join(containerInputRootAbs, 'prior-artifacts', name), sha256: actualSha256 });
  }
  return values;
}

function executionTaskInput({ source, task, inputRoot, paths, priorArtifacts }) {
  const originalRequestPath = source.original_request_path_abs ?? nodePath.join(inputRoot, 'user-request.md');
  if (!inside(inputRoot, originalRequestPath)) fail('TEST_SANDBOX_INPUT_PATH_ESCAPE', 'task input references a path outside the staged input root', { path_abs: originalRequestPath });
  return {
    ...source,
    target_project_root_abs: paths.containerWorktreeAbs,
    worktree_path_abs: paths.containerWorktreeAbs,
    artifact_root_abs: paths.containerRootAbs,
    allowed_write_paths_abs: [paths.containerWorktreeAbs, paths.containerOutputRootAbs, paths.containerRawLogsRootAbs],
    forbidden_paths_abs: [paths.containerInputRootAbs],
    original_request_path_abs: nodePath.posix.join(paths.containerInputRootAbs, ...nodePath.relative(inputRoot, originalRequestPath).split(nodePath.sep)),
    prior_artifacts: priorArtifacts,
    result_identity: {
      worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs,
      input_commit: task.inputCommit, artifact_manifest_hash: task.contextManifestSha256 ?? null,
    },
  };
}

function buildExecutionManifest({ source, task, inputRoot, paths }) {
  const stagedInputFiles = (source.input_files ?? []).map((file) => {
    if (!inside(inputRoot, file.path_abs)) fail('TEST_SANDBOX_INPUT_PATH_ESCAPE', 'context manifest input escapes the staged input root', { path_abs: file.path_abs });
    const stagedRelativePath = nodePath.relative(inputRoot, file.path_abs);
    const parts = stagedRelativePath.split(nodePath.sep);
    return { ...file, path_abs: nodePath.posix.join(paths.containerInputRootAbs, ...parts), sha256: sha256File(nodePath.join(paths.executionInputRootAbs, stagedRelativePath)) };
  });
  return {
    ...source,
    target_project_root_abs: paths.containerWorktreeAbs, worktree_path_abs: paths.containerWorktreeAbs, artifact_root_abs: paths.containerRootAbs,
    input_files: stagedInputFiles, expected_output_paths_abs: [paths.containerRawOutputPath], execution_raw_output_path_abs: paths.containerRawOutputPath,
    host_context_manifest_sha256: task.contextManifestSha256 ?? null,
    result_identity: {
      worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs,
      input_commit: task.inputCommit, artifact_manifest_hash: task.contextManifestSha256 ?? null,
    },
  };
}

function testChangeAllowed(path) {
  const normalized = String(path).replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  return segments.some((segment) => TEST_PATH_SEGMENTS.has(segment)) || TEST_CONFIG_NAMES.has(name)
    || /(?:^test_.+|.+_(?:test|tests)|.+\.(?:test|spec))\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php)$/u.test(name)
    || name === 'conftest.py';
}

export async function acquireTestSandboxLease(workspaceRoot, { platform = process.platform } = {}) {
  if (!['linux', 'win32'].includes(platform)) {
    fail('TEST_SANDBOX_PLATFORM_UNSUPPORTED', 'the TEST staging lease requires native Linux or Windows OS locking');
  }
  const workspaceRootAbs = nodePath.resolve(workspaceRoot);
  mkdirSync(workspaceRootAbs, { recursive: true });
  const workspaceIdentity = statSync(workspaceRootAbs, { bigint: true });
  const identity = createHash('sha256').update(`${platform}:${workspaceIdentity.dev}:${workspaceIdentity.ino}`).digest('hex');
  const endpoint = platform === 'win32'
    ? `\\\\.\\pipe\\openclaw-test-sandbox-${identity}`
    : `\0openclaw-test-sandbox-${identity}`;
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') reject(new TestSandboxStagingError('TEST_SANDBOX_BUSY', 'another process owns the TEST staging workspace'));
      else reject(error);
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
  let released = false;
  return {
    endpoint,
    async release() {
      if (released) return;
      released = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function createTestSandboxStager({ workspaceRoot: workspaceRootInput, runGit = defaultGit, inspectSandbox = defaultInspectSandbox,
  clock = () => new Date(), platform = process.platform, acquireLease = acquireTestSandboxLease } = {}) {
  const paths = buildTestSandboxPaths({ workspaceRoot: workspaceRootInput });
  let active = null;
  let lease = null;

  async function acquire() { lease = await acquireLease(paths.workspaceRoot, { platform }); }
  async function release() { const owned = lease; lease = null; await owned?.release(); }
  function normalizeContainerOwnedModes(image) {
    const command = [
      'find /workspace/.task-sandbox -xdev -user 10001 -type d -exec chmod 0777 {} +',
      'find /workspace/.task-sandbox -xdev -user 10001 -type f -exec chmod 0666 {} +',
    ].join(' && ');
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--pids-limit', '32',
      '--memory', '128m', '--cpus', '0.25', '--volume', `${paths.stagingRoot}:/workspace/.task-sandbox`, image, 'bash', '-lc', command],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) fail('TEST_SANDBOX_CLEANUP_PERMISSION_FAILED', 'container-owned staging files could not be made removable by the host', {
      status: result.status ?? null, stderr: String(result.stderr ?? '').trim(),
    });
  }
  function cleanRoot(configuredImage = active?.configuredImage ?? null) {
    if (!inside(paths.workspaceRoot, paths.stagingRoot) || nodePath.resolve(paths.stagingRoot) === paths.workspaceRoot) fail('TEST_SANDBOX_PATH_UNSAFE', 'staging root escapes the dedicated test workspace');
    const removeFromHost = () => {
      chmodHostWritable(paths.stagingRoot);
      rmSync(paths.stagingRoot, { recursive: true, force: true });
    };
    try { removeFromHost(); }
    catch (error) {
      if (!['EACCES', 'EPERM'].includes(error.code) || !configuredImage) throw error;
      normalizeContainerOwnedModes(configuredImage);
      removeFromHost();
    }
  }

  async function prepare(task) {
    if (active) fail('TEST_SANDBOX_BUSY', 'this stager already owns a TEST task');
    if (platform !== 'linux') {
      fail('TEST_SANDBOX_NATIVE_LINUX_REQUIRED', 'TEST input immutability is enforceable only on a native Linux Docker Engine host');
    }
    await acquire();
    let cleanupImage = null;
    try {
      const configuredSandbox = verifiedSandboxProfile(inspectSandbox);
      cleanupImage = configuredSandbox.docker.image;
      ensureContainerWorkspaceTraversal(paths.workspaceRoot);
      cleanRoot(cleanupImage);
      const inputRoot = inputRootForAttempt(task);
      if (!existsSync(inputRoot)) fail('TEST_SANDBOX_INPUT_MISSING', `task input root is missing: ${inputRoot}`);
      safeTree(inputRoot, 'TEST_SANDBOX_INPUT_UNSAFE');
      if (!existsSync(task.worktreePathAbs)) fail('TEST_SANDBOX_WORKTREE_MISSING', `task worktree is missing: ${task.worktreePathAbs}`);
      safeTree(task.worktreePathAbs, 'TEST_SANDBOX_WORKTREE_UNSAFE');
      mkdirSync(paths.stagingRoot, { recursive: true, mode: 0o755 });
      cpSync(inputRoot, paths.executionInputRootAbs, { recursive: true, dereference: false, errorOnExist: true });
      mkdirSync(paths.executionOutputRootAbs, { recursive: true });
      mkdirSync(paths.executionRawLogsRootAbs, { recursive: true });
      runGit(paths.workspaceRoot, ['clone', '--no-local', task.worktreePathAbs, paths.executionWorktreeAbs]);
      const stagedCommit = runGit(paths.executionWorktreeAbs, ['rev-parse', 'HEAD']);
      if (stagedCommit !== task.inputCommit) fail('TEST_SANDBOX_INPUT_COMMIT_MISMATCH', 'staged repository does not match the assigned input commit', { expected: task.inputCommit, actual: stagedCommit });
      const sourceManifest = JSON.parse(readFileSync(nodePath.join(paths.executionInputRootAbs, 'context-manifest.json'), 'utf8'));
      const sourceTask = JSON.parse(readFileSync(nodePath.join(paths.executionInputRootAbs, 'task.json'), 'utf8'));
      const priorArtifacts = stagePriorArtifacts({ source: sourceTask, executionInputRootAbs: paths.executionInputRootAbs, containerInputRootAbs: paths.containerInputRootAbs });
      const executionTask = executionTaskInput({ source: sourceTask, task, inputRoot, paths, priorArtifacts });
      writeFileSync(nodePath.join(paths.executionInputRootAbs, 'task.json'), `${JSON.stringify(executionTask, null, 2)}\n`, 'utf8');
      const executionManifest = buildExecutionManifest({ source: sourceManifest, task, inputRoot, paths });
      writeFileSync(paths.executionContextManifestPathAbs, `${JSON.stringify(executionManifest, null, 2)}\n`, 'utf8');
      chmodContainerWritable(paths.executionWorktreeAbs);
      chmodContainerWritable(paths.executionOutputRootAbs);
      chmodContainerWritable(paths.executionRawLogsRootAbs);
      chmodReadOnly(paths.executionInputRootAbs);
      const receiptPathAbs = nodePath.join(task.artifactRootAbs, '.orchestrator', 'test-sandbox-attestation.receipt.json');
      atomicWriteJson(receiptPathAbs, {
        schema_version: 1, kind: 'test-sandbox-attestation', authority: 'orchestrator-host',
        workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId, attempt: task.attempt,
        created_at: clock().toISOString(),
        verification: { effective_openclaw_configuration: true, staging_workspace: true, runtime_container_inspected: false },
        configured_sandbox: configuredSandbox,
        staging: {
          execution_root_abs: paths.stagingRoot, input_commit: stagedCommit,
          input: { path_abs: paths.executionInputRootAbs, mode: statSync(paths.executionInputRootAbs).mode & 0o777, writable_by_container_uid: false },
          repo: { path_abs: paths.executionWorktreeAbs, mode: statSync(paths.executionWorktreeAbs).mode & 0o777, writable_by_container_uid: true },
          output: { path_abs: paths.executionOutputRootAbs, mode: statSync(paths.executionOutputRootAbs).mode & 0o777, writable_by_container_uid: true },
          raw_logs: { path_abs: paths.executionRawLogsRootAbs, mode: statSync(paths.executionRawLogsRootAbs).mode & 0o777, writable_by_container_uid: true },
          configured_container_uid: 10001, configured_container_gid: 10001,
        },
        limitations: ['OpenClaw does not expose a per-run container ID; the host verified effective configuration and staged bind contents but did not inspect a runtime container.'],
      });
      active = {
        ...paths,
        executionRootAbs: paths.stagingRoot,
        configuredImage: configuredSandbox.docker.image,
        attestation: {
          input_commit: stagedCommit, receipt_path_abs: receiptPathAbs, receipt_sha256: sha256File(receiptPathAbs),
        },
      };
      return active;
    } catch (error) {
      let pendingError = error;
      try { cleanRoot(cleanupImage); } catch (cleanupError) { pendingError = cleanupError; }
      finally { await release(); }
      throw pendingError;
    }
  }

  function collect(task, staging) {
    if (staging !== active) fail('TEST_SANDBOX_STAGING_UNKNOWN', 'staging result does not belong to this stager');
    const hostRawOutputPath = rawOutputPath(task);
    regular(staging.executionRawOutputPath, 'TEST_SANDBOX_OUTPUT_MISSING');
    mkdirSync(nodePath.dirname(hostRawOutputPath), { recursive: true });
    copyFileSync(staging.executionRawOutputPath, hostRawOutputPath);
    const hostRawLogsRoot = nodePath.join(task.artifactRootAbs, 'raw-logs');
    mkdirSync(hostRawLogsRoot, { recursive: true });
    safeTree(staging.executionRawLogsRootAbs, 'TEST_SANDBOX_LOG_UNSAFE');
    const rawLogs = [];
    const referencePathMap = {};
    for (const entry of readdirSync(staging.executionRawLogsRootAbs, { withFileTypes: true })) {
      const source = nodePath.join(staging.executionRawLogsRootAbs, entry.name);
      const target = nodePath.join(hostRawLogsRoot, entry.name);
      cpSync(source, target, { recursive: entry.isDirectory(), dereference: false, errorOnExist: false });
      rawLogs.push(target);
      referencePathMap[nodePath.posix.join(staging.containerRawLogsRootAbs, entry.name)] = target;
    }
    return {
      rawOutputPath: hostRawOutputPath, rawLogs, referencePathMap,
      referencePathMappings: [{ container_root_abs: staging.containerRawLogsRootAbs, host_root_abs: hostRawLogsRoot }],
    };
  }

  function integrateCommit(task, staging, outputCommit) {
    if (staging !== active) fail('TEST_SANDBOX_STAGING_UNKNOWN', 'staging commit does not belong to this stager');
    if (!FULL_SHA.test(outputCommit ?? '')) fail('TEST_SANDBOX_OUTPUT_COMMIT_INVALID', 'TEST output_commit must be a full SHA');
    const stagedHead = runGit(staging.executionWorktreeAbs, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (stagedHead !== outputCommit) fail('TEST_SANDBOX_OUTPUT_COMMIT_HEAD_MISMATCH', 'TEST output_commit does not equal staged clone HEAD', { staged_head: stagedHead, output_commit: outputCommit });
    const stagedStatus = runGit(staging.executionWorktreeAbs, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (stagedStatus) fail('TEST_SANDBOX_WORKTREE_DIRTY', 'staged TEST clone contains uncommitted changes', { status: stagedStatus });
    try { runGit(staging.executionWorktreeAbs, ['merge-base', '--is-ancestor', task.inputCommit, outputCommit]); }
    catch { fail('TEST_SANDBOX_OUTPUT_COMMIT_NOT_DESCENDANT', 'TEST output_commit is not descended from input_commit'); }
    const changedPaths = runGit(staging.executionWorktreeAbs, ['diff', '--no-renames', '--name-only', '-z', task.inputCommit, outputCommit]).split('\0').filter(Boolean).sort();
    const unauthorized = changedPaths.filter((path) => !testChangeAllowed(path));
    if (unauthorized.length) fail('TEST_SANDBOX_CHANGE_PATH_UNAUTHORIZED', 'TEST commit changes paths outside the test code/config/fixture policy', { paths: unauthorized });
    const canonicalHead = runGit(task.worktreePathAbs, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (canonicalHead !== task.inputCommit) fail('TEST_SANDBOX_CANONICAL_HEAD_MISMATCH', 'canonical assigned worktree moved before TEST commit import', { expected: task.inputCommit, actual: canonicalHead });
    const canonicalStatus = runGit(task.worktreePathAbs, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (canonicalStatus) fail('TEST_SANDBOX_CANONICAL_DIRTY', 'canonical assigned worktree is dirty before TEST commit import', { status: canonicalStatus });
    if (outputCommit !== task.inputCommit) {
      runGit(task.worktreePathAbs, ['fetch', '--no-tags', '--no-write-fetch-head', staging.executionWorktreeAbs, outputCommit]);
      if (runGit(task.worktreePathAbs, ['cat-file', '-t', outputCommit]) !== 'commit') fail('TEST_SANDBOX_OUTPUT_COMMIT_INVALID', 'imported TEST output object is not a commit');
      runGit(task.worktreePathAbs, ['checkout', '--detach', outputCommit]);
    }
    return { inputCommit: task.inputCommit, outputCommit, changedPaths };
  }

  async function cleanup(staging) {
    if (staging !== active) return;
    try { cleanRoot(); } finally { active = null; await release(); }
  }

  return { prepare, collect, integrateCommit, cleanup };
}
