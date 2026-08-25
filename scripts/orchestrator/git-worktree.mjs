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

function changeSummary(nameStatus, stat) {
  const summary = { added: [], modified: [], deleted: [], renamed: [], stat };
  for (const line of String(nameStatus).split(/\r?\n/u).filter(Boolean)) {
    const [status, first, second] = line.split('\t');
    if (status === 'A') summary.added.push(first);
    else if (status === 'D') summary.deleted.push(first);
    else if (status?.startsWith('R')) summary.renamed.push({ from: first, to: second, similarity: status.slice(1) || null });
    else summary.modified.push(first);
  }
  return summary;
}

export function createGitWorktreeManager({ projectRoot: projectRootInput, runGit = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const invoke = runGit ?? ((cwd, args) => spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000 }));
  const git = (cwd, args, action) => output(invoke(cwd, args), action);
  const worktreesRoot = join(projectRoot, 'runtime', 'worktrees');
  const restoresRoot = join(projectRoot, 'runtime', 'restores');
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
  function pathFor(task) { return join(worktreesRoot, key('w', task.workflowId), key('t', task.taskId),
    key('r', task.runId), key('a', String(task.attempt ?? 1)), 'repo'); }
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
  function summarize(cwd, inputCommit, outputCommit) {
    const names = git(cwd, ['diff', '--name-status', '--find-renames', inputCommit, outputCommit], 'summarize snapshot files');
    const stat = git(cwd, ['diff', '--stat', inputCommit, outputCommit], 'summarize snapshot diff');
    return changeSummary(names, stat);
  }
  function verifyCompletion({ inputCommit, outputCommit, worktreePathAbs }) {
    if (!FULL_SHA.test(inputCommit ?? '') || !FULL_SHA.test(outputCommit ?? '')) fail('TASK_OUTPUT_COMMIT_INVALID', 'input and output commits must be full SHA values');
    const cwd = realpathSync.native(resolve(worktreePathAbs));
    const type = git(cwd, ['cat-file', '-t', outputCommit], 'verify output commit');
    if (type !== 'commit') fail('TASK_OUTPUT_COMMIT_INVALID', 'output_commit is not a Git commit');
    const ancestry = invoke(cwd, ['merge-base', '--is-ancestor', inputCommit, outputCommit]);
    if (ancestry.error || ancestry.status !== 0) fail('TASK_OUTPUT_COMMIT_NOT_DESCENDANT', 'output_commit is not descended from input_commit');
    const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'verify worktree HEAD');
    if (head !== outputCommit) fail('TASK_OUTPUT_COMMIT_HEAD_MISMATCH', 'output_commit does not equal worktree HEAD', { head, outputCommit });
    const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 'verify clean worktree');
    if (status) fail('TASK_WORKTREE_DIRTY', 'successful Agent worktree contains uncommitted changes', { status });
    return { inputCommit, outputCommit, head, changeSummary: summarize(cwd, inputCommit, outputCommit) };
  }
  function fingerprint(worktreePathAbs) {
    const cwd = realpathSync.native(resolve(worktreePathAbs));
    return {
      head: git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'fingerprint worktree HEAD'),
      status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 'fingerprint worktree status'),
    };
  }
  function pinSnapshot({ targetProjectRootAbs, snapshotId, outputCommit }) {
    const ref = `refs/openclaw/snapshots/${snapshotId}`;
    git(targetProjectRootAbs, ['update-ref', ref, outputCommit, '0'.repeat(40)], 'pin snapshot commit');
    return ref;
  }
  function unpinSnapshot({ targetProjectRootAbs, snapshotId, outputCommit }) {
    const ref = `refs/openclaw/snapshots/${snapshotId}`;
    git(targetProjectRootAbs, ['update-ref', '-d', ref, outputCommit], 'remove unindexed snapshot ref');
    return ref;
  }
  function captureRecovery({ inputCommit, worktreePathAbs, snapshotId }) {
    const cwd = realpathSync.native(resolve(worktreePathAbs));
    const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 'inspect failed worktree');
    if (!status) {
      const head = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve failed worktree HEAD');
      return { inputCommit, outputCommit: head, snapshotKind: head === inputCommit ? 'NO_CHANGE' : 'FAILED_RECOVERY', changeSummary: summarize(cwd, inputCommit, head) };
    }
    git(cwd, ['add', '-A'], 'stage recovery snapshot');
    git(cwd, ['-c', 'user.name=OpenClaw Snapshot', '-c', 'user.email=openclaw-snapshot@invalid', 'commit', '-m', `openclaw: recovery snapshot ${snapshotId}`], 'commit recovery snapshot');
    const outputCommit = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve recovery commit');
    return { inputCommit, outputCommit, snapshotKind: 'FAILED_RECOVERY', changeSummary: summarize(cwd, inputCommit, outputCommit) };
  }
  function diffCommits({ worktreePathAbs, inputCommit, outputCommit, binary = true }) {
    const args = ['diff', '--no-ext-diff']; if (binary) args.push('--binary'); args.push(inputCommit, outputCommit);
    return git(worktreePathAbs, args, 'read snapshot diff');
  }
  function restoreSnapshot({ targetProjectRootAbs, snapshotId, outputCommit }) {
    if (!FULL_SHA.test(outputCommit ?? '')) fail('SNAPSHOT_COMMIT_INVALID', 'snapshot output commit must be a full SHA');
    const branch = `openclaw/restore/${String(snapshotId).toLowerCase()}`;
    const expected = join(restoresRoot, key('s', snapshotId), 'repo');
    if (existsSync(expected)) fail('SNAPSHOT_RESTORE_EXISTS', 'snapshot restore worktree already exists', { expected });
    mkdirSync(dirname(expected), { recursive: true });
    const existing = invoke(targetProjectRootAbs, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.status === 0) fail('SNAPSHOT_RESTORE_BRANCH_EXISTS', 'snapshot restore branch already exists', { branch });
    git(targetProjectRootAbs, ['branch', branch, outputCommit], 'create snapshot restore branch');
    try { git(targetProjectRootAbs, ['worktree', 'add', expected, branch], 'create snapshot restore worktree'); }
    catch (error) { invoke(targetProjectRootAbs, ['branch', '-D', branch]); throw error; }
    return { branch, worktreePathAbs: realpathSync.native(expected), inputCommit: outputCommit, outputCommit,
      changeSummary: summarize(expected, outputCommit, outputCommit) };
  }
  function cleanupRestore({ targetProjectRootAbs, branch, worktreePathAbs }) {
    const expected = resolve(worktreePathAbs);
    if (!inside(restoresRoot, expected) || !String(branch).startsWith('openclaw/restore/')) {
      fail('SNAPSHOT_RESTORE_CLEANUP_UNSAFE', 'restore cleanup target is outside the managed restore area');
    }
    if (existsSync(expected)) git(targetProjectRootAbs, ['worktree', 'remove', '--force', expected], 'remove unindexed restore worktree');
    const existing = invoke(targetProjectRootAbs, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (existing.status === 0) git(targetProjectRootAbs, ['branch', '-D', branch], 'remove unindexed restore branch');
  }
  function revertSnapshot({ targetProjectRootAbs, outputCommit }) {
    const cwd = realpathSync.native(resolve(targetProjectRootAbs));
    const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'], 'verify clean revert target');
    if (status) fail('SNAPSHOT_REVERT_TARGET_DIRTY', 'revert target contains uncommitted changes', { status });
    const inputCommit = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve revert input');
    const ancestry = invoke(cwd, ['merge-base', '--is-ancestor', outputCommit, inputCommit]);
    if (ancestry.error || ancestry.status !== 0) {
      fail('SNAPSHOT_REVERT_NOT_ANCESTOR', 'snapshot output commit is not an ancestor of current HEAD', { outputCommit, head: inputCommit });
    }
    const result = invoke(cwd, ['-c', 'user.name=OpenClaw Snapshot', '-c', 'user.email=openclaw-snapshot@invalid', 'revert', '--no-edit', outputCommit]);
    if (result.error || result.status !== 0) {
      invoke(cwd, ['revert', '--abort']);
      fail('SNAPSHOT_REVERT_CONFLICT', 'git revert could not be applied cleanly', { stderr: String(result.stderr ?? '').trim() });
    }
    const revertedCommit = git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve revert output');
    return { inputCommit, outputCommit: revertedCommit, worktreePathAbs: cwd, changeSummary: summarize(cwd, inputCommit, revertedCommit) };
  }
  return { inspectTarget, prepare, pathFor, worktreesRoot, restoresRoot, fingerprint, verifyCompletion, pinSnapshot, unpinSnapshot, captureRecovery,
    diffCommits, restoreSnapshot, cleanupRestore, revertSnapshot };
}
