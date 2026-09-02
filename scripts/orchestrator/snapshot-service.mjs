import { randomUUID } from 'node:crypto';

const MUTATING_AGENTS = new Set(['developer-agent', 'test-agent']);
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
    try {
      return await repository.createSnapshot({ snapshotId, runId: input.runId, taskId: input.taskId,
        executionId: input.executionId ?? null, attempt: input.attempt, agentId: input.agentId,
        sessionId: input.sessionId ?? null, inputCommit: input.inputCommit, outputCommit: verified.outputCommit,
        parentSnapshotId: input.parentSnapshotId ?? await parentFor(input.taskId), gitRef,
        snapshotKind, changeSummary: verified.changeSummary, worktreePathAbs: input.worktreePathAbs });
    } catch (error) {
      try { worktrees.unpinSnapshot({ targetProjectRootAbs: input.targetProjectRootAbs, snapshotId, outputCommit: verified.outputCommit }); }
      catch (compensationError) {
        error.details = { ...(error.details ?? {}), compensation_error: {
          code: compensationError.code ?? 'SNAPSHOT_REF_COMPENSATION_FAILED', message: compensationError.message,
        } };
      }
      throw error;
    }
  }
  async function updateCandidate(runId, candidateCommit, snapshot) {
    try { await repository.updateRun(runId, { candidateCommit }); }
    catch (cause) {
      throw Object.assign(new Error('snapshot was indexed but the run candidate commit could not be updated'), {
        code: 'SNAPSHOT_CANDIDATE_UPDATE_FAILED', cause,
        details: { snapshot, cause_code: cause.code ?? null },
      });
    }
  }
  async function accept(input) {
    const verified = worktrees.verifyCompletion(input);
    if (verified.inputCommit !== verified.outputCommit && !MUTATING_AGENTS.has(input.agentId)) {
      throw Object.assign(new Error(`${input.agentId} is not authorized to change the target repository`), {
        code: 'SNAPSHOT_AGENT_CHANGE_UNAUTHORIZED', details: { agent_id: input.agentId, task_id: input.taskId },
      });
    }
    const kind = verified.inputCommit === verified.outputCommit ? 'NO_CHANGE' : 'ACCEPTED';
    const snapshot = await persist(input, verified, kind);
    await updateCandidate(input.runId, verified.outputCommit, snapshot);
    return snapshot;
  }
  async function recover(input) {
    const snapshotId = input.snapshotId ?? newSnapshotId();
    const recovered = worktrees.captureRecovery({ ...input, snapshotId });
    return persist({ ...input, snapshotId }, recovered, recovered.snapshotKind);
  }
  async function list(filters = {}) { return repository.listSnapshots(filters); }
  async function show(snapshotId) { return repository.getSnapshot(snapshotId); }
  async function diff(snapshotId, { binary = true } = {}) {
    const snapshot = await show(snapshotId);
    if (!snapshot) throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: 'SNAPSHOT_NOT_FOUND' });
    const targetProjectRootAbs = await targetFor(snapshot);
    return { snapshot, patch: worktrees.diffCommits({ worktreePathAbs: targetProjectRootAbs,
      inputCommit: snapshot.inputCommit, outputCommit: snapshot.outputCommit, binary }) };
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
    try {
      return await persist({ ...source, snapshotId: newId, parentSnapshotId: source.snapshotId, targetProjectRootAbs,
        inputCommit: source.outputCommit, worktreePathAbs: restored.worktreePathAbs }, restored, 'RESTORE');
    } catch (error) {
      try { worktrees.cleanupRestore({ targetProjectRootAbs, branch: restored.branch, worktreePathAbs: restored.worktreePathAbs }); }
      catch (compensationError) {
        error.details = { ...(error.details ?? {}), compensation_error: {
          code: compensationError.code ?? 'SNAPSHOT_RESTORE_COMPENSATION_FAILED', message: compensationError.message,
        } };
      }
      throw error;
    }
  }
  async function revert(snapshotId, { confirm } = {}) {
    if (confirm !== snapshotId) throw Object.assign(new Error('snapshot revert requires the exact snapshot id as confirmation'), { code: 'SNAPSHOT_REVERT_CONFIRMATION_REQUIRED' });
    const source = await show(snapshotId);
    if (!source) throw Object.assign(new Error(`snapshot not found: ${snapshotId}`), { code: 'SNAPSHOT_NOT_FOUND' });
    const targetProjectRootAbs = await targetFor(source); const newId = newSnapshotId();
    const reverted = worktrees.revertSnapshot({ targetProjectRootAbs, outputCommit: source.outputCommit });
    let snapshot;
    try {
      snapshot = await persist({ ...source, snapshotId: newId, parentSnapshotId: source.snapshotId, targetProjectRootAbs,
        inputCommit: reverted.inputCommit, worktreePathAbs: reverted.worktreePathAbs }, reverted, 'REVERT');
    } catch (cause) {
      throw Object.assign(new Error('revert commit was created but its SQLite snapshot index could not be written'), {
        code: 'SNAPSHOT_REVERT_INDEX_FAILED', cause,
        details: { revert_commit: reverted.outputCommit, target_project_root_abs: targetProjectRootAbs,
          cause_code: cause.code ?? null, compensation_error: cause.details?.compensation_error ?? null },
      });
    }
    await updateCandidate(source.runId, reverted.outputCommit, snapshot);
    return snapshot;
  }
  return { accept, recover, list, show, diff, restore, revert };
}
