import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createControlRepository, openControlDatabase } from '../control-core/repository.mjs';
import { createTaskRepository } from '../control-core/task-repository.mjs';
import { atomicWriteFile, atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { ingestJsonText, JsonIngestionError } from '../runtime-core/json-ingestion.mjs';
import { ingestStructuredOutputs } from '../runtime-core/structured-output-ingestion.mjs';
import { assertDispatchableAgent, loadActiveAgentRegistry, AgentRegistryError } from './agent-registry.mjs';
import { MAX_AGENT_TIMEOUT_SECONDS, terminateProcessTree, validateAgentTimeoutSeconds } from './agent-process.mjs';

export class OrchestratorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.details = details;
  }
}
const APPROVAL_TRIGGERS = new Set([
  'REQUIREMENT_AMBIGUITY', 'IMPLEMENTATION_TRADEOFF', 'PUBLIC_API_BREAKING_CHANGE',
  'IRREVERSIBLE_DATA_OP', 'NEEDS_INSTALL_OR_NETWORK', 'NEEDS_CREDENTIALS',
  'INPUT_NOT_GIT_REPO', 'INPUT_DIRTY_WORKTREE', 'CHANGE_APPROVED_REQ_OR_ARCH',
  'THIRDPARTY_LICENSE_UNCLEAR', 'SECURITY_RISK_ACCEPTANCE', 'TEST_OR_SECURITY_EXCEPTION',
  'RELEASE_HOLD_OVERRIDE', 'MAX_REWORK_EXCEEDED', 'DESTRUCTIVE_OR_CROSS_PROJECT',
]);

function nowIso(clock) { return clock().toISOString(); }

export function resolveExecutionPolicy(projectRoot, taskType, { timeoutSeconds = null, leaseSeconds = null } = {}) {
  const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'agent-execution-policy.json'), 'utf8'));
  const configured = { ...policy.defaults, ...(policy.task_types?.[taskType] ?? {}) };
  const timeout = timeoutSeconds == null ? Number(configured.timeout_seconds) : Number(timeoutSeconds);
  const requestedLease = leaseSeconds == null ? Number(configured.lease_seconds) : Number(leaseSeconds);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_AGENT_TIMEOUT_SECONDS
    || !Number.isInteger(requestedLease) || requestedLease <= 0 || requestedLease > MAX_AGENT_TIMEOUT_SECONDS) {
    throw new OrchestratorError('ORCHESTRATOR_EXECUTION_POLICY_INVALID', `invalid execution policy for ${taskType}`);
  }
  return { timeoutSeconds: timeout, leaseSeconds: Math.max(requestedLease, timeout) };
}

function outputPath(task, schemaName) {
  const output = task.structured_outputs.find((item) => item.required && item.format === 'json'
    && item.schema_path_abs.replaceAll('\\', '/').endsWith(`/contracts/${schemaName}`));
  if (!output) throw new OrchestratorError('ORCHESTRATOR_RESULT_OUTPUT_MISSING', `task has no required ${schemaName} output`);
  return output.path_abs;
}

const OUTPUT_SCHEMA_VALIDATORS = new Map();

