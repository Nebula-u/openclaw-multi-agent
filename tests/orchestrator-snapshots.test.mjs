import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { createGitWorktreeManager } from '../scripts/orchestrator/git-worktree.mjs';
import { createSnapshotService } from '../scripts/orchestrator/snapshot-service.mjs';

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, 'init'); git(root, 'config', 'user.name', 'Snapshot Test'); git(root, 'config', 'user.email', 'snapshot@example.invalid');
  writeFileSync(join(root, '.gitignore'), 'work/\n'); writeFileSync(join(root, 'app.txt'), 'base\n');
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

test('retry attempts use different deterministic worktree paths', (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const common = { workflowId: 'WF-retry', taskId: 'TASK-retry', runId: 'RUN-retry' };
  assert.notEqual(worktrees.pathFor({ ...common, attempt: 1 }), worktrees.pathFor({ ...common, attempt: 2 }));
});

test('task worktree is created in a readable project work directory', (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-readable', taskId: 'TASK-readable', runId: 'RUN-readable', attempt: 1,
    agentId: 'developer-agent', title: 'Add login flow', inputCommit: repo.base, targetProjectRootAbs: repo.root });

  assert.equal(relative(join(repo.root, 'work'), prepared.worktreePathAbs).startsWith('..'), false);
  assert.match(prepared.worktreePathAbs, /work[\\/]snapshot-repo-[^\\/]+[\\/]developer-agent[\\/]operation-0001[\\/]repo$/u);
  assert.doesNotMatch(prepared.worktreePathAbs, /runtime[\\/]worktrees/u);
});

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

test('host rejects repository changes from a non-mutating Agent role', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-review-only', taskId: 'TASK-review-only', runId: 'RUN-review-only', attempt: 1,
    inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'unauthorized review edit\n');
  git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'unauthorized');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD');
  const service = createSnapshotService({ repository: memoryRepository(), worktrees });
  await assert.rejects(service.accept({ snapshotId: 'SNP-review-only', runId: 'RUN-review-only', taskId: 'TASK-review-only',
    executionId: 'EXE-review-only', attempt: 1, agentId: 'review-agent', sessionId: 'review-session', inputCommit: repo.base,
    outputCommit, worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root }),
  (error) => error.code === 'SNAPSHOT_AGENT_CHANGE_UNAUTHORIZED');
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

test('text-only snapshot diff does not inline binary patch payloads', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  const prepared = worktrees.prepare({ workflowId: 'WF-binary', taskId: 'TASK-binary', runId: 'RUN-binary', attempt: 1,
    inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'image.bin'), Buffer.from([0, 1, 2, 3, 255]));
  git(prepared.worktreePathAbs, 'add', 'image.bin'); git(prepared.worktreePathAbs, 'commit', '-m', 'binary');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD'); const service = createSnapshotService({ repository: store, worktrees });
  await service.accept({ snapshotId: 'SNP-binary', runId: 'RUN-binary', taskId: 'TASK-binary', executionId: 'EXE-binary', attempt: 1,
    agentId: 'developer-agent', sessionId: 'binary-session', inputCommit: repo.base, outputCommit,
    worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root });
  const value = await service.diff('SNP-binary', { binary: false });
  assert.doesNotMatch(value.patch, /GIT binary patch/u);
  assert.match(value.patch, /Binary files/u);
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

test('snapshot persistence failure removes the newly pinned hidden ref', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-compensate', taskId: 'TASK-compensate', runId: 'RUN-compensate', attempt: 1,
    inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'compensate\n'); git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'compensate');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD');
  const store = memoryRepository(); store.createSnapshot = async () => { throw Object.assign(new Error('index unavailable'), { code: 'SQLITE_INDEX_FAILED' }); };
  const service = createSnapshotService({ repository: store, worktrees });
  await assert.rejects(service.accept({ snapshotId: 'SNP-compensate', runId: 'RUN-compensate', taskId: 'TASK-compensate', executionId: null,
    attempt: 1, agentId: 'developer-agent', sessionId: 'compensate-session', inputCommit: repo.base, outputCommit,
    worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root }), (error) => error.code === 'SQLITE_INDEX_FAILED');
  const ref = spawnSync('git', ['-C', repo.root, 'show-ref', '--verify', '--quiet', 'refs/openclaw/snapshots/SNP-compensate']);
  assert.notEqual(ref.status, 0);
});

