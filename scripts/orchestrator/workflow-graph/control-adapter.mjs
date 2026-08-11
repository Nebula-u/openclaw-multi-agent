import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { auditControlDatabase } from '../../control-core/audit.mjs';
import { createControlSnapshot } from '../../control-core/read-model.mjs';
import { createControlRepository } from '../../control-core/repository.mjs';
import { createTaskRepository } from '../../control-core/task-repository.mjs';
import { canonicalJson } from '../../runtime-core/atomic-store.mjs';
import { dispatchReadyTask } from '../service.mjs';

function parseJson(value) { return value == null ? null : JSON.parse(value); }

function commandId(graphRunId, command) {
  const digest = createHash('sha256').update(canonicalJson({ graphRunId, ...command })).digest('hex').slice(0, 32);
  return `CMD-GRAPH-${digest}`;
}

export function createWorkflowGraphAdapter({ projectRoot, databasePath, database, runner, clock = () => new Date() }) {
  const controls = createControlRepository(projectRoot, database);
  const tasks = createTaskRepository(projectRoot, database);

  function taskRows(workflowId) {
    return database.prepare('SELECT task_json FROM tasks WHERE workflow_id=? ORDER BY updated_at DESC, task_id DESC')
      .all(workflowId).map((row) => parseJson(row.task_json));
  }

  return {
    audit() { return auditControlDatabase(database); },
    getWorkflow(workflowId) { return controls.get(workflowId); },
    snapshot(workflowId) { return createControlSnapshot(database, { workflowId, view: 'manager' }); },
    approvals(workflowId, status = null) { return controls.approvals({ workflowId, status }); },
    latestTask(workflowId, taskType) { return taskRows(workflowId).find((task) => task.task_type === taskType) ?? null; },
    taskResult(runId) {
      const row = database.prepare('SELECT result_json FROM task_runs WHERE run_id=?').get(runId);
      return parseJson(row?.result_json);
    },
    readDeclaredOutput(task, schemaFileName) {
      const output = task?.structured_outputs?.find((item) => basename(item.schema_path_abs) === schemaFileName && item.required);
      if (!output || !existsSync(output.path_abs)) return null;
      return { task, output, value: JSON.parse(readFileSync(output.path_abs, 'utf8')) };
    },
    latestDeclaredOutput(workflowId, schemaFileName, predicate = () => true) {
      for (const task of taskRows(workflowId)) {
        const found = this.readDeclaredOutput(task, schemaFileName);
        if (found && predicate(found.value, task)) return found;
      }
      return null;
    },
    validateTask(taskId) { return tasks.validatePackage(taskId, clock().toISOString()); },
    async dispatch(taskId) {
      return dispatchReadyTask({ projectRoot, databasePath, taskId, runner, clock });
    },
    apply(graphRunId, workflow, action) {
      const occurredAt = clock().toISOString();
      const input = {
        schema_version: 1,
        command_id: commandId(graphRunId, {
          workflow_id: workflow.workflow_id,
          expected_revision: workflow.revision,
          command_type: action.command_type,
          target_phase: action.target_phase ?? null,
          outcome: action.outcome ?? null,
          candidate_commit: action.candidate_commit ?? null,
          payload: action.payload ?? {},
        }),
        workflow_id: workflow.workflow_id,
        expected_revision: workflow.revision,
        command_type: action.command_type,
        actor: 'local-orchestrator',
        occurred_at: occurredAt,
        reason: action.reason,
        target_phase: action.target_phase ?? null,
        outcome: action.outcome ?? null,
        candidate_commit: action.candidate_commit ?? null,
        payload: { graph_run_id: graphRunId, ...(action.payload ?? {}) },
      };
      return controls.apply(input);
    },
  };
}
