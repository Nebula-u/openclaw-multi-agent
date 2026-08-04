import { join } from 'node:path';
import { canonicalJson, serializeJson, sha256Text } from './atomic-store.mjs';

export function taskRunArchivePath(workflowDir, taskId, runId) {
  return join(workflowDir, 'task-runs', taskId, `${runId}.json`);
}

export function createTaskRunArchive(task, stateRevision, archivedAt = new Date().toISOString()) {
  return {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    archived_at: archivedAt,
    archived_state_revision: stateRevision,
    task_snapshot_sha256: sha256Text(canonicalJson(task)),
    task_snapshot: task,
  };
}

export function serializeTaskRunArchive(task, stateRevision, archivedAt) {
  return serializeJson(createTaskRunArchive(task, stateRevision, archivedAt));
}
