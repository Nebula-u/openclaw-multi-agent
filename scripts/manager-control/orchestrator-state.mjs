import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openKernelDatabase } from '../control-kernel/database.mjs';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

function fail(code, message, details = null) { throw Object.assign(new Error(message), { code, details }); }
function assertBinding(run, managerSessionId, managerSessionKey) {
  if (!run) fail('WORKFLOW_NOT_FOUND', 'workflow not found');
  if (run.managerSessionId !== managerSessionId || run.managerSessionKey !== managerSessionKey) fail('MANAGER_SESSION_MISMATCH', 'Manager session does not match workflow origin');
}
function publishedResult(row) {
  if (!row) return null;
  const payload = row.task_payload ? JSON.parse(row.task_payload) : {};
  const result = payload.result ?? {};
  const snapshot = payload.snapshot ?? {};
  return {
    task_id: row.task_id,
    worktree_path_abs: payload.worktree_path_abs ?? snapshot.worktreePathAbs ?? result.worktree_path_abs ?? null,
    artifact_root_abs: payload.artifact_root_abs ?? result.artifact_root_abs ?? null,
    published_output_path_abs: payload.published_output_path_abs ?? null,
    output_commit: snapshot.outputCommit ?? result.output_commit ?? null,
  };
}

export function readOrchestratorStatus({ runtimeRoot: runtimeRootInput, workflowId, managerSessionId, managerSessionKey }) {
  const runtimeRoot = resolve(runtimeRootInput);
  const databasePath = join(runtimeRoot, 'control', 'kernel.db');
  if (!existsSync(databasePath)) fail('KERNEL_DATABASE_MISSING', 'Control Kernel database does not exist');
  const database = openKernelDatabase({ databasePath, readonly: true, initialize: false });
  try {
    const row = database.get('SELECT run_id,workflow_id,state,current_step_index,manager_session_id,manager_session_key FROM runs WHERE workflow_id=?', [workflowId]);
    const run = row ? { runId: row.run_id, workflowId: row.workflow_id, state: row.state, currentStepIndex: row.current_step_index,
      managerSessionId: row.manager_session_id, managerSessionKey: row.manager_session_key } : null;
    assertBinding(run, managerSessionId, managerSessionKey);
    const approvalRow = database.get("SELECT decision_id,task_id,step_id,trigger,request FROM approvals WHERE run_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [run.runId]);
    const pending = approvalRow ? { decisionId: approvalRow.decision_id, taskId: approvalRow.task_id, stepId: approvalRow.step_id,
      trigger: approvalRow.trigger, request: approvalRow.request ? JSON.parse(approvalRow.request) : {} } : null;
    const latestSucceededTask = database.get("SELECT task_id,task_payload FROM tasks WHERE run_id=? AND state='SUCCEEDED' ORDER BY updated_at DESC,created_at DESC LIMIT 1", [run.runId]);
    return { workflow_id: run.workflowId, run_id: run.runId, state: run.state, current_step_index: run.currentStepIndex,
      pending_approval: pending ? { decision_id: pending.decisionId, task_id: pending.taskId, step_id: pending.stepId, summary: pending.request?.summary ?? pending.trigger,
        options: pending.request?.options ?? [] } : null,
      published_result: publishedResult(latestSucceededTask) };
  } finally { database.close(); }
}

export function submitOrchestratorApproval({ runtimeRoot: runtimeRootInput, workflowId, managerSessionId, managerSessionKey, decisionId, choice, authorization, notes = '' }) {
  const runtimeRoot = resolve(runtimeRootInput);
  const status = readOrchestratorStatus({ runtimeRoot, workflowId, managerSessionId, managerSessionKey });
  const approval = status.pending_approval;
  if (!approval || approval.decision_id !== decisionId) fail('APPROVAL_NOT_PENDING', 'approval not found or already resolved');
  if (!approval.options.map((option) => option.option_id).includes(choice)) fail('APPROVAL_OPTION_INVALID', 'approval choice is not allowed');
  if (!authorization || authorization.confirmed !== true || !/^human:[A-Za-z0-9._-]+$/u.test(authorization.actor ?? '') || typeof authorization.message !== 'string' || !authorization.message) {
    fail('MANAGER_REQUEST_AUTH_INVALID', 'authorization must contain an explicit human confirmation');
  }
  const requestId = `REQ-${randomUUID().replaceAll('-', '')}`;
  const request = { schema_version: 1, request_id: requestId, request_type: 'DECISION', workflow_id: workflowId, submitted_by: 'manager-agent',
    submitted_at: new Date().toISOString(), manager_session_id: managerSessionId, manager_session_key: managerSessionKey, decision_id: decisionId,
    choice, notes: String(notes ?? ''), user_authorized: authorization };
  const requestPath = join(runtimeRoot, 'agents', 'manager-agent', 'workspace', '.orchestrator', 'requests', `${requestId}.json`);
  atomicWriteJson(requestPath, request);
  return { request_id: requestId, request_path: requestPath, status: 'QUEUED' };
}

export function submitWorkflowControl({ runtimeRoot: runtimeRootInput, workflowId, managerSessionId, managerSessionKey, action, authorization, notes = '' }) {
  const runtimeRoot = resolve(runtimeRootInput);
  const status = readOrchestratorStatus({ runtimeRoot, workflowId, managerSessionId, managerSessionKey });
  if (!['PAUSE', 'RESUME'].includes(action)) fail('WORKFLOW_CONTROL_ACTION_INVALID', 'workflow control action is invalid');
  if (!authorization || authorization.confirmed !== true || !/^human:[A-Za-z0-9._-]+$/u.test(authorization.actor ?? '') || typeof authorization.message !== 'string' || !authorization.message) {
    fail('MANAGER_REQUEST_AUTH_INVALID', 'authorization must contain an explicit human confirmation');
  }
  const commandId = `WFC-${randomUUID().replaceAll('-', '')}`;
  const command = { schema_version: 1, command_id: commandId, workflow_id: workflowId, run_id: status.run_id, action,
    actor: authorization.actor, notes: String(notes ?? ''), submitted_at: new Date().toISOString() };
  const commandPath = join(runtimeRoot, 'orchestrator', 'workflow-control-commands', 'commands', `${commandId}.json`);
  atomicWriteJson(commandPath, command);
  return { command_id: commandId, command_path: commandPath, status: 'QUEUED' };
}
