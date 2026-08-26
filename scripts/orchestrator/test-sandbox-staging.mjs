import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inputRootForAttempt, rawOutputPath } from './context-manifest.mjs';

export class TestSandboxStagingError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TestSandboxStagingError'; this.code = code; this.details = details; }
}

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function regular(path, code) {
  if (!existsSync(path)) throw new TestSandboxStagingError(code, `required staging file is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TestSandboxStagingError(code, `staging file must be a regular non-symlink file: ${path}`);
}

function safeTree(path, code) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new TestSandboxStagingError(code, `staging source may not contain symbolic links: ${path}`);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) safeTree(join(path, entry.name), code);
}

function chmodReadOnly(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) chmodReadOnly(join(path, entry.name));
    try { chmodSync(path, 0o555); } catch { /* Windows retains hash protection */ }
  } else {
    try { chmodSync(path, 0o444); } catch { /* Windows retains hash protection */ }
  }
}

function chmodWritable(path) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) chmodWritable(join(path, entry.name));
    try { chmodSync(path, 0o755); } catch { /* Windows retains platform permissions */ }
  } else {
    try { chmodSync(path, 0o644); } catch { /* Windows retains platform permissions */ }
  }
}

function defaultGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status !== 0) throw new TestSandboxStagingError('TEST_SANDBOX_GIT_FAILED', `git ${args.join(' ')} failed`, { cwd, stderr: String(result.stderr ?? '').trim() });
  return String(result.stdout ?? '').trim();
}

export function createTestSandboxStager({ workspaceRoot: workspaceRootInput, runGit = defaultGit } = {}) {
  if (!workspaceRootInput) throw new TypeError('workspaceRoot is required');
  const workspaceRoot = resolve(workspaceRootInput);
  const stagingRoot = join(workspaceRoot, '.task-sandbox');
  const lockPath = join(workspaceRoot, '.task-sandbox.lock');
  let active = null;

  function acquire() {
    mkdirSync(workspaceRoot, { recursive: true });
    let descriptor;
    try { descriptor = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new TestSandboxStagingError('TEST_SANDBOX_BUSY', 'another TEST task owns the staging workspace', { lock_path_abs: lockPath });
      throw error;
    }
    closeSync(descriptor);
  }

  function release() { try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  function cleanRoot() {
    if (!inside(workspaceRoot, stagingRoot) || resolve(stagingRoot) === workspaceRoot) throw new TestSandboxStagingError('TEST_SANDBOX_PATH_UNSAFE', 'staging root escapes the dedicated test workspace');
    chmodWritable(stagingRoot);
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  function prepare(task) {
    if (active) throw new TestSandboxStagingError('TEST_SANDBOX_BUSY', 'this stager already owns a TEST task');
    acquire();
    try {
      cleanRoot();
      const inputRoot = inputRootForAttempt(task);
      if (!existsSync(inputRoot)) throw new TestSandboxStagingError('TEST_SANDBOX_INPUT_MISSING', `task input root is missing: ${inputRoot}`);
      safeTree(inputRoot, 'TEST_SANDBOX_INPUT_UNSAFE');
      if (!existsSync(task.worktreePathAbs)) throw new TestSandboxStagingError('TEST_SANDBOX_WORKTREE_MISSING', `task worktree is missing: ${task.worktreePathAbs}`);
      safeTree(task.worktreePathAbs, 'TEST_SANDBOX_WORKTREE_UNSAFE');
      const executionInputRootAbs = join(stagingRoot, 'input');
      const executionWorktreeAbs = join(stagingRoot, 'repo');
      const executionOutputRootAbs = join(stagingRoot, 'output');
      const executionRawLogsRootAbs = join(stagingRoot, 'raw-logs');
      cpSync(inputRoot, executionInputRootAbs, { recursive: true, dereference: false, errorOnExist: true });
      chmodReadOnly(executionInputRootAbs);
      mkdirSync(executionOutputRootAbs, { recursive: true });
      mkdirSync(executionRawLogsRootAbs, { recursive: true });
      runGit(workspaceRoot, ['clone', '--no-local', task.worktreePathAbs, executionWorktreeAbs]);
      const stagedCommit = runGit(executionWorktreeAbs, ['rev-parse', 'HEAD']);
      if (stagedCommit !== task.inputCommit) throw new TestSandboxStagingError('TEST_SANDBOX_INPUT_COMMIT_MISMATCH', 'staged repository does not match the assigned input commit', { expected: task.inputCommit, actual: stagedCommit });
      active = {
        executionRootAbs: stagingRoot,
        executionInputRootAbs,
        executionWorktreeAbs,
        executionOutputRootAbs,
        executionRawOutputPath: join(executionOutputRootAbs, 'result.json.raw'),
        executionRawLogsRootAbs,
        attestation: {
          backend: 'openclaw-workspace-staging', workspace_root_abs: workspaceRoot,
          execution_root_abs: stagingRoot, input_commit: stagedCommit,
          input_root_abs: executionInputRootAbs, worktree_root_abs: executionWorktreeAbs,
          output_root_abs: executionOutputRootAbs, raw_logs_root_abs: executionRawLogsRootAbs,
        },
      };
      return active;
    } catch (error) {
      cleanRoot(); release(); throw error;
    }
  }

  function collect(task, staging) {
    if (staging !== active) throw new TestSandboxStagingError('TEST_SANDBOX_STAGING_UNKNOWN', 'staging result does not belong to this stager');
    const hostRawOutputPath = rawOutputPath(task);
    regular(staging.executionRawOutputPath, 'TEST_SANDBOX_OUTPUT_MISSING');
    mkdirSync(dirname(hostRawOutputPath), { recursive: true });
    copyFileSync(staging.executionRawOutputPath, hostRawOutputPath);
    const hostRawLogsRoot = join(task.artifactRootAbs, 'raw-logs');
    mkdirSync(hostRawLogsRoot, { recursive: true });
    safeTree(staging.executionRawLogsRootAbs, 'TEST_SANDBOX_LOG_UNSAFE');
    const rawLogs = [];
    for (const entry of readdirSync(staging.executionRawLogsRootAbs, { withFileTypes: true })) {
      const source = join(staging.executionRawLogsRootAbs, entry.name);
      const target = join(hostRawLogsRoot, entry.name);
      cpSync(source, target, { recursive: entry.isDirectory(), dereference: false, errorOnExist: false });
      rawLogs.push(target);
    }
    return { rawOutputPath: hostRawOutputPath, rawLogs };
  }

  function cleanup(staging) {
    if (staging !== active) return;
    try { cleanRoot(); } finally { active = null; release(); }
  }

  return { prepare, collect, cleanup };
}
