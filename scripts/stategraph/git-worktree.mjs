import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/u;

export class GitWorktreeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitWorktreeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new GitWorktreeError(code, message, details);
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function defaultRunGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
}

function output(result, operation) {
  if (result.error || result.status !== 0) {
    fail('GIT_COMMAND_FAILED', `${operation} failed`, {
      status: result.status ?? null,
      error: result.error?.message ?? null,
      stdout: String(result.stdout ?? '').trim(),
      stderr: String(result.stderr ?? '').trim(),
    });
  }
  return String(result.stdout ?? '').trim();
}

export function createGitWorktreeManager({ projectRoot: projectRootInput, runGit = defaultRunGit } = {}) {
  const projectRoot = resolve(projectRootInput);
  const worktreesRoot = join(projectRoot, 'runtime', 'worktrees');

  function git(cwd, args, operation) {
    return output(runGit(cwd, args), operation);
  }

  function inspectTarget(targetInput) {
    if (!isAbsolute(targetInput ?? '') || !existsSync(targetInput)) fail('TARGET_REPOSITORY_MISSING', 'target project must be an existing absolute path');
    const target = realpathSync.native(resolve(targetInput));
    if (lstatSync(target).isSymbolicLink()) fail('TARGET_REPOSITORY_SYMLINK', 'target project root must not be a symbolic link');
    const top = realpathSync.native(resolve(git(target, ['rev-parse', '--show-toplevel'], 'resolve target repository')));
    if (normalized(top) !== normalized(target)) fail('TARGET_REPOSITORY_NOT_ROOT', 'project_path_abs must be the Git repository root', { target, repository_root: top });
    const head = git(target, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve target HEAD');
    if (!FULL_SHA.test(head)) fail('TARGET_COMMIT_INVALID', 'target HEAD is not a full commit SHA', { head });
    return { target_project_root_abs: top, head_commit: head };
  }

  function pathFor(task) {
    return join(worktreesRoot, task.workflow_id, task.task_id, task.run_id, 'repo');
  }

  function prepare(task) {
    if (!FULL_SHA.test(task.input_commit ?? '')) fail('TASK_INPUT_COMMIT_INVALID', 'task input_commit must be a full Git commit SHA');
    const expected = pathFor(task);
    if (task.worktree_path_abs && normalized(task.worktree_path_abs) !== normalized(expected)) {
      fail('TASK_WORKTREE_PATH_MISMATCH', 'task worktree path does not match the code-defined run path', { expected, actual: task.worktree_path_abs });
    }
    if (!inside(worktreesRoot, expected)) fail('TASK_WORKTREE_ESCAPE', 'task worktree path escapes runtime/worktrees');
    mkdirSync(dirname(expected), { recursive: true });
    if (!existsSync(expected)) git(task.target_project_root_abs, ['worktree', 'add', '--detach', expected, task.input_commit], 'create isolated task worktree');
    const canonical = realpathSync.native(expected);
    if (!inside(worktreesRoot, canonical)) fail('TASK_WORKTREE_ESCAPE', 'canonical worktree path escapes runtime/worktrees', { canonical });
    const head = git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 'verify isolated task worktree');
    if (head !== task.input_commit) fail('TASK_WORKTREE_HEAD_MISMATCH', 'isolated worktree is not bound to input_commit', { expected: task.input_commit, actual: head });
    return { worktree_path_abs: canonical, input_commit: head };
  }

  function assertCommit(repository, commit) {
    if (!FULL_SHA.test(commit ?? '')) fail('OUTPUT_COMMIT_INVALID', 'output commit must be a full Git commit SHA', { commit });
    const type = git(repository, ['cat-file', '-t', commit], 'verify output commit');
    if (type !== 'commit') fail('OUTPUT_COMMIT_NOT_COMMIT', 'output_commit does not resolve to a Git commit', { commit, type });
    return true;
  }

  function assertDescendant(repository, ancestor, descendant) {
    assertCommit(repository, ancestor);
    assertCommit(repository, descendant);
    const result = runGit(repository, ['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.error || result.status !== 0) fail('OUTPUT_COMMIT_ANCESTRY_INVALID', 'output_commit is not based on input_commit', { ancestor, descendant });
    return true;
  }

  function head(repository) {
    return git(repository, ['rev-parse', '--verify', 'HEAD^{commit}'], 'read worktree HEAD');
  }

  return { projectRoot, worktreesRoot, inspectTarget, pathFor, prepare, assertCommit, assertDescendant, head };
}

