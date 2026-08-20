import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const FULL_SHA = /^[0-9a-f]{40}$/u;
function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function inside(root, path) { const value = relative(resolve(root), resolve(path)); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)); }
function key(kind, value) { return `${kind}-${createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 20)}`; }
function output(result, action) {
  if (result.error || result.status !== 0) fail('GIT_COMMAND_FAILED', `${action} failed`, { status: result.status ?? null, stderr: String(result.stderr ?? '').trim() });
  return String(result.stdout ?? '').trim();
}

export function createGitWorktreeManager({ projectRoot: projectRootInput, runGit = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const invoke = runGit ?? ((cwd, args) => spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000 }));
  const git = (cwd, args, action) => output(invoke(cwd, args), action);
  const worktreesRoot = join(projectRoot, 'runtime', 'worktrees');
  function inspectTarget(targetInput) {
    if (!isAbsolute(targetInput ?? '') || !existsSync(targetInput)) fail('TARGET_REPOSITORY_MISSING', 'project_path_abs must be an existing absolute path');
    const target = realpathSync.native(resolve(targetInput));
    if (lstatSync(target).isSymbolicLink()) fail('TARGET_REPOSITORY_SYMLINK', 'project root cannot be a symbolic link');
    const top = realpathSync.native(resolve(git(target, ['rev-parse', '--show-toplevel'], 'resolve project repository')));
    if (top.toLowerCase() !== target.toLowerCase()) fail('TARGET_REPOSITORY_NOT_ROOT', 'project_path_abs must be the Git repository root');
    const head = git(target, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve project HEAD');
    if (!FULL_SHA.test(head)) fail('TARGET_COMMIT_INVALID', 'target HEAD is not a full commit SHA');
    return { targetProjectRootAbs: top, headCommit: head };
  }
  function pathFor(task) { return join(worktreesRoot, key('w', task.workflowId), key('t', task.taskId), key('r', task.runId), 'repo'); }
  function prepare(task) {
    if (!FULL_SHA.test(task.inputCommit ?? '')) fail('TASK_INPUT_COMMIT_INVALID', 'task input commit must be a full SHA');
    const expected = pathFor(task); if (!inside(worktreesRoot, expected)) fail('TASK_WORKTREE_ESCAPE', 'worktree path escapes runtime/worktrees');
    mkdirSync(dirname(expected), { recursive: true });
    if (!existsSync(expected)) git(task.targetProjectRootAbs, ['worktree', 'add', '--detach', expected, task.inputCommit], 'create isolated task worktree');
    const canonical = realpathSync.native(expected); if (!inside(worktreesRoot, canonical)) fail('TASK_WORKTREE_ESCAPE', 'canonical worktree path escapes runtime/worktrees');
    const head = git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 'verify isolated task worktree');
    if (head !== task.inputCommit) fail('TASK_WORKTREE_HEAD_MISMATCH', 'isolated worktree is not at input commit');
    return { worktreePathAbs: canonical, inputCommit: head };
  }
  return { inspectTarget, prepare, pathFor, worktreesRoot };
}