test('candidate update failure preserves the accepted snapshot for reconciliation', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root });
  const prepared = worktrees.prepare({ workflowId: 'WF-candidate', taskId: 'TASK-candidate', runId: 'RUN-candidate', attempt: 1,
    inputCommit: repo.base, targetProjectRootAbs: repo.root });
  writeFileSync(join(prepared.worktreePathAbs, 'app.txt'), 'candidate\n'); git(prepared.worktreePathAbs, 'add', 'app.txt'); git(prepared.worktreePathAbs, 'commit', '-m', 'candidate');
  const outputCommit = git(prepared.worktreePathAbs, 'rev-parse', 'HEAD'); const store = memoryRepository();
  store.updateRun = async () => { throw Object.assign(new Error('candidate update failed'), { code: 'SQLITE_CANDIDATE_FAILED' }); };
  const service = createSnapshotService({ repository: store, worktrees });
  await assert.rejects(service.accept({ snapshotId: 'SNP-candidate', runId: 'RUN-candidate', taskId: 'TASK-candidate', executionId: null,
    attempt: 1, agentId: 'developer-agent', sessionId: 'candidate-session', inputCommit: repo.base, outputCommit,
    worktreePathAbs: prepared.worktreePathAbs, targetProjectRootAbs: repo.root }), (error) => {
    assert.equal(error.code, 'SNAPSHOT_CANDIDATE_UPDATE_FAILED');
    assert.equal(error.details.snapshot.snapshotId, 'SNP-candidate');
    return true;
  });
  assert.equal(store.snapshots.get('SNP-candidate').outputCommit, outputCommit);
  assert.equal(git(repo.root, 'rev-parse', 'refs/openclaw/snapshots/SNP-candidate'), outputCommit);
});

test('revert rejects a snapshot commit that is not an ancestor of current HEAD', async (t) => {
  const repo = repository(t); const branch = git(repo.root, 'branch', '--show-current');
  git(repo.root, 'checkout', '-b', 'snapshot-sibling'); writeFileSync(join(repo.root, 'sibling.txt'), 'sibling\n');
  git(repo.root, 'add', 'sibling.txt'); git(repo.root, 'commit', '-m', 'sibling'); const sibling = git(repo.root, 'rev-parse', 'HEAD');
  git(repo.root, 'checkout', branch);
  const store = memoryRepository(); store.targetProjectRootAbs = repo.root;
  store.snapshots.set('SNP-sibling', { snapshotId: 'SNP-sibling', runId: 'RUN-sibling', taskId: 'TASK-sibling', executionId: null,
    attempt: 1, agentId: 'developer-agent', sessionId: 'sibling-session', inputCommit: repo.base, outputCommit: sibling,
    gitRef: 'refs/openclaw/snapshots/SNP-sibling', snapshotKind: 'ACCEPTED', changeSummary: {}, worktreePathAbs: repo.root });
  const service = createSnapshotService({ repository: store, worktrees: createGitWorktreeManager({ projectRoot: repo.root }) });
  await assert.rejects(service.revert('SNP-sibling', { confirm: 'SNP-sibling' }), (error) => error.code === 'SNAPSHOT_REVERT_NOT_ANCESTOR');
  assert.equal(git(repo.root, 'rev-parse', 'HEAD'), repo.base);
});

