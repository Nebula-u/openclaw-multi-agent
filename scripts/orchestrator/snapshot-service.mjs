import { randomUUID } from 'node:crypto';

function newSnapshotId() { return `SNP-${randomUUID().replaceAll('-', '').slice(0, 20)}`; }

export function createSnapshotService({ repository, worktrees }) {
  if (!repository || !worktrees) throw new TypeError('repository and worktrees are required');

  async function parentFor(taskId) {
    const values = await repository.listSnapshots?.({ taskId, limit: 1 });
    return values?.[0]?.snapshotId ?? null;
  }
  async function persist(input, verified, snapshotKind) {
    const snapshotId = input.snapshotId ?? newSnapshotId();
    const gitRef = worktrees.pinSnapshot({ targetProjectRootAbs: input.targetProjectRootAbs, snapshotId, outputCommit: verified.outputCommit });
    return repository.createSnapshot({ snapshotId, runId: input.runId, taskId: input.taskId,
      executionId: input.executionId ?? null, attempt: input.attempt, agentId: input.agentId,
      sessionId: input.sessionId ?? null, inputCommit: input.inputCommit, outputCommit: verified.outputCommit,
      parentSnapshotId: input.parentSnapshotId ?? await parentFor(input.taskId), gitRef,
      snapshotKind, changeSummary: verified.changeSummary, worktreePathAbs: input.worktreePathAbs });
  }
  async function accept(input) {
    const verified = worktrees.verifyCompletion(input);
    const kind = verified.inputCommit === verified.outputCommit ? 'NO_CHANGE' : 'ACCEPTED';
    const snapshot = await persist(input, verified, kind);
    await repository.updateRun(input.runId, { candidateCommit: verified.outputCommit });
    return snapshot;
  }
  async function recover(input) {
    const snapshotId = input.snapshotId ?? newSnapshotId();
    const recovered = worktrees.captureRecovery({ ...input, snapshotId });
    return persist({ ...input, snapshotId }, recovered, recovered.snapshotKind);
  }
  async function list(filters = {}) { return repository.listSnapshots(filters); }
  async function show(snapshotId) { return repository.getSnapshot(snapshotId); }
  async function diff(snapshotId) {
    const snapshot = await show(snapshotId);
    if (!snapshot) throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: 'SNAPSHOT_NOT_FOUND' });
    const targetProjectRootAbs = await targetFor(snapshot);
    return { snapshot, patch: worktrees.diffCommits({ worktreePathAbs: targetProjectRootAbs,
      inputCommit: snapshot.inputCommit, outputCommit: snapshot.outputCommit }) };
  }
  async function targetFor(snapshot) {
    const run = await repository.getRunById(snapshot.runId);
    if (!run?.targetProjectRootAbs) throw Object.assign(new Error(`target repository is unavailable for ${snapshot.runId}`), { code: 'SNAPSHOT_TARGET_MISSING' });
    return run.targetProjectRootAbs;
  }
  async function restore(snapshotId) {
    const source = await show(snapshotId);
    if (!source) throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: 'SNAPSHOT_NOT_FOUND' });
    const targetProjectRootAbs = await targetFor(source); const newId = newSnapshotId();
    const restored = worktrees.restoreSnapshot({ targetProjectRootAbs, snapshotId: newId, outputCommit: source.outputCommit });
    return persist({ ...source, snapshotId: newId, parentSnapshotId: source.snapshotId, targetProjectRootAbs,
      inputCommit: source.outputCommit, worktreePathAbs: restored.worktreePathAbs }, restored, 'RESTORE');
  }
  async function revert(snapshotId, { confirm } = {}) {
    if (confirm !== snapshotId) throw Object.assign(new Error('snapshot revert requires the exact snapshot id as confirmation'), { code: 'SNAPSHOT_REVERT_CONFIRMATION_REQUIRED' });
    const source = await show(snapshotId);
    if (!source) throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: 'SNAPSHOT_NOT_FOUND' });
    const targetProjectRootAbs = await targetFor(source); const newId = newSnapshotId();
    const reverted = worktrees.revertSnapshot({ targetProjectRootAbs, outputCommit: source.outputCommit });
    const snapshot = await persist({ ...source, snapshotId: newId, parentSnapshotId: source.snapshotId, targetProjectRootAbs,
      inputCommit: reverted.inputCommit, worktreePathAbs: reverted.worktreePathAbs }, reverted, 'REVERT');
    await repository.updateRun(source.runId, { candidateCommit: reverted.outputCommit });
    return snapshot;
  }
  return { accept, recover, list, show, diff, restore, revert };
}