function compileOutputSchema(schemaPath) {
  const modifiedAt = statSync(schemaPath).mtimeMs;
  const cached = OUTPUT_SCHEMA_VALIDATORS.get(schemaPath);
  if (cached?.modifiedAt === modifiedAt) return cached.validate;
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const AjvClass = String(schema.$schema ?? '').includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new AjvClass({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  OUTPUT_SCHEMA_VALIDATORS.set(schemaPath, { modifiedAt, validate });
  return validate;
}

function createIntent(task, { createdAt, dispatchId, sessionId, leaseSeconds = MAX_AGENT_TIMEOUT_SECONDS }) {
  const leaseDeadline = new Date(Date.parse(createdAt) + leaseSeconds * 1000).toISOString();
  return {
    schema_version: 1,
    record_type: 'DISPATCH_INTENT',
    dispatch_id: dispatchId,
    idempotency_key: `${task.workflow_id}/${task.task_id}/${task.run_id}/${task.assigned_agent}/${task.attempt}`,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.assigned_agent,
    attempt: task.attempt,
    task_file_abs: join(task.artifact_root_abs, '.orchestrator', 'task-control-record.json'),
    input_manifest_path_abs: task.context_manifest_path_abs,
    input_manifest_sha256: sha256File(task.context_manifest_path_abs),
    session_key: `agent:${task.assigned_agent}:orchestrator:${task.workflow_id}:${task.task_id}:${task.run_id}`,
    lease_started_at: createdAt,
    lease_deadline: leaseDeadline,
    retry_count: task.attempt - 1,
    max_retries: task.max_attempts - 1,
    created_at: createdAt,
    status: 'PREPARED',
    _session_id: sessionId,
  };
}

function receipt(intent, sessionId, status, recordedAt, id) {
  return {
    schema_version: 1, record_type: 'DISPATCH_RECEIPT', receipt_id: id,
    dispatch_id: intent.dispatch_id, idempotency_key: intent.idempotency_key,
    workflow_id: intent.workflow_id, task_id: intent.task_id, run_id: intent.run_id,
    agent_id: intent.agent_id, attempt: intent.attempt, status,
    session_key: intent.session_key, session_id: sessionId, lease_deadline: intent.lease_deadline,
    input_manifest_sha256: intent.input_manifest_sha256, recorded_at: recordedAt,
  };
}

function taskMessage(task, intent) {
  const outputInstructions = task.structured_outputs.map((output) => ({
    final_output_path_abs: output.path_abs,
    staged_raw_path_abs: join(task.artifact_root_abs, '.agent-raw', `${output.path_abs.slice(task.artifact_root_abs.length).replace(/^[\\/]/u, '')}.raw`),
    format: output.format,
    required: output.required,
  }));
  return `# Local Orchestrator Task\n\nThis message is generated by the local workflow Orchestrator. It is not a request to decide workflow state.\n\n`
    + `- dispatch_id: ${intent.dispatch_id}\n- workflow_id: ${task.workflow_id}\n- task_id: ${task.task_id}\n- run_id: ${task.run_id}\n- assigned_agent: ${task.assigned_agent}\n- attempt: ${task.attempt}\n`
    + `- context_manifest_path_abs: ${task.context_manifest_path_abs}\n- worktree_path_abs: ${task.worktree_path_abs}\n- artifact_root_abs: ${task.artifact_root_abs}\n\n`
    + `Read the immutable context manifest, work only within the task's declared write boundaries, and never invoke agent dispatch, monitor APIs, Control Kernel mutations, or state/retry tools. Tool results are bounded by the local OpenClaw context policy; use targeted queries and offset/limit continuation instead of requesting an entire large file.\n`
    + `Write every declared JSON/JSONL artifact only to its staged_raw_path_abs below. Do not write the final_output_path_abs; local code performs all JSON cleaning, schema validation, atomic publishing, status transitions and retries.\n\n`
    + '```json\n' + JSON.stringify({ structured_output_staging: outputInstructions }, null, 2) + '\n```\n';
}

function approvalOption(value, index) {
  const optionId = value?.option_id ?? value?.id ?? `PROCEED-${index + 1}`;
  return {
    option_id: String(optionId),
    description: String(value?.description ?? value?.summary ?? value?.label ?? '按 Agent 提议继续当前工作流'),
    impact: String(value?.impact ?? value?.consequence ?? '将允许依赖该决定的后续步骤继续执行'),
    reversibility: ['reversible', 'hard_to_reverse', 'irreversible', 'unknown'].includes(value?.reversibility)
      ? value.reversibility : 'unknown',
  };
}

function buildApprovalRequest(task, result, createdAt) {
  const decision = result.decisions_required?.[0] ?? {};
  const suppliedOptions = decision.options ?? decision.choices ?? decision.alternatives ?? [];
  const options = (Array.isArray(suppliedOptions) ? suppliedOptions : []).map(approvalOption);
  if (options.length === 0) options.push({
    option_id: 'PROCEED',
    description: '批准 Agent 提议并继续当前工作流',
    impact: '允许依赖该决定的任务继续执行；manager 仍会执行本地契约和 Gate 校验',
    reversibility: 'reversible',
  });
  const recommendedId = decision.recommended_option_id ?? decision.recommended_option?.option_id;
  return {
    schema_version: 1,
    decision_id: `DEC-${task.task_id}-${task.run_id}`,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    trigger: APPROVAL_TRIGGERS.has(decision.trigger) ? decision.trigger : 'IMPLEMENTATION_TRADEOFF',
    summary: String(decision.summary ?? decision.question ?? result.summary_for_user ?? 'Agent 请求人工决定后继续工作流'),
    options,
    recommended_option: recommendedId && options.some((option) => option.option_id === String(recommendedId))
      ? { option_id: String(recommendedId), rationale: String(decision.recommendation ?? decision.recommended_option?.rationale ?? 'Agent 提供的建议') }
      : null,
    evidence_refs: Array.isArray(decision.evidence_refs) ? decision.evidence_refs.map(String)
      : Array.isArray(result.evidence_refs) ? result.evidence_refs.map(String) : [],
    created_at: createdAt,
    status: 'PENDING',
  };
}

const AGENT_PROCESS = join(dirname(fileURLToPath(import.meta.url)), 'agent-process.mjs');

function launcherPaths(task, dispatchId) {
  const root = join(task.artifact_root_abs, '.orchestrator');
  return {
    launcher_path_abs: join(root, `${dispatchId}.launcher.json`),
    status_path_abs: join(root, `${dispatchId}.process-status.json`),
    result_path_abs: join(root, `${dispatchId}.process-result.json`),
    stdout_path_abs: join(root, `${dispatchId}.stdout.log`),
    stderr_path_abs: join(root, `${dispatchId}.stderr.log`),
  };
}

function prepareReadyDispatch({ projectRoot, database, taskId, leaseSeconds, clock, uuid }) {
  const tasks = createTaskRepository(projectRoot, database);
  const task = tasks.get(taskId);
  if (!task) throw new OrchestratorError('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
  if (task.status !== 'READY') throw new OrchestratorError('ORCHESTRATOR_TASK_NOT_READY', `task must be READY, received ${task.status}`);
  try { assertDispatchableAgent(loadActiveAgentRegistry(projectRoot), task); }
  catch (error) {
    if (error instanceof AgentRegistryError) throw new OrchestratorError(error.code, error.message);
    throw error;
  }
  const preparedAt = nowIso(clock);
  const dispatchId = `DSP-${uuid()}`;
  const sessionId = uuid();
  const intentWithInternalSession = createIntent(task, { createdAt: preparedAt, dispatchId, sessionId, leaseSeconds });
  const { _session_id: ignored, ...intent } = intentWithInternalSession;
  mkdirSync(join(task.artifact_root_abs, '.orchestrator'), { recursive: true });
  atomicWriteJson(intent.task_file_abs, task);
  const messagePath = join(task.artifact_root_abs, '.orchestrator', `${dispatchId}.message.md`);
  atomicWriteFile(messagePath, taskMessage(task, intent));
  const launcher = launcherPaths(task, dispatchId);
  // Persist the recovery locator before the Control Kernel transaction. If
  // this process is terminated between prepare and runner spawn, reconcile
  // can still distinguish a new durable dispatch from a legacy one.
  atomicWriteJson(launcher.launcher_path_abs, {
    schema_version: 1,
    dispatch_id: intent.dispatch_id,
    workflow_id: intent.workflow_id,
    task_id: intent.task_id,
    run_id: intent.run_id,
    agent_id: intent.agent_id,
    session_id: sessionId,
    message_path_abs: messagePath,
    ...launcher,
    created_at: intent.created_at,
  });
  const prepared = tasks.prepareDispatch(intent);
  return { tasks, task, intent, sessionId, prepared, messagePath, launcher };
}

export function startOpenClawAgent({ agentId, sessionId, messagePath, timeoutSeconds = MAX_AGENT_TIMEOUT_SECONDS, launcher } = {}) {
  timeoutSeconds = validateAgentTimeoutSeconds(timeoutSeconds);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [AGENT_PROCESS,
      '--agent-id', agentId,
      '--session-id', sessionId,
      '--message-path', messagePath,
      '--timeout-seconds', String(timeoutSeconds),
      '--stdout-path', launcher.stdout_path_abs,
      '--stderr-path', launcher.stderr_path_abs,
      '--status-path', launcher.status_path_abs,
      '--result-path', launcher.result_path_abs,
    ], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', (error) => rejectRun(Object.assign(error, { started: false })));
    child.once('spawn', () => {
      const pid = child.pid;
      child.unref();
      resolveRun({ started: true, launcher_pid: pid });
    });
  });
}

function recordRunningReceipts(tasks, intent, sessionId, clock, uuid, startedAt = null) {
  let dispatch = tasks.getDispatch(intent.dispatch_id);
  if (!dispatch) throw new OrchestratorError('DISPATCH_NOT_FOUND', `dispatch does not exist: ${intent.dispatch_id}`);
  if (dispatch.status === 'PREPARED') {
    tasks.recordReceipt(receipt(intent, sessionId, 'SENT', intent.created_at, `DRC-${uuid()}`));
    dispatch = tasks.getDispatch(intent.dispatch_id);
  }
  if (dispatch.status === 'SENT') {
    tasks.recordReceipt(receipt(intent, sessionId, 'ACKNOWLEDGED', startedAt ?? nowIso(clock), `DRC-${uuid()}`));
    dispatch = tasks.getDispatch(intent.dispatch_id);
  }
  if (dispatch.status === 'ACKNOWLEDGED') {
    tasks.recordReceipt(receipt(intent, sessionId, 'RUNNING', startedAt ?? nowIso(clock), `DRC-${uuid()}`));
  }
}

export async function startReadyTask({ projectRoot: projectRootInput, databasePath, taskId, timeoutSeconds = null,
  leaseSeconds = null, clock = () => new Date(), uuid = randomUUID, runner = startOpenClawAgent } = {}) {
  const projectRoot = resolve(projectRootInput);
  const database = openControlDatabase(databasePath);
  try {
    const taskForPolicy = createTaskRepository(projectRoot, database).get(taskId);
    if (!taskForPolicy) throw new OrchestratorError('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
    const execution = resolveExecutionPolicy(projectRoot, taskForPolicy.task_type, { timeoutSeconds, leaseSeconds });
    const prepared = prepareReadyDispatch({ projectRoot, database, taskId, leaseSeconds: execution.leaseSeconds, clock, uuid });
    const { tasks, task, intent, sessionId, messagePath, launcher } = prepared;
    try {
      // Launch the detached runner before recording SENT. If this process is
      // terminated in the gap, the durable PREPARED dispatch plus launcher
      // result still gives reconcile a safe recovery point; no duplicate
      // worker dispatch is needed.
      const launched = await runner({ agentId: task.assigned_agent, sessionId, messagePath,
        timeoutSeconds: execution.timeoutSeconds, launcher });
      atomicWriteJson(launcher.launcher_path_abs, {
        ...JSON.parse(readFileSync(launcher.launcher_path_abs, 'utf8')),
        launcher_pid: launched.launcher_pid ?? null,
        timeout_seconds: execution.timeoutSeconds,
        lease_seconds: execution.leaseSeconds,
      });
      tasks.recordReceipt(receipt(intent, sessionId, 'SENT', nowIso(clock), `DRC-${uuid()}`));
      return {
        ok: true,
        command: 'orchestrator-dispatch-start',
        status: 'STARTED',
        prepared: prepared.prepared,
        task: tasks.get(task.task_id),
        dispatch_id: intent.dispatch_id,
        session_id: sessionId,
        launcher: { ...launcher, launcher_pid: launched.launcher_pid ?? null },
      };
    } catch (error) {
      const code = error.code ?? 'ORCHESTRATOR_PROCESS_START_FAILED';
      const failed = tasks.failDispatch({ dispatch_id: intent.dispatch_id, error_code: code,
        error_message: error.message, completed_at: nowIso(clock), session_id: sessionId });
      return { ok: false, command: 'orchestrator-dispatch-start', dispatch_id: intent.dispatch_id,
        task: failed.task, error: { code, message: error.message } };
    }
  } finally {
    database.close();
  }
}

function processFailureCode(processResult) {
  if (processResult.timed_out) return 'ORCHESTRATOR_AGENT_TIMEOUT';
  if (processResult.error_code) return processResult.error_code;
  if (processResult.signal) return 'ORCHESTRATOR_AGENT_SIGNAL';
  if (processResult.exit_code !== 0) return 'ORCHESTRATOR_AGENT_EXIT_NONZERO';
  return null;
}

export function reconcileDispatch({ projectRoot: projectRootInput, databasePath, dispatchId, clock = () => new Date(), uuid = randomUUID } = {}) {
  const projectRoot = resolve(projectRootInput);
  const database = openControlDatabase(databasePath);
  let tasks = null;
  let dispatch = null;
  try {
    tasks = createTaskRepository(projectRoot, database);
    dispatch = tasks.getDispatch(dispatchId);
    if (!dispatch) throw new OrchestratorError('DISPATCH_NOT_FOUND', `dispatch does not exist: ${dispatchId}`);
    if (['SUCCEEDED', 'FAILED', 'LOST'].includes(dispatch.status)) {
      return { ok: true, command: 'orchestrator-dispatch-reconcile', status: 'TERMINAL', dispatch };
    }
    const runSnapshot = tasks.getRun(dispatch.intent.run_id);
    const task = runSnapshot?.task ?? null;
    if (!task) throw new OrchestratorError('TASK_RUN_NOT_FOUND', `task run does not exist: ${dispatch.intent.run_id}`);
    const launcherPath = join(task.artifact_root_abs, '.orchestrator', `${dispatchId}.launcher.json`);
    if (!existsSync(launcherPath)) {
      // Older dispatches may have been created by the synchronous runner
      // before launcher metadata existed. Do not mark such a dispatch FAILED
      // and do not infer completion from a chat/session transcript: return a
      // durable, auditable handoff instead.
      return {
        ok: true,
        command: 'orchestrator-dispatch-reconcile',
        status: 'RECOVERY_REQUIRED',
        dispatch_id: dispatchId,
        task,
        dispatch,
        recovery: {
          code: 'ORCHESTRATOR_LAUNCHER_METADATA_MISSING',
          message: `No durable launcher evidence exists for dispatch ${dispatchId}`,
          artifact_root_abs: task.artifact_root_abs,
          session_id: dispatch.session_id,
          action: 'VERIFY_EXTERNAL_SESSION_AND_RECREATE_A_CONTROLLED_RUN',
        },
      };
    }
    const launcher = JSON.parse(readFileSync(launcherPath, 'utf8'));
    if (!existsSync(launcher.result_path_abs)) {
      const status = existsSync(launcher.status_path_abs) ? JSON.parse(readFileSync(launcher.status_path_abs, 'utf8')) : null;
      return { ok: true, command: 'orchestrator-dispatch-reconcile', status: 'WAITING', dispatch, launcher_status: status };
    }
    const processResult = JSON.parse(readFileSync(launcher.result_path_abs, 'utf8'));
    const failureCode = processFailureCode(processResult);
    if (failureCode) {
      const failed = tasks.failDispatch({ dispatch_id: dispatchId, error_code: failureCode,
        error_message: processResult.error_message ?? `OpenClaw process exited with ${processResult.exit_code ?? processResult.signal ?? 'unknown'}`,
        completed_at: processResult.finished_at ?? nowIso(clock), session_id: dispatch.session_id });
      return { ok: false, command: 'orchestrator-dispatch-reconcile', status: 'FAILED', dispatch_id: dispatchId,
        task: failed.task, error: { code: failureCode, message: failed.completion.error_message } };
    }
    recordRunningReceipts(tasks, dispatch.intent, dispatch.session_id, clock, uuid, processResult.started_at ?? null);
    const processOutput = { stdout: readFileSync(launcher.stdout_path_abs, 'utf8'), stderr: readFileSync(launcher.stderr_path_abs, 'utf8') };
    assertGatewayResponse(processOutput.stdout);
    const accepted = ingestStructuredOutputs(task, { validateSchema: compileOutputSchema, occurredAt: nowIso(clock) });
    const resultPath = outputPath(task, 'result.schema.json');
    const completion = {
      schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: `CMP-${uuid()}`,
      dispatch_id: dispatch.intent.dispatch_id, idempotency_key: dispatch.intent.idempotency_key,
      workflow_id: dispatch.intent.workflow_id, task_id: dispatch.intent.task_id, run_id: dispatch.intent.run_id,
      agent_id: dispatch.intent.agent_id, attempt: dispatch.intent.attempt, status: 'SUCCEEDED', session_key: dispatch.intent.session_key,
      session_id: dispatch.session_id, result_path_abs: resultPath, result_sha256: sha256File(resultPath),
      error_code: null, error_message: null, completed_at: processResult.finished_at ?? nowIso(clock),
    };
    const ingested = tasks.ingestCompletion(completion);
    let approval = null;
    if (ingested.result?.result_status === 'HUMAN_DECISION_REQUIRED') {
      const controls = createControlRepository(projectRoot, database);
      const request = buildApprovalRequest(task, ingested.result, completion.completed_at);
      approval = controls.requestApproval(request, { actor: 'local-orchestrator', occurred_at: completion.completed_at,
        reason: `Agent ${task.assigned_agent} 请求人工审批: ${request.trigger}` });
    }
    return { ok: true, command: 'orchestrator-dispatch-reconcile', status: 'SUCCEEDED', dispatch_id: dispatchId,
      task: ingested.task, dispatch: tasks.getDispatch(dispatchId), completion: ingested.completion, result: ingested.result,
      gateway: { raw_sha256: assertGatewayResponse(processOutput.stdout).raw_sha256 },
      requires_human_approval: Boolean(approval), approval_request: approval?.state ? approval.event.payload.approval_request : null,
      accepted_outputs: accepted.map((item) => ({ path_abs: item.output.path_abs, receipt_path_abs: item.receipt_path_abs })), };
  } catch (error) {
    const code = error.code ?? 'ORCHESTRATOR_RECONCILE_FAILED';
    let failed = null;
    if (tasks && dispatch && !['SUCCEEDED', 'FAILED', 'LOST'].includes(dispatch.status)) {
      try {
        failed = tasks.failDispatch({ dispatch_id: dispatchId, error_code: code, error_message: error.message,
          completed_at: nowIso(clock), session_id: dispatch.session_id });
      } catch (failureError) {
        return { ok: false, command: 'orchestrator-dispatch-reconcile', status: 'FAILED',
          error: { code: 'ORCHESTRATOR_RECONCILE_FAILURE_PERSIST_FAILED', message: failureError.message },
          original_error: { code, message: error.message } };
      }
    }
    return { ok: false, command: 'orchestrator-dispatch-reconcile', status: 'FAILED', dispatch_id: dispatchId,
      task: failed?.task ?? null, error: { code, message: error.message } };
  } finally {
    database.close();
  }
}

export function reconcileTaskDispatch({ projectRoot: projectRootInput, databasePath, taskId, clock = () => new Date(), uuid = randomUUID } = {}) {
  const projectRoot = resolve(projectRootInput);
  const database = openControlDatabase(databasePath);
  let dispatchId = null;
  try {
    const tasks = createTaskRepository(projectRoot, database);
    const dispatch = tasks.unresolvedDispatch(taskId);
    if (!dispatch) return { ok: true, command: 'orchestrator-dispatch-reconcile', status: 'IDLE', task_id: taskId };
    dispatchId = dispatch.dispatch_id;
  } finally {
    database.close();
  }
  return reconcileDispatch({ projectRoot, databasePath, dispatchId, clock, uuid });
}

export function terminateWorkflowLaunchers({ projectRoot: projectRootInput, databasePath, workflowId } = {}) {
  const projectRoot = resolve(projectRootInput);
  const database = openControlDatabase(databasePath);
  try {
    const tasks = createTaskRepository(projectRoot, database);
    const rows = database.prepare("SELECT dispatch_id, run_id, completion_json FROM dispatches WHERE workflow_id=? AND status='LOST'")
      .all(workflowId).filter((row) => JSON.parse(row.completion_json ?? 'null')?.error_code === 'WORKFLOW_CANCELLED');
    return rows.map((row) => {
      const task = tasks.getRun(row.run_id)?.task;
      if (!task) return { dispatch_id: row.dispatch_id, terminated: false, reason: 'TASK_RUN_NOT_FOUND' };
      const launcherPath = join(task.artifact_root_abs, '.orchestrator', `${row.dispatch_id}.launcher.json`);
      if (!existsSync(launcherPath)) return { dispatch_id: row.dispatch_id, terminated: false, reason: 'LAUNCHER_NOT_FOUND' };
      const launcher = JSON.parse(readFileSync(launcherPath, 'utf8'));
      const status = existsSync(launcher.status_path_abs) ? JSON.parse(readFileSync(launcher.status_path_abs, 'utf8')) : null;
      const pid = status?.pid ?? launcher.launcher_pid ?? null;
      const result = terminateProcessTree(pid);
      return { dispatch_id: row.dispatch_id, pid, terminated: result.ok, ...result };
    });
  } finally { database.close(); }
}

function assertGatewayResponse(stdout) {
  try {
    const ingestion = ingestJsonText(stdout);
    const value = ingestion.value;
    const supported = value && typeof value === 'object' && !Array.isArray(value)
      && value.ok !== false
      && (value.ok === true || typeof value.reply === 'string' || typeof value.response === 'string'
        || typeof value.text === 'string' || value.status === 'ok' || value.status === 'success' || value.result !== undefined);
    if (!supported) throw new OrchestratorError('ORCHESTRATOR_GATEWAY_RESPONSE_UNSUPPORTED', 'Gateway returned an unsupported success response shape');
    return { ...ingestion, value };
  } catch (error) {
    if (error instanceof OrchestratorError) throw error;
    if (error instanceof JsonIngestionError) {
      throw new OrchestratorError('ORCHESTRATOR_GATEWAY_RESPONSE_UNSUPPORTED', `Gateway response is not one safe JSON value: ${error.diagnostic}`);
    }
    throw error;
  }
}
