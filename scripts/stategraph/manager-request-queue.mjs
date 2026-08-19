import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

const PROCESSED_NOW = Symbol('processedNow');

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function requestRoot(projectRoot, managerWorkspace) {
  return join(resolve(managerWorkspace ?? join(projectRoot, 'runtime', 'agents', 'manager-agent', 'workspace')), '.stategraph');
}
function assertRequest(value, projectRoot, targetProjectRoot) {
  if (!value || value.schema_version !== 1 || !['CREATE', 'CHANGE', 'DECISION'].includes(value.request_type)) throw Object.assign(new Error('manager request envelope is invalid'), { code: 'MANAGER_REQUEST_INVALID' });
  if (!/^REQ-[A-Za-z0-9-]+$/u.test(value.request_id ?? '')) throw Object.assign(new Error('request_id must start with REQ-'), { code: 'MANAGER_REQUEST_ID_INVALID' });
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(value.workflow_id ?? '')) throw Object.assign(new Error('workflow_id must start with WF-'), { code: 'WORKFLOW_ID_INVALID' });
  if (value.submitted_by !== 'manager-agent' || value.user_authorized?.confirmed !== true || !/^human:[A-Za-z0-9._-]+$/u.test(value.user_authorized?.actor ?? '')) {
    throw Object.assign(new Error('only a user-authorized Manager request may change StateGraph'), { code: 'MANAGER_REQUEST_AUTH_INVALID' });
  }
  if (value.request_type !== 'DECISION' && (!value.route_plan || value.route_plan.workflow_id !== value.workflow_id)) throw Object.assign(new Error('route_plan must be bound to workflow_id'), { code: 'ROUTE_PLAN_WORKFLOW_MISMATCH' });
  if (value.request_type === 'DECISION' && (!value.decision_id || !value.choice)) throw Object.assign(new Error('decision_id and choice are required'), { code: 'MANAGER_DECISION_INVALID' });
  const projectPath = resolve(value.project_path_abs ?? targetProjectRoot ?? projectRoot);
  if (!isAbsolute(projectPath) || !existsSync(projectPath)) throw Object.assign(new Error('project_path_abs must exist'), { code: 'WORKFLOW_PROJECT_PATH_INVALID' });
  return { ...value, project_path_abs: projectPath };
}
function managerView(state) {
  const latestResultTask = [...(state.tasks ?? [])].reverse().find((task) => task.result);
  const pending = state.pendingApproval;
  return {
    schema_version: 1,
    workflow_id: state.workflowId,
    revision: state.revision,
    title: state.workflowTitle,
    condition: state.condition,
    phase: state.phase,
    status_reason: state.statusReason,
    route_hash: state.routePlan?.route_hash ?? null,
    current_step_index: state.currentStepIndex,
    steps: (state.steps ?? []).map(({ step_id, kind, title, status, completed_at }) => ({ step_id, kind, title, status, completed_at: completed_at ?? null })),
    pending_user_decision: pending ? { decision_id: pending.decision_id, kind: pending.kind, title: pending.title, question: pending.summary ?? pending.question, options: pending.options } : null,
    // This is an explicit wake/notification contract for Manager. The Manager
    // must explain it to the user before creating a DECISION request.
    manager_notification: pending ? {
      type: 'HUMAN_APPROVAL_REQUIRED',
      action: 'EXPLAIN_TO_USER_AND_WAIT_FOR_CHOICE',
      message: `StateGraph 已暂停，等待人工审批：${pending.title ?? pending.kind}`,
      decision_id: pending.decision_id,
      kind: pending.kind,
      question: pending.summary ?? pending.question,
      options: pending.options,
    } : null,
    latest_agent_result: latestResultTask ? {
      agent_id: latestResultTask.agent_id,
      result_status: latestResultTask.result.result_status,
      summary_for_user: latestResultTask.result.summary_for_user,
      summary_for_manager: latestResultTask.result.summary_for_manager,
    } : null,
    updated_at: state.updatedAt,
  };
}