test('restore index failure removes the new restore branch and worktree', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  store.snapshots.set('SNP-restore-failure', { snapshotId: 'SNP-restore-failure', runId: 'RUN-restore-failure', taskId: 'TASK-restore-failure',
    executionId: null, attempt: 1, agentId: 'developer-agent', sessionId: 'restore-failure-session', inputCommit: repo.base,
    outputCommit: repo.base, gitRef: 'refs/openclaw/snapshots/SNP-restore-failure', snapshotKind: 'NO_CHANGE', changeSummary: {}, worktreePathAbs: repo.root });
  store.createSnapshot = async () => { throw Object.assign(new Error('index unavailable'), { code: 'SQLITE_INDEX_FAILED' }); };
  const service = createSnapshotService({ repository: store, worktrees });
  await assert.rejects(service.restore('SNP-restore-failure'), (error) => error.code === 'SQLITE_INDEX_FAILED');
  assert.equal(git(repo.root, 'branch', '--list', 'openclaw/restore/*'), '');
  assert.doesNotMatch(git(repo.root, 'worktree', 'list', '--porcelain'), /runtime[\\/]restores/u);
});

test('revert index failure keeps the inverse commit and reports it for reconciliation', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  writeFileSync(join(repo.root, 'app.txt'), 'integrated\n'); git(repo.root, 'add', 'app.txt'); git(repo.root, 'commit', '-m', 'integrated');
  const integrated = git(repo.root, 'rev-parse', 'HEAD');
  store.snapshots.set('SNP-revert-index', { snapshotId: 'SNP-revert-index', runId: 'RUN-revert-index', taskId: 'TASK-revert-index',
    executionId: null, attempt: 1, agentId: 'developer-agent', sessionId: 'revert-index-session', inputCommit: repo.base,
    outputCommit: integrated, gitRef: 'refs/openclaw/snapshots/SNP-revert-index', snapshotKind: 'ACCEPTED', changeSummary: {}, worktreePathAbs: repo.root });
  store.createSnapshot = async () => { throw Object.assign(new Error('index unavailable'), { code: 'SQLITE_INDEX_FAILED' }); };
  const service = createSnapshotService({ repository: store, worktrees });
  let reconciliationCommit = null;
  await assert.rejects(service.revert('SNP-revert-index', { confirm: 'SNP-revert-index' }), (error) => {
    assert.equal(error.code, 'SNAPSHOT_REVERT_INDEX_FAILED'); reconciliationCommit = error.details.revert_commit; return true;
  });
  assert.equal(git(repo.root, 'rev-parse', 'HEAD'), reconciliationCommit);
  assert.equal(git(repo.root, 'show', 'HEAD:app.txt'), 'base');
});

test('revert candidate update failure preserves its indexed inverse snapshot', async (t) => {
  const repo = repository(t); const worktrees = createGitWorktreeManager({ projectRoot: repo.root }); const store = memoryRepository();
  store.targetProjectRootAbs = repo.root;
  writeFileSync(join(repo.root, 'app.txt'), 'integrated\n'); git(repo.root, 'add', 'app.txt'); git(repo.root, 'commit', '-m', 'integrated');
  const integrated = git(repo.root, 'rev-parse', 'HEAD');
  store.snapshots.set('SNP-revert-candidate', { snapshotId: 'SNP-revert-candidate', runId: 'RUN-revert-candidate', taskId: 'TASK-revert-candidate',
    executionId: null, attempt: 1, agentId: 'developer-agent', sessionId: 'revert-candidate-session', inputCommit: repo.base,
    outputCommit: integrated, gitRef: 'refs/openclaw/snapshots/SNP-revert-candidate', snapshotKind: 'ACCEPTED', changeSummary: {}, worktreePathAbs: repo.root });
  store.updateRun = async () => { throw Object.assign(new Error('candidate unavailable'), { code: 'SQLITE_CANDIDATE_FAILED' }); };
  const service = createSnapshotService({ repository: store, worktrees });
  await assert.rejects(service.revert('SNP-revert-candidate', { confirm: 'SNP-revert-candidate' }), (error) => {
    assert.equal(error.code, 'SNAPSHOT_CANDIDATE_UPDATE_FAILED');
    assert.equal(error.details.snapshot.snapshotKind, 'REVERT');
    return true;
  });
  const indexed = [...store.snapshots.values()].find((value) => value.snapshotKind === 'REVERT');
  assert.equal(indexed.outputCommit, git(repo.root, 'rev-parse', 'HEAD'));
});
