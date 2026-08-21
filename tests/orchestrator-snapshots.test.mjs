import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGitWorktreeManager } from '../scripts/orchestrator/git-worktree.mjs';
import { createSnapshotService } from '../scripts/orchestrator/snapshot-service.mjs';

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init'); git(root, 'config', 'user.name', 'Snapshot Test'); git(root, 'config', 'user.email', 'snapshot@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'runtime/\n'); writeFileSync(join(root, 'app.txt'), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'base');
  return { root, base: git(root, 'rev-parse', 'HEAD') };
}

function memoryRepository() {
  const snapshots = new Map(); const updates = [];
  return {
    snapshots, updates,
    async createSnapshot(value) { snapshots.set(value.snapshotId, value); return value; },
    async getSnapshot(id) { return snapshots.get(id) ?? null; },
    async listSnapshots() { return [...snapshots.values()]; },
    async updateRun(runId, patch) { updates.push({ runId, patch }); return { runId, ...patch }; },
    async getRunById(runId) { return { runId, targetProjectRootAbs: this.targetProjectRootAbs }; },
  };
}

test('host verifies output commit, computes changes and pins an accepted snapshot', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-one', taskId: 'TASK-one', runId: 'RUN-one', inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'changed\n'); git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'change');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD');
  const store = memoryRepository(); const service = createSnapshotService({ repository: store, worktrees });
  const snapshot = await service.accept({ snapshotId: 'SNP-accepted', runId: 'RUN-one', taskId: 'TASK-one', executionId: 'EXE-one', attempt: 1,
    agentId: 'developer-agent', sessionId: 'session-one', inputCommit: repo.base, outputCommit, worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root });
  assert.equal(snapshot.snapshotKind, 'ACCEPTED');
  assert.deepEqual(snapshot.changeSummary.modified, ['app.txt']);
  assert.equal(git(repo.root, 'rev-parse', snapshot.gitRef), outputCommit);
  assert.deepEqual(store.updates, [{ runId: 'RUN-one', patch: { candidateCommit: outputCommit } }]);
});

test('restore creates a new branch and worktree without rewriting current history', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  const prepared = worktrees.prepare({ workflowId: 'WF-restore', taskId: 'TASK-restore', runId: 'RUN-restore', inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'snapshot\n'); git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'snapshot');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD'); const service = createSnapshotService({ repository: store, worktrees });
  await service.accept({ snapshotId: 'SNP-source', runId: 'RUN-restore', taskId: 'TASK-restore', executionId: null, attempt: 1,
    agentId: 'developer-agent', sessionId: 'restore-session', inputCommit: repo.base, outputCommit, worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root });
  const restored = await service.restore('SNP-source');
  assert.equal(git(restored.worktreePathAbs, 'rev-parse', 'HEAD'), outputCommit);
  assert.equal(restored.snapshotKind, 'RESTORE');
  assert.equal(git(repo.root, 'rev-parse', 'HEAD'), repo.base);
});

test('snapshot diff remains available after the task worktree is removed', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  const prepared = worktrees.prepare({ workflowId: 'WF-diff', taskId: 'TASK-diff', runId: 'RUN-diff', inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'historical diff\n'); git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'historical diff');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD'); const service = createSnapshotService({ repository: store, worktrees });
  await service.accept({ snapshotId: 'SNP-diff', runId: 'RUN-diff', taskId: 'TASK-diff', executionId: null, attempt: 1,
    agentId: 'developer-agent', sessionId: 'diff-session', inputCommit: repo.base, outputCommit,
    worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root });
  git(repo.root, 'worktree', 'remove', '--force', prepared.worktreePathAbs);
  const value = await service.diff('SNP-diff');
  assert.match(value.patch, /\+historical diff/u);
});

test('revert requires exact confirmation and creates a new inverse commit', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  writeFileSync(join(repo.root, 'app.txt'), 'integrated\n'); git(repo.root, 'add', 'app.txt'); git(repo.root, 'commit', '-m', 'integrated');
  const outputCommit = git(repo.root, 'rev-parse', 'HEAD');
  store.snapshots.set('SNP-integrated', { snapshotId: 'SNP-integrated', runId: 'RUN-integrated', taskId: 'TASK-integrated', executionId: null,
    attempt: 1, agentId: 'developer-agent', sessionId: 'integrated-session', inputCommit: repo.base, outputCommit,
    gitRef: 'refs/openclaw/snapshots/SNP-integrated', snapshotKind: 'ACCEPTED', changeSummary: {}, worktreePathAbs: repo.root });
  const service = createSnapshotService({ repository: store, worktrees });
  await assert.rejects(service.revert('SNP-integrated', { confirm: 'wrong' }), (error) => error.code === 'SNAPSHOT_REVERT_CONFIRMATION_REQUIRED');
  const reverted = await service.revert('SNP-integrated', { confirm: 'SNP-integrated' });
  assert.equal(reverted.snapshotKind, 'REVERT');
  assert.equal(git(repo.root, 'show', 'HEAD:app.txt'), 'base');
  assert.notEqual(reverted.outputCommit, outputCommit);
});

test('host rejects a dirty successful worktree', (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-dirty', taskId: 'TASK-dirty', runId: 'RUN-dirty', inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'dirty\n');
  assert.throws(() => worktrees.verifyCompletion({ inputCommit: repo.base, outputCommit: repo.base, worktreePathAbs: prepared.worktreePathAbs }),
    (error) => error.code === 'TASK_WORKTREE_DIRTY');
});

test('host captures a failed dirty worktree as a pinned recovery commit', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-failed', taskId: 'TASK-failed', runId: 'RUN-failed', inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'recovery.txt'), 'unfinished\n');
  const service = createSnapshotService({ repository: memoryRepository(), worktrees });
  const snapshot = await service.recover({ snapshotId: 'SNP-recovery', runId: 'RUN-failed', taskId: 'TASK-failed', executionId: 'EXE-failed', attempt: 1,
    agentId: 'developer-agent', sessionId: 'session-failed', inputCommit: repo.base, worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root });
  assert.equal(snapshot.snapshotKind, 'FAILED_RECOVERY');
  assert.deepEqual(snapshot.changeSummary.added, ['recovery.txt']);
  assert.equal(git(repo.root, 'rev-parse', snapshot.gitRef), snapshot.outputCommit);
});