export function createManagerRequestProcessor({ runtime, projectRoot, managerWorkspace = null, targetProjectRoot = null } = {}) {
  const root = requestRoot(projectRoot, managerWorkspace);
  const requests = join(root, 'requests');
  const receipts = join(root, 'receipts');
  const status = join(root, 'status');
  mkdirSync(requests, { recursive: true }); mkdirSync(receipts, { recursive: true }); mkdirSync(status, { recursive: true });
  let scanning = false;

  async function publish(workflowId) {
    const state = await runtime.state(workflowId);
    if (state) atomicWriteJson(join(status, `${workflowId}.json`), managerView(state));
    return state;
  }

  async function advanceAndPublish(workflowId) {
    let state = await runtime.state(workflowId);
    if (state?.condition === 'ACTIVE') { await runtime.run(workflowId); state = await runtime.state(workflowId); }
    if (state) atomicWriteJson(join(status, `${workflowId}.json`), managerView(state));
    return state;
  }

  async function processFile(name) {
    const path = join(requests, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('manager request must be a regular file'), { code: 'MANAGER_REQUEST_UNSAFE' });
    const raw = readFileSync(path, 'utf8');
    const inputSha256 = sha256(raw);
    const receiptPath = join(receipts, `${name}.receipt.json`);
    if (existsSync(receiptPath)) {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (receipt.input_sha256 === inputSha256) return receipt;
    }
    let request;
    try {
      request = assertRequest(JSON.parse(raw), projectRoot, targetProjectRoot);
      if (request.request_type === 'CREATE') {
        await runtime.bootstrapConfirmed({
          workflowId: request.workflow_id,
          request: { text: request.original_request, project_path_abs: request.project_path_abs, source: 'MANAGER_CLI', source_session_key: request.source_session_key ?? null, submitted_by: 'manager-agent', submitted_at: request.submitted_at, user_confirmation: { confirmed: true, actor: request.user_authorized.actor, request_id: request.request_id, message: request.user_authorized.message } },
          routePlan: request.route_plan,
        });
      } else if (request.request_type === 'CHANGE') {
        await runtime.revise(request.workflow_id, { request_id: request.request_id, route_plan: request.route_plan, user_requested: true, requested_by: request.user_authorized.actor, submitted_by: 'manager-agent', user_request: request.user_authorized.message });
      } else {
        await runtime.approve(request.workflow_id, { decision_id: request.decision_id, choice: request.choice, decided_by: request.user_authorized.actor, notes: request.notes ?? request.user_authorized.message, decided_at: request.submitted_at ?? new Date().toISOString() });
      }
      const state = await publish(request.workflow_id);
      const receipt = { schema_version: 1, request_id: request.request_id, request_type: request.request_type, workflow_id: request.workflow_id, status: 'ACCEPTED', input_sha256: inputSha256, route_hash: state?.routePlan?.route_hash ?? null, processed_at: new Date().toISOString() };
      atomicWriteJson(receiptPath, receipt);
      Object.defineProperty(receipt, PROCESSED_NOW, { value: true });
      return receipt;
    } catch (error) {
      const receipt = { schema_version: 1, request_id: request?.request_id ?? null, request_type: request?.request_type ?? null, workflow_id: request?.workflow_id ?? null, status: 'REJECTED', input_sha256: inputSha256, error: { code: error.code ?? 'MANAGER_REQUEST_FAILED', message: error.message }, processed_at: new Date().toISOString() };
      atomicWriteJson(receiptPath, receipt);
      return receipt;
    }
  }

  async function scan() {
    if (scanning) return [];
    scanning = true;
    try {
      const results = [];
      const changedWorkflows = new Set();
      for (const name of readdirSync(requests).filter((item) => item.endsWith('.json')).sort()) {
        let workflowHint = null;
        try { workflowHint = JSON.parse(readFileSync(join(requests, name), 'utf8')).workflow_id ?? null; } catch { /* processFile records malformed input */ }
        if (workflowHint && changedWorkflows.has(workflowHint)) continue;
        const receipt = await processFile(name);
        results.push(receipt);
        if (receipt[PROCESSED_NOW] && receipt.status === 'ACCEPTED' && receipt.workflow_id) changedWorkflows.add(receipt.workflow_id);
      }
      for (const state of await runtime.list()) {
        if (!changedWorkflows.has(state.workflowId)) await advanceAndPublish(state.workflowId);
      }
      return results;
    } finally { scanning = false; }
  }
  return { root, requests, receipts, status, scan, processFile, managerView };
}
