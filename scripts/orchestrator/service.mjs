import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFile, atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { createKernel } from '../control-kernel/kernel.mjs';
import { openKernelDatabase, resolveKernelConfig } from '../control-kernel/database.mjs';
import { createWorkflowRepository } from '../control-kernel/workflow-repository.mjs';
import { assertOrchestratorWorker, loadActiveAgentRegistry } from './agent-registry.mjs';
import { createContextManifest, inputRootForAttempt } from './context-manifest.mjs';
import { createGitWorktreeManager } from './git-worktree.mjs';
import { createTaskWorkspaceManager } from './task-workspace.mjs';
import { createManagerControl } from '../manager-control/service.mjs';
import { createSnapshotService } from './snapshot-service.mjs';
import { createApprovalCommandQueue } from './approval-command-queue.mjs';
import { createWorkflowControlCommandQueue } from './workflow-control-command-queue.mjs';
import { ingestTaskOutput, writeFailureReceipt } from './output-ingestion.mjs';
import { archiveJsonRegeneration, archiveOutputBoundaryFailure, isJsonRegenerable, isOutputBoundaryFailure, MAX_JSON_REGENERATIONS } from './json-regeneration.mjs';
import { extractFinalAssistantText, extractFinalAssistantVisibleText, runOpenClawAgent } from './openclaw-runner.mjs';
import { compileRoutePlan, GATE_CHECKS_BY_KIND } from './route-policy.mjs';
import { createTestSandboxStager } from './test-sandbox-staging.mjs';
import { shouldNotifyManager } from './notification-policy.mjs';

function now(clock) { const value = clock(); return value instanceof Date ? value.toISOString() : value; }
function taskSession(task) { return `orc-${task.runId.toLowerCase()}-${task.taskId.toLowerCase()}-a${task.attempt}`.slice(0, 120); }
function processLog(task, name, content) { const path = join(task.artifactRootAbs, 'logs', name); mkdirSync(join(task.artifactRootAbs, 'logs'), { recursive: true }); atomicWriteFile(path, String(content ?? '')); return path; }
function inside(root, path) { const value = relative(resolve(root), resolve(path)); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)); }
function boundedText(value, limit = 8192) { return typeof value === 'string' ? value.slice(0, limit) : null; }
function preparationErrorValue(error) {
  const details = error?.details ?? {};
  return {
    name: boundedText(error?.name, 256), code: boundedText(error?.code, 256) ?? 'TEST_SANDBOX_PREPARE_FAILED',
    message: boundedText(error?.message),
    syscall: boundedText(error?.syscall, 256) ?? boundedText(details.syscall, 256),
    path: boundedText(error?.path) ?? boundedText(details.path), dest: boundedText(error?.dest) ?? boundedText(details.dest),
    stack: boundedText(error?.cause?.stack) ?? boundedText(error?.stack),
  };
}
export function writeTestSandboxPreparationDiagnostic(task, error, occurredAt) {
  const pathAbs = join(task.artifactRootAbs, '.orchestrator', 'test-sandbox-preparation', `attempt-${task.attempt}.diagnostic.json`);
  const details = error?.details ?? {};
  const value = {
    schema_version: 1, kind: 'test-sandbox-preparation-diagnostic', authority: 'orchestrator-host', occurred_at: occurredAt,
    workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId, attempt: task.attempt,
    preparation_phase: boundedText(details.preparation_phase, 128) ?? 'UNKNOWN',
    workspace_root_abs: boundedText(details.workspace_root_abs), staging_root_abs: boundedText(details.staging_root_abs),
    error: preparationErrorValue(error), cleanup_error: details.cleanup_error ?? null,
  };
  atomicWriteJson(pathAbs, value);
  return { path_abs: pathAbs, sha256: sha256File(pathAbs), value };
}
export function tryWriteTestSandboxPreparationDiagnostic(task, error, occurredAt, { writeDiagnostic = writeTestSandboxPreparationDiagnostic } = {}) {
  try { return { diagnostic: writeDiagnostic(task, error, occurredAt), write_error: null }; }
  catch (writeError) {
    return {
      diagnostic: null,
      write_error: {
        code: boundedText(writeError?.code, 256) ?? 'TEST_SANDBOX_DIAGNOSTIC_WRITE_FAILED',
        syscall: boundedText(writeError?.syscall, 256), path: boundedText(writeError?.path),
      },
    };
  }
}
function publishedResult(task) {
  if (!task) return null;
  const payload = task.payload ?? {};
  const result = payload.result ?? {};
  const snapshot = payload.snapshot ?? {};
  return {
    task_id: task.taskId,
    worktree_path_abs: payload.worktree_path_abs ?? snapshot.worktreePathAbs ?? result.worktree_path_abs ?? null,
    artifact_root_abs: payload.artifact_root_abs ?? result.artifact_root_abs ?? null,
    published_output_path_abs: payload.published_output_path_abs ?? null,
    output_commit: snapshot.outputCommit ?? result.output_commit ?? null,
  };
}
function notificationMessage(notification, run) {
  return `# Orchestrator update\n\nA workflow event must be explained to the user in the current native Manager conversation. Do not make a workflow decision on the user's behalf.\n\n${JSON.stringify({ workflow_id: run.workflowId, notification_type: notification.type, task_id: notification.taskId, payload: notification.payload }, null, 2)}\n`;
}
function approvalRequest(task, result = null, step = null) {
  if (step?.kind === 'RELEASE' && step.release_phase === 'PREFLIGHT') {
    const deployment = result?.deployment;
    if (!deployment) throw Object.assign(new Error('release preflight result is missing deployment binding'), { code: 'RELEASE_DEPLOYMENT_BINDING_MISSING' });
    return {
      decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
      workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
      summary: `确认将候选提交 ${deployment.candidate_commit} 部署到 ${deployment.final_url}。`, trigger: 'RELEASE_DEPLOYMENT', deployment,
      options: [
        { option_id: 'APPROVE_DEPLOY', description: '确认部署这个候选提交到这个 URL' },
        { option_id: 'REWORK', description: '要求补充或修正部署前检查' },
        { option_id: 'CANCEL', description: '取消本次部署' },
      ],
    };
  }
  const requested = result?.decisions_required?.[0] ?? {};
  const sourceOptions = Array.isArray(requested.options) && requested.options.length ? requested.options : [{ option_id: 'APPROVE', description: 'Approve and continue' }, { option_id: 'REWORK', description: 'Request another attempt' }, { option_id: 'CANCEL', description: 'Cancel this workflow' }];
  const options = sourceOptions.map((option) => ({ ...option, option_id: option.option_id ?? option.id })).filter((option) => option.option_id);
  return {
    decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
    workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    summary: requested.summary ?? step?.approval_reason ?? result?.summary_for_user ?? 'Human approval is required before this route can continue.',
    trigger: requested.trigger ?? (step ? 'ROUTE_STEP_APPROVAL' : 'AGENT_DECISION_REQUIRED'), options,
  };
}

export function taskMessage(task) {
  const staging = task.testSandbox ?? null;
  const sandboxRequired = task.kind === 'TEST' && task.testSandboxEnabled !== false;
  if (sandboxRequired && (!staging?.containerWorktreeAbs || !staging?.containerContextManifestPathAbs || !staging?.containerRawOutputPath)) {
    throw Object.assign(new Error('TEST task dispatch requires prepared container staging paths'), {
      code: 'TEST_SANDBOX_STAGING_REQUIRED',
      details: { task_id: task.taskId, attempt: task.attempt },
    });
  }
  const executionWorktree = staging?.containerWorktreeAbs ?? staging?.executionWorktreeAbs ?? task.worktreePathAbs;
  const executionManifest = staging?.containerContextManifestPathAbs ?? staging?.executionContextManifestPathAbs ?? task.contextManifestPathAbs;
  const executionOutput = staging?.containerRawOutputPath ?? staging?.executionRawOutputPath ?? task.rawOutputPath;
  const executionFields = staging
    ? `- execution_worktree_path_abs: ${executionWorktree}\n- execution_context_manifest_path_abs: ${executionManifest}\n`
    : `- worktree_path_abs: ${executionWorktree}\n- context_manifest_path_abs: ${executionManifest}\n`;
  const isolationRequirement = task.kind === 'TEST' && !sandboxRequired
    ? ' This is an unsandboxed local TEST task. The result must contain exactly `"isolation_mode": "UNSANDBOXED_LOCAL"` and `"sandbox_attestation": null`; `sandbox_attestation` must not be omitted or replaced with an object.'
    : '';
  if (staging) return [
    '# Orchestrator task', '',
    '- workflow_id: ' + task.workflowId, '- task_id: ' + task.taskId, '- run_id: ' + task.runId,
    '- step_id: ' + task.stepId, '- assigned_agent: ' + task.agentId, '- attempt: ' + task.attempt,
    executionFields.trimEnd(), '- context_manifest_sha256: ' + task.contextManifestSha256, '',
    'Complete only this assigned step. Read the immutable context manifest. Do not communicate with other Agents, alter route or approval records, write to the Control Kernel, or call Monitor controls. Use only execution_* paths for file and command access; copy result_identity values from the execution manifest verbatim into the result object. After completing file operations, return exactly one complete result.schema.json object as your final reply. Do not write result files yourself; the Orchestrator will atomically stage and publish that reply.',
  ].join('\n') + '\n';
  return `# Orchestrator task\n\n- workflow_id: ${task.workflowId}\n- task_id: ${task.taskId}\n- run_id: ${task.runId}\n- step_id: ${task.stepId}\n- assigned_agent: ${task.agentId}\n- attempt: ${task.attempt}\n${executionFields}- context_manifest_sha256: ${task.contextManifestSha256}\n\nComplete only this assigned step. Read the immutable context manifest. Do not communicate with other Agents, alter route or approval records, write to the Control Kernel, or call Monitor controls. ${staging ? 'Use only execution_* paths for file and command access; copy result_identity values from the execution manifest verbatim into the result object.' : ''}${isolationRequirement} Write exactly one result.schema.json object only to:\n\n${executionOutput}\n\nAfter completing file operations, return exactly one complete result.schema.json object as your final reply. The Orchestrator will atomically stage that reply and publish it; do not write result files yourself.\n`;
}

function stagingPreparationBlockedResult(task, error, occurredAt, diagnostic = null) {
  return {
    schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId,
    role: 'orchestrator', attempt: task.attempt, started_at: occurredAt, finished_at: occurredAt,
    result_status: 'BLOCKED', summary_for_user: 'The isolated TEST workspace could not be prepared.',
    summary_for_manager: `TEST sandbox preparation failed during ${error.details?.preparation_phase ?? 'UNKNOWN'}: ${error.code ?? 'TEST_SANDBOX_PREPARE_FAILED'}.`,
    worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs,
    input_commit: task.inputCommit, output_commit: task.inputCommit, isolation_mode: 'UNSANDBOXED_LOCAL',
    self_validation: { preflight_passed: false, checks: [{ name: 'test_sandbox_preparation', status: 'FAIL', detail: error.code ?? 'TEST_SANDBOX_PREPARE_FAILED' }] },
    artifact_manifest_hash: task.contextManifestSha256,
    test_sandbox_preparation_diagnostic: diagnostic ? { path_abs: diagnostic.path_abs, sha256: diagnostic.sha256, preparation_phase: diagnostic.value.preparation_phase } : null,
    known_limitations: ['The TEST Agent was not dispatched because staging failed.'],
  };
}

function retryExhaustedApprovalRequest(task) {
  return {
    decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
    workflow_id: task.workflowId,
    task_id: task.taskId,
    run_id: task.runId,
    task_attempt: task.attempt,
    max_attempts: task.maxAttempts,
    summary: `任务 ${task.taskId} 已用完 ${task.maxAttempts} 次完整执行机会，需要用户决定是否开启新的重试批次。`,
    trigger: 'TASK_RETRY_EXHAUSTED',
    options: [
      { option_id: 'RETRY_SAME_AGENT', description: '确认：由同一 Agent 开启新的三次重试批次' },
      { option_id: 'ABORT', description: '拒绝：终止当前工作流' },
      { option_id: 'REWORK', description: '其他：携带用户补充说明后返工并开启新的重试批次' },
    ],
  };
}

function upstreamImplementationApprovalRequest(run, task, upstreamTask) {
  return {
    decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
    workflow_id: run.workflowId, task_id: task.taskId, run_id: run.runId,
    summary: `测试任务 ${task.taskId} 没有可验证的 DEVELOPMENT 交付物，需要先返工实现阶段。`,
    trigger: 'UPSTREAM_IMPLEMENTATION_MISSING', upstream_task_id: upstreamTask?.taskId ?? null,
    options: [
      { option_id: 'REWORK', description: '返工：重新执行上游 DEVELOPMENT 任务，再继续测试' },
      { option_id: 'ABORT', description: '终止当前工作流，保留已记录的诊断信息' },
    ],
  };
}

function completedDevelopmentTask(task) {
  const result = task?.payload?.result ?? {};
  const outputCommit = task?.payload?.snapshot?.outputCommit ?? result.output_commit;
  return task?.kind === 'DEVELOPMENT' && task.state === 'SUCCEEDED' && result.result_status === 'COMPLETED'
    && /^[a-f0-9]{40}$/iu.test(outputCommit ?? '');
}

function taskPreparationApprovalRequest(run, task, error) {
  return {
    decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
    workflow_id: run.workflowId,
    task_id: task.taskId,
    run_id: run.runId,
    summary: `任务 ${task.taskId} 无法准备隔离工作区（${error.code ?? 'TASK_PREPARATION_FAILED'}），需要用户决定重试或终止。`,
    trigger: 'TASK_PREPARATION_FAILED',
    error: { code: error.code ?? 'TASK_PREPARATION_FAILED', message: error.message },
    options: [
      { option_id: 'RETRY_SAME_AGENT', description: '恢复目标项目后，使用同一 Agent 重新准备并执行该任务' },
      { option_id: 'ABORT', description: '终止当前工作流，保留已记录的诊断信息' },
    ],
  };
}

export async function runWithLeaseHeartbeat({ lease, executionId, run, signal = null, intervalMs = null }) {
  if (!lease?.heartbeat || typeof run !== 'function') throw new TypeError('lease heartbeat and run callback are required');
  const heartbeatIntervalMs = intervalMs ?? Math.max(10, Math.floor(Number(lease.scheduleSeconds ?? 120) * 1000 / 3));
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort(); else signal?.addEventListener('abort', relayAbort, { once: true });
  let stopped = false; let timer = null; let reportLeaseFailure;
  const leaseFailure = new Promise((resolveFailure) => { reportLeaseFailure = resolveFailure; });
  const lost = (cause = null) => Object.assign(new Error(`execution lease was lost: ${executionId}`), {
    code: 'EXECUTION_LEASE_LOST', details: { execution_id: executionId, cause: cause ? { code: cause.code ?? null, message: cause.message } : null },
  });
  const schedule = () => { if (!stopped) timer = setTimeout(renew, heartbeatIntervalMs); };
  const renew = async () => {
    if (stopped) return;
    try {
      const held = await lease.heartbeat({ executionId, phase: 'AGENT_RUNNING' });
      if (!held) throw lost();
      schedule();
    } catch (error) {
      stopped = true; controller.abort(); reportLeaseFailure(error.code === 'EXECUTION_LEASE_LOST' ? error : lost(error));
    }
  };
  schedule();
  const runnerPromise = Promise.resolve().then(() => run(controller.signal));
  try {
    const outcome = await Promise.race([
      runnerPromise.then((value) => ({ type: 'runner', value }), (error) => ({ type: 'runner-error', error })),
      leaseFailure.then((error) => ({ type: 'lease-error', error })),
    ]);
    if (outcome.type === 'lease-error') { try { await runnerPromise; } catch { /* lease error is authoritative */ } throw outcome.error; }
    if (outcome.type === 'runner-error') throw outcome.error;
    stopped = true; if (timer) clearTimeout(timer);
    const held = await lease.heartbeat({ executionId, phase: 'RESULT_VALIDATION' });
    if (!held) throw lost();
    return outcome.value;
  } finally {
    stopped = true; if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

export function openClawAgentExitError(result) {
  return Object.assign(new Error(`OpenClaw Agent exited with ${result.exitCode}`), {
    code: result.failureCode ?? 'OPENCLAW_AGENT_EXIT_NONZERO',
    details: { signal: result.signal ?? null, stderr: String(result.stderr ?? '').slice(-4000) },
  });
}

export function createOrchestrator({ projectRoot: projectRootInput, database = null, kernel = null, repository = null, worktrees = null, snapshots = null,
  runtimeRoot: runtimeRootInput = null, projectControl = null, runner = runOpenClawAgent, notificationRunner = runOpenClawAgent, testSandboxStager = null, testSandboxEnabled: testSandboxEnabledInput = null, hr = null, clock = () => new Date(), maxAttempts = 3, timeoutSeconds = 900, signal = null } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const runtimeRoot = resolve(runtimeRootInput ?? process.env.OPENCLAW_RUNTIME_ROOT ?? join(projectRoot, 'runtime'));
  const ownedDatabase = !database && !kernel && !repository;
  const config = resolveKernelConfig({ projectRoot, runtimeRoot });
  const testSandboxEnabled = testSandboxEnabledInput ?? config.testSandboxEnabled;
  const selectedDatabase = database ?? kernel?.database ?? (repository ? null : openKernelDatabase(config));
  const selectedKernel = kernel ?? createKernel({ database: selectedDatabase, workerId: config.workerId, leaseSeconds: config.leaseSeconds, clock });
  const selectedRepository = repository ?? createWorkflowRepository({ database: selectedDatabase, clock });
  const selectedWorktrees = worktrees ?? createGitWorktreeManager({ projectRoot });
  const taskWorkspaces = createTaskWorkspaceManager({ projectRoot });
  const selectedProjectControl = projectControl ?? createManagerControl({ projectRoot, runtimeRoot, clock });
  const selectedSnapshots = snapshots ?? createSnapshotService({ repository: selectedRepository, worktrees: selectedWorktrees });
  const selectedTestSandboxStager = testSandboxStager ?? createTestSandboxStager({ workspaceRoot: join(runtimeRoot, 'agents', 'test-agent', 'workspace') });
  const registry = loadActiveAgentRegistry(projectRoot);
  const approvalCommands = createApprovalCommandQueue({ projectRoot, runtimeRoot, resolve: resolveApprovalCommand });
  const workflowControlCommands = createWorkflowControlCommandQueue({ projectRoot, runtimeRoot, resolve: resolveWorkflowControlCommand });
  let hrService = hr;

  async function announce(run, type, payload, taskId = null) {
    const notification = await selectedRepository.queueNotification({ runId: run.runId, taskId, type, payload });
    await deliverNotifications({ notificationIds: [notification.notificationId] });
    return notification;
  }

  async function queueDailyReport(run, task, outcome) {
    if (!hrService?.queueTaskDailyReport) return null;
    try { return await hrService.queueTaskDailyReport({ run, task, outcome }); }
    catch (error) {
      await announce(run, 'HR_DAILY_REPORT_QUEUE_FAILED', { task_id: task.taskId, error: { code: error.code ?? 'HR_QUEUE_FAILED', message: error.message } }, task.taskId);
      return null;
    }
  }

  async function deliverNotifications({ notificationIds = null, limit = 100 } = {}) {
    const pending = await selectedRepository.listNotifications({ limit });
    const selected = notificationIds ? pending.filter((item) => notificationIds.includes(item.notificationId)) : pending;
    const delivered = [];
    for (const notification of selected) {
      if (!shouldNotifyManager(notification.type)) {
        // Keep the event in the control plane for audit/history, but do not
        // wake the Manager for internal lifecycle and self-healing events.
        delivered.push(await selectedRepository.updateNotification(notification.notificationId, { status: 'DELIVERED', incrementAttempts: true }));
        continue;
      }
      const run = await selectedRepository.getRunById(notification.runId);
      if (!run?.managerSessionId || !run.managerSessionKey) {
        delivered.push(await selectedRepository.updateNotification(notification.notificationId, { status: 'FAILED', incrementAttempts: true, lastError: { code: 'MANAGER_SESSION_MISSING', message: 'originating Manager session metadata is missing' } }));
        continue;
      }
      const root = join(projectRoot, 'runtime', 'orchestrator', 'notifications', notification.notificationId);
      mkdirSync(root, { recursive: true });
      const messagePath = join(root, 'manager-message.md'); atomicWriteFile(messagePath, notificationMessage(notification, run));
      try {
        const result = await notificationRunner({ agentId: 'manager-agent', sessionId: run.managerSessionId, messagePath, timeoutSeconds, deliver: run.managerDelivery, signal });
        if (result.exitCode !== 0) throw Object.assign(new Error(`Manager delivery returned ${result.exitCode}`), { code: 'MANAGER_DELIVERY_EXIT_NONZERO', details: { stderr: String(result.stderr ?? '').slice(-4000) } });
        delivered.push(await selectedRepository.updateNotification(notification.notificationId, { status: 'DELIVERED', incrementAttempts: true }));
      } catch (error) {
        delivered.push(await selectedRepository.updateNotification(notification.notificationId, { status: 'FAILED', incrementAttempts: true, lastError: { code: error.code ?? 'MANAGER_DELIVERY_FAILED', message: error.message, details: error.details ?? null } }));
      }
    }
    return delivered;
  }

  async function createRun(request) {
    if (await selectedRepository.getRun(request.workflow_id)) throw Object.assign(new Error(`workflow already exists: ${request.workflow_id}`), { code: 'WORKFLOW_EXISTS' });
    const routePlan = compileRoutePlan(projectRoot, request.route_plan);
    if (routePlan.workflow_id !== request.workflow_id) throw Object.assign(new Error('route plan is not bound to request workflow'), { code: 'ROUTE_PLAN_WORKFLOW_MISMATCH' });
    const projectRootAbs = request.project_ref ? selectedProjectControl.resolveProject(request.project_ref, request.workflow_id).projectRootAbs : request.project_path_abs;
    const target = selectedWorktrees.inspectTarget(projectRootAbs);
    const run = await selectedRepository.createRun({ workflowId: request.workflow_id,
      request: { original_request: request.original_request, request_id: request.request_id, submitted_at: request.submitted_at, user_authorized: request.user_authorized },
      routePlan, targetProjectRootAbs: target.targetProjectRootAbs, baseCommit: target.headCommit,
      managerSessionId: request.manager_session_id, managerSessionKey: request.manager_session_key, managerDelivery: request.manager_delivery ?? null });
    await announce(run, 'ROUTE_CONFIRMED', { route_plan: routePlan, summary: 'Route was confirmed by the user and is now frozen.' });
    return run;
  }

  async function reviseRun(request) {
    const run = await selectedRepository.getRun(request.workflow_id);
    if (!run) throw Object.assign(new Error(`workflow not found: ${request.workflow_id}`), { code: 'WORKFLOW_NOT_FOUND' });
    const tasks = await selectedRepository.listTasks({ runId: run.runId });
    if (tasks.some((task) => task.state === 'RUNNING')) throw Object.assign(new Error('cannot revise a route with a running task'), { code: 'ROUTE_REVISION_RUNNING_TASK' });
    const plan = compileRoutePlan(projectRoot, request.route_plan);
    if (plan.workflow_id !== run.workflowId) throw Object.assign(new Error('route plan workflow mismatch'), { code: 'ROUTE_PLAN_WORKFLOW_MISMATCH' });
    const revised = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', routePlan: plan, routeHash: plan.route_hash, currentStepIndex: 0, statusReason: 'route revised by confirmed user request' }, { eventType: 'ROUTE_REVISED', eventPayload: { request_id: request.request_id, route_plan: plan } });
    await announce(revised, 'ROUTE_REVISED', { summary: 'The confirmed route was revised and will restart from its first step.' });
    return revised;
  }

  async function finishRun(run, outcome, reason, task = null) {
    const finished = await selectedRepository.updateRun(run.runId, { state: 'TERMINAL', outcome, statusReason: reason, completedAt: now(clock) }, { eventType: 'RUN_TERMINAL', eventPayload: { outcome, reason } });
    await announce(finished, 'WORKFLOW_TERMINAL', { outcome, reason, published_result: publishedResult(task) });
    return finished;
  }

  async function advanceAfterSuccess(run, task, result) {
    const step = run.routePlan.steps[run.currentStepIndex];
    if (step.human_approval_after) {
      const request = approvalRequest(task, result, step);
      await selectedRepository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: step.step_id, trigger: request.trigger, request });
      await announce(run, 'HUMAN_APPROVAL_REQUIRED', { approval: request, result_summary: result.summary_for_user }, task.taskId);
      await queueDailyReport(run, task, 'WAITING_HUMAN');
      return { state: 'WAITING_HUMAN', task };
    }
    const nextIndex = run.currentStepIndex + 1;
    if (nextIndex >= run.routePlan.steps.length) {
      await queueDailyReport(run, task, 'SUCCEEDED');
      return { state: 'TERMINAL', run: await finishRun(run, 'SUCCEEDED', 'all confirmed route steps completed', task) };
    }
    await queueDailyReport(run, task, 'SUCCEEDED');
    const updated = await selectedRepository.updateRun(run.runId, { currentStepIndex: nextIndex, state: 'ACTIVE', statusReason: `step ${step.step_id} completed` }, { eventType: 'ROUTE_ADVANCED', eventPayload: { completed_step_id: step.step_id, next_step_index: nextIndex } });
    await announce(updated, 'TASK_COMPLETED', { task_id: task.taskId, step_id: step.step_id, summary: result.summary_for_user,
      published_result: publishedResult(task) }, task.taskId);
    return { state: 'ACTIVE', run: updated };
  }

  async function taskForStep(run, step) {
    const prior = await selectedRepository.listTasks({ runId: run.runId });
    let stored = prior.find((task) => task.stepId === step.step_id);
    if (!stored) stored = await selectedRepository.createTask({ runId: run.runId, step, agentId: step.agent_id, inputCommit: run.candidateCommit ?? run.baseCommit, maxAttempts, payload: { step, prior_artifacts: prior.filter((task) => task.state === 'SUCCEEDED').map((task) => task.payload?.published_output_path_abs).filter(Boolean) } });
    if (stored.state !== 'READY') return { stored, task: null };
    const storedWorkspace = stored.payload?.workspace_root_abs && stored.payload?.worktree_path_abs && stored.payload?.artifact_root_abs
      && stored.payload?.workspace_attempt === stored.attempt
      ? { workspaceRootAbs: stored.payload.workspace_root_abs, worktreePathAbs: stored.payload.worktree_path_abs, artifactRootAbs: stored.payload.artifact_root_abs }
      : null;
    const legacyWorkspace = !storedWorkspace && stored.payload?.worktree_path_abs && stored.payload?.artifact_root_abs
      && existsSync(stored.payload.worktree_path_abs) && existsSync(stored.payload.artifact_root_abs)
      ? (() => {
        const worktreePathAbs = realpathSync.native(stored.payload.worktree_path_abs);
        const artifactRootAbs = realpathSync.native(stored.payload.artifact_root_abs);
        if (!inside(join(runtimeRoot, 'worktrees'), worktreePathAbs) || !inside(join(runtimeRoot, 'artifacts'), artifactRootAbs)) return null;
        return { workspaceRootAbs: dirname(worktreePathAbs), worktreePathAbs, artifactRootAbs };
      })()
      : null;
    let allocation = null;
    let prepared = null;
    try {
      selectedWorktrees.inspectTarget(run.targetProjectRootAbs);
      allocation = storedWorkspace ?? legacyWorkspace ?? taskWorkspaces.reserve({ targetProjectRootAbs: run.targetProjectRootAbs, agentId: stored.agentId, title: stored.title });
      const artifactRootAbs = allocation.artifactRootAbs ?? allocation.workspaceRootAbs;
      mkdirSync(artifactRootAbs, { recursive: true });
      prepared = storedWorkspace || legacyWorkspace
        ? { worktreePathAbs: allocation.worktreePathAbs, inputCommit: stored.inputCommit }
        : selectedWorktrees.prepare({ workflowId: run.workflowId, taskId: stored.taskId, runId: run.runId, attempt: stored.attempt,
          title: stored.title, workspaceRootAbs: allocation.workspaceRootAbs, inputCommit: stored.inputCommit, targetProjectRootAbs: run.targetProjectRootAbs });
    } catch (error) {
      if (!storedWorkspace && !legacyWorkspace && allocation?.workspaceRootAbs) taskWorkspaces.release(allocation.workspaceRootAbs);
      const existing = (await selectedRepository.listApprovals({ runId: run.runId, status: 'PENDING' }))
        .find((approval) => approval.taskId === stored.taskId && approval.trigger === 'TASK_PREPARATION_FAILED');
      const approval = existing ?? await selectedRepository.createApproval({ runId: run.runId, taskId: stored.taskId, stepId: stored.stepId,
        trigger: 'TASK_PREPARATION_FAILED', request: taskPreparationApprovalRequest(run, stored, error) });
      const waiting = await selectedRepository.getRunById(run.runId);
      await announce(waiting, 'TASK_PREPARATION_FAILED', { task_id: stored.taskId,
        error: { code: error.code ?? 'TASK_PREPARATION_FAILED', message: error.message }, approval: approval.request }, stored.taskId);
      return { stored: await selectedRepository.getTask(stored.taskId), task: null };
    }
    const artifactRootAbs = allocation.artifactRootAbs ?? allocation.workspaceRootAbs;
    const task = { workflowId: run.workflowId, runId: run.runId, taskId: stored.taskId, stepId: stored.stepId, kind: stored.kind, title: stored.title,
      agentId: stored.agentId, attempt: stored.attempt, routeHash: stored.routeHash, inputCommit: stored.inputCommit, releasePhase: step.release_phase ?? null,
      deployment: run.routePlan.deployment ?? null,
      originalRequest: run.request?.original_request ?? null,
      targetProjectRootAbs: run.targetProjectRootAbs, worktreePathAbs: prepared.worktreePathAbs, artifactRootAbs,
      requiredGateChecks: GATE_CHECKS_BY_KIND[stored.kind] ?? [], contextManifestPathAbs: stored.contextManifest?.path_abs ?? null,
      contextManifestSha256: stored.contextManifest?.sha256 ?? null,
      resolvedDecisions: stored.payload?.resolved_decisions ?? [] };
    // Context manifests created before original-request propagation did not contain
    // input/user-request.md. Regenerate those incomplete manifests before dispatch.
    const originalRequestPath = join(inputRootForAttempt(task), 'user-request.md');
    if (!task.contextManifestPathAbs || !existsSync(task.contextManifestPathAbs) || !existsSync(originalRequestPath)) {
      const context = createContextManifest({ projectRoot, task, priorArtifacts: stored.payload?.prior_artifacts ?? [] });
      task.contextManifestPathAbs = context.path; task.contextManifestSha256 = context.sha256;
      stored = await selectedRepository.updateTask(stored.taskId, { contextManifest: { path_abs: context.path, sha256: context.sha256 }, payload: { ...(stored.payload ?? {}),
        workspace_root_abs: allocation.workspaceRootAbs, workspace_attempt: stored.attempt, artifact_root_abs: artifactRootAbs, worktree_path_abs: prepared.worktreePathAbs } }, { eventType: 'TASK_CONTEXT_PREPARED', eventPayload: { context_manifest_sha256: context.sha256 } });
    }
    task.rawOutputPath = join(artifactRootAbs, '.agent-raw', 'result.json.raw');
    return { stored, task };
  }

  async function executeTask(run, step, stored) {
    const { stored: current, task } = await taskForStep(run, step);
    if (current.state === 'SUCCEEDED') return advanceAfterSuccess(run, current, current.payload?.result ?? { summary_for_user: 'Previously published task result.' });
    if (current.state === 'WAITING_HUMAN') return { state: 'WAITING_HUMAN', task: current };
    if (current.kind === 'TEST' && current.state === 'READY' && run.routePlan.steps.some((item) => item.kind === 'DEVELOPMENT')) {
      const prior = await selectedRepository.listTasks({ runId: run.runId });
      const upstream = prior.find((item) => item.kind === 'DEVELOPMENT');
      if (!completedDevelopmentTask(upstream)) {
        const request = upstreamImplementationApprovalRequest(run, current, upstream);
        await selectedRepository.createApproval({ runId: run.runId, taskId: current.taskId, stepId: current.stepId, trigger: request.trigger, request });
        const waiting = await selectedRepository.getRunById(run.runId);
        await announce(waiting, 'HUMAN_APPROVAL_REQUIRED', { approval: request, result_summary: request.summary }, current.taskId);
        return { state: 'WAITING_HUMAN', run: waiting, task: await selectedRepository.getTask(current.taskId) };
      }
    }
    if (current.state === 'FAILED') {
      if (current.attempt >= current.maxAttempts) {
        const request = retryExhaustedApprovalRequest({ ...current, workflowId: run.workflowId });
        const approval = await selectedRepository.createApproval({ runId: run.runId, taskId: current.taskId, stepId: current.stepId,
          trigger: request.trigger, request });
        const waiting = await selectedRepository.getRunById(run.runId);
        await announce(waiting, 'TASK_RETRY_EXHAUSTED', { task_id: current.taskId, error: current.lastError, approval: approval.request }, current.taskId);
        return { state: 'WAITING_HUMAN', run: waiting };
      }
      const retry = await selectedRepository.updateTask(current.taskId, { state: 'READY', attempt: current.attempt + 1,
        jsonRegenerations: 0, executionRound: current.executionRound + 1, lastError: current.lastError, contextManifest: {},
        payload: { ...(current.payload ?? {}), workspace_root_abs: null, workspace_attempt: null, artifact_root_abs: null, worktree_path_abs: null } },
      { eventType: 'TASK_RETRY_READY', eventPayload: { next_attempt: current.attempt + 1 } });
      await announce(run, 'TASK_RETRY_READY', { task_id: retry.taskId, attempt: retry.attempt }, retry.taskId);
      return { state: 'READY', task: retry };
    }
    if (current.state !== 'READY') return { state: current.state, task: current };
    assertOrchestratorWorker(registry, task.agentId);
    const sessionId = taskSession(task);
    const executionId = selectedKernel.ids.executionIdFor(run.runId, { attempt: task.attempt, cycle: 0 });
    let execution;
    try {
      execution = await selectedKernel.lease.acquireLease({ executionId, taskId: task.taskId, runId: run.runId, attempt: task.attempt, cycle: 0,
        workerId: selectedKernel.workerId, sessionId, agentId: task.agentId, worktreePathAbs: task.worktreePathAbs, artifactRootAbs: task.artifactRootAbs, phase: 'DISPATCHING' });
    } catch (error) {
      if (error.code === 'LEASE_HELD') return { state: 'RUNNING', lease: error.details };
      throw error;
    }
    await selectedRepository.updateTask(task.taskId, { state: 'RUNNING' }, { eventType: 'TASK_STARTED', eventPayload: { execution_id: execution.executionId, session_id: sessionId } });
    const executionMutation = (patch) => selectedRepository.updateTaskForExecution(task.taskId, patch, {
      executionId: execution.executionId, attempt: task.attempt,
    });
    const assertExecutionLease = async (phase) => {
      const held = await selectedKernel.lease.heartbeat({ executionId: execution.executionId, phase });
      if (!held) throw Object.assign(new Error(`execution lease was lost: ${execution.executionId}`), {
        code: 'EXECUTION_LEASE_LOST', details: { execution_id: execution.executionId },
      });
      return held;
    };
    const abandonExecution = async (error) => {
      await selectedKernel.lease.reapExpiredLeases();
      await selectedKernel.lease.releaseLease({ executionId: execution.executionId, state: 'FAILED', exitCode: 1,
        error: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message } });
      return selectedRepository.getTask(task.taskId);
    };
    let testSandbox = null;
    let testSandboxCollection = null;
    let taskSnapshot = null;
    try {
      let executionOutcome = null;
      task.testSandboxEnabled = testSandboxEnabled;
      if (task.kind === 'TEST' && testSandboxEnabled) {
        try {
          testSandbox = await selectedTestSandboxStager.prepare(task);
          task.testSandbox = testSandbox;
        } catch (error) {
          const occurredAt = now(clock);
          const recorded = tryWriteTestSandboxPreparationDiagnostic(task, error, occurredAt);
          if (recorded.write_error) error.details = { ...(error.details ?? {}), diagnostic_write_error: recorded.write_error };
          atomicWriteFile(task.rawOutputPath, `${JSON.stringify(stagingPreparationBlockedResult(task, error, occurredAt, recorded.diagnostic))}\n`);
          executionOutcome = { result: { exitCode: 1, stdout: '', stderr: error.message, failureCode: error.code ?? 'TEST_SANDBOX_PREPARE_FAILED' },
            ingested: ingestTaskOutput({ projectRoot, task, occurredAt, testSandboxPreparationFailure: true }) };
        }
      }
      if (!executionOutcome) {
        await announce(run, 'TASK_STARTED', { task_id: task.taskId, agent_id: task.agentId, step_id: task.stepId }, task.taskId);
        await assertExecutionLease('DISPATCHING');
        const dispatchRoot = join(task.artifactRootAbs, '.orchestrator'); mkdirSync(dispatchRoot, { recursive: true });
        const messagePath = join(dispatchRoot, `attempt-${task.attempt}.message.md`); atomicWriteFile(messagePath, taskMessage(task));
        atomicWriteJson(join(dispatchRoot, `attempt-${task.attempt}.dispatch.json`), { schema_version: 1, execution_id: execution.executionId, session_id: sessionId, message_path_abs: messagePath, started_at: now(clock) });
        executionOutcome = await runWithLeaseHeartbeat({ lease: selectedKernel.lease, executionId: execution.executionId, signal,
        run: async (heartbeatSignal) => {
          let activeMessagePath = messagePath;
          let regeneration = current.jsonRegenerations ?? 0;
          let repairWorktreeFingerprint = null;
          while (true) {
            if (regeneration) await assertExecutionLease('JSON_REGENERATION_DISPATCH');
            const result = await runner({ agentId: task.agentId, sessionId, messagePath: activeMessagePath, timeoutSeconds, signal: heartbeatSignal });
            const logSuffix = regeneration ? `.json-regeneration-${regeneration}` : '';
            processLog(task, `attempt-${task.attempt}${logSuffix}.stdout.log`, result.stdout);
            processLog(task, `attempt-${task.attempt}${logSuffix}.stderr.log`, result.stderr);
            if (result.exitCode !== 0) throw openClawAgentExitError(result);
            if (!regeneration) {
              let finalText = null;
              try {
                finalText = extractFinalAssistantVisibleText(result.stdout);
                // The host owns the delivery channel. A non-empty final reply is
                // staged atomically so normal executions use the same path as
                // JSON regeneration; legacy file writers remain readable when
                // the model returned no visible text.
                atomicWriteFile(testSandbox?.executionRawOutputPath ?? task.rawOutputPath, `${finalText}\n`);
              } catch (error) {
                // Preserve compatibility with workers that staged a raw file
                // but returned no machine-visible final text.
                if (error.code !== 'OPENCLAW_ASSISTANT_OUTPUT_MISSING' && !existsSync(task.rawOutputPath)) throw error;
              }
              if (testSandbox) testSandboxCollection = selectedTestSandboxStager.collect(task, testSandbox);
            }
            if (regeneration) {
              if (heartbeatSignal.aborted) throw Object.assign(new Error('execution lease was lost before JSON repair could be accepted'), { code: 'EXECUTION_LEASE_LOST' });
              const held = await selectedKernel.lease.heartbeat({ executionId: execution.executionId, phase: 'JSON_REGENERATION_VALIDATION' });
              if (!held) throw Object.assign(new Error('execution lease was lost before JSON repair could be accepted'), { code: 'EXECUTION_LEASE_LOST' });
              if (repairWorktreeFingerprint && selectedWorktrees.fingerprint) {
                const after = selectedWorktrees.fingerprint(task.worktreePathAbs);
                if (JSON.stringify(after) !== JSON.stringify(repairWorktreeFingerprint)) {
                  throw Object.assign(new Error('JSON repair turn changed the task worktree'), { code: 'JSON_REPAIR_WORKTREE_CHANGED', details: { before: repairWorktreeFingerprint, after } });
                }
              }
              atomicWriteFile(task.rawOutputPath, `${extractFinalAssistantText(result.stdout).trim()}\n`);
            }
            try {
              return { result, ingested: ingestTaskOutput({ projectRoot, task, occurredAt: now(clock), testSandboxEnabled, sandboxContext: testSandbox ? {
                attestation: testSandbox.attestation, referencePathMappings: testSandboxCollection?.referencePathMappings ?? [],
              } : null }) };
            } catch (error) {
              if (!isJsonRegenerable(error)) {
                if (isOutputBoundaryFailure(error)) {
                  archiveOutputBoundaryFailure({ task, error, sessionId, occurredAt: now(clock) });
                  await assertExecutionLease('OUTPUT_BOUNDARY_ARCHIVED');
                }
                throw error;
              }
              if (regeneration >= MAX_JSON_REGENERATIONS) {
                archiveJsonRegeneration({ task, error, regeneration, sessionId, occurredAt: now(clock), exhausted: true });
                throw error;
              }
              if (heartbeatSignal.aborted) throw Object.assign(new Error('execution lease was lost before JSON regeneration dispatch'), { code: 'EXECUTION_LEASE_LOST' });
              const held = await selectedKernel.lease.heartbeat({ executionId: execution.executionId, phase: 'JSON_REGENERATION_PREPARE' });
              if (!held) throw Object.assign(new Error('execution lease was lost before JSON regeneration dispatch'), { code: 'EXECUTION_LEASE_LOST' });
              regeneration += 1;
              repairWorktreeFingerprint ??= selectedWorktrees.fingerprint?.(task.worktreePathAbs) ?? null;
              const archived = archiveJsonRegeneration({ task, error, regeneration, sessionId, occurredAt: now(clock) });
              await assertExecutionLease('JSON_REGENERATION_ARCHIVED');
              await executionMutation({ jsonRegenerations: regeneration });
              await assertExecutionLease('JSON_REGENERATION_RECORDED');
              await announce(run, 'TASK_JSON_REGENERATION_REQUESTED', { task_id: task.taskId, attempt: task.attempt,
                regeneration, max_regenerations: MAX_JSON_REGENERATIONS, session_id: sessionId, code: error.code,
                errors: error.details?.errors ?? [{ message: error.message }] }, task.taskId);
              await assertExecutionLease('JSON_REGENERATION_ANNOUNCED');
              activeMessagePath = archived.messagePath;
            }
          }
        } });
      }
      const { result, ingested } = executionOutcome;
      if (testSandbox && selectedTestSandboxStager.integrateCommit) {
        selectedTestSandboxStager.integrateCommit(task, testSandbox, ingested.value.output_commit ?? task.inputCommit);
      }
      const snapshotInput = { runId: run.runId, taskId: task.taskId, executionId: execution.executionId,
        attempt: task.attempt, agentId: task.agentId, sessionId, inputCommit: task.inputCommit,
        worktreePathAbs: task.worktreePathAbs, targetProjectRootAbs: task.targetProjectRootAbs };
      const snapshot = ingested.value.result_status === 'COMPLETED'
        ? await selectedSnapshots.accept({ ...snapshotInput, outputCommit: ingested.value.output_commit ?? task.inputCommit })
        : await selectedSnapshots.recover(snapshotInput);
      taskSnapshot = snapshot;
      await assertExecutionLease('TASK_RESULT_COMMIT');
      const payload = { ...(current.payload ?? {}), result: ingested.value, snapshot, published_output_path_abs: ingested.outputPath, ingestion_receipt_path_abs: ingested.receiptPath, session_id: sessionId };
      const failedResult = ['NEEDS_REWORK', 'BLOCKED', 'FAILED'].includes(ingested.value.result_status);
      const completed = await executionMutation(failedResult
        ? { state: 'FAILED', payload, lastError: { code: `AGENT_${ingested.value.result_status}`, summary: ingested.value.summary_for_manager } }
        : { state: 'SUCCEEDED', payload });
      const released = await selectedKernel.lease.releaseLease({ executionId: execution.executionId,
        state: failedResult ? 'FAILED' : 'SUCCEEDED', exitCode: result.exitCode });
      if (!released) throw Object.assign(new Error(`execution lease was lost after task result commit: ${execution.executionId}`), {
        code: 'EXECUTION_LEASE_LOST', details: { execution_id: execution.executionId },
      });
      await selectedRepository.registerArtifact({ runId: run.runId, taskId: task.taskId, executionId: execution.executionId, kind: 'RESULT', uri: ingested.outputPath, sha256: sha256File(ingested.outputPath), sizeBytes: 0, mediaType: 'application/json' });
      await selectedRepository.registerArtifact({ runId: run.runId, taskId: task.taskId, executionId: execution.executionId, kind: 'INGESTION_RECEIPT', uri: ingested.receiptPath, sha256: sha256File(ingested.receiptPath), sizeBytes: 0, mediaType: 'application/json' });
      const latestRun = await selectedRepository.getRunById(run.runId);
      if (latestRun?.state === 'HOLD') {
        await queueDailyReport(latestRun, completed, 'PAUSED');
        return { state: 'HOLD', run: latestRun, task: completed };
      }
      if (ingested.value.result_status === 'HUMAN_DECISION_REQUIRED') {
        const request = approvalRequest(task, ingested.value);
        await selectedRepository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: request.trigger, request });
        await announce(run, 'HUMAN_APPROVAL_REQUIRED', { approval: request, result_summary: ingested.value.summary_for_user }, task.taskId);
        return { state: 'WAITING_HUMAN', task: completed };
      }
      if (failedResult) {
        const failed = completed;
        await announce(run, ingested.value.result_status === 'NEEDS_REWORK' ? 'TASK_REWORK_REQUESTED' : 'TASK_FAILED', { task_id: task.taskId, result_status: ingested.value.result_status, summary: ingested.value.summary_for_user }, task.taskId);
        await queueDailyReport(run, failed, ingested.value.result_status);
        return { state: 'FAILED', task: failed };
      }
      return advanceAfterSuccess(run, completed, ingested.value);
    } catch (error) {
      if (error.code === 'EXECUTION_TASK_CAS_FAILED' || error.code === 'EXECUTION_LEASE_LOST') {
        const latest = await abandonExecution(error);
        return { state: latest?.state ?? 'FAILED', task: latest };
      }
      let recoverySnapshot = null;
      try {
        recoverySnapshot = taskSnapshot ?? error.details?.snapshot ?? await selectedSnapshots.recover({ runId: run.runId, taskId: task.taskId, executionId: execution.executionId,
          attempt: task.attempt, agentId: task.agentId, sessionId, inputCommit: task.inputCommit,
          worktreePathAbs: task.worktreePathAbs, targetProjectRootAbs: task.targetProjectRootAbs });
      } catch (recoveryError) {
        error.details = { ...(error.details ?? {}), recovery_error: { code: recoveryError.code ?? 'SNAPSHOT_RECOVERY_FAILED', message: recoveryError.message } };
      }
      try { await assertExecutionLease('TASK_FAILURE_COMMIT'); }
      catch (leaseError) {
        const latest = await abandonExecution(leaseError);
        return { state: latest?.state ?? 'FAILED', task: latest };
      }
      const receipt = writeFailureReceipt(task, error, now(clock));
      let failed;
      try {
        failed = await executionMutation({ state: 'FAILED', payload: { ...(current.payload ?? {}), recovery_snapshot: recoverySnapshot },
          lastError: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message, receipt_path_abs: receipt } });
      } catch (casError) {
        if (casError.code !== 'EXECUTION_TASK_CAS_FAILED') throw casError;
        const latest = await abandonExecution(error);
        return { state: latest?.state ?? 'FAILED', task: latest };
      }
      await selectedKernel.lease.releaseLease({ executionId: execution.executionId, state: 'FAILED', exitCode: 1,
        error: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message } });
      await announce(run, 'TASK_FAILED', { task_id: task.taskId, agent_id: task.agentId, error: failed.lastError }, task.taskId);
      await queueDailyReport(run, failed, 'FAILED');
      return { state: 'FAILED', task: failed };
    } finally {
      if (testSandbox) await selectedTestSandboxStager.cleanup(testSandbox);
    }
  }

  async function tick(workflowId) {
    await selectedKernel.lease.reapExpiredLeases();
    const run = await selectedRepository.getRun(workflowId);
    if (!run) throw Object.assign(new Error(`workflow not found: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
    if (run.state !== 'ACTIVE') return { run, state: run.state };
    const step = run.routePlan?.steps?.[run.currentStepIndex];
    if (!step) return { run: await finishRun(run, 'SUCCEEDED', 'route contains no remaining steps'), state: 'TERMINAL' };
    return executeTask(run, step);
  }

  async function tickAll() {
    await approvalCommands.scan();
    await workflowControlCommands.scan();
    const runs = await selectedRepository.listRuns(); const results = [];
    for (const run of runs) if (run.state === 'ACTIVE') results.push(await tick(run.workflowId));
    await deliverNotifications(); return results;
  }

  async function resolveDecision({ run, decisionId, choice, notes = '', actor }) {
    const pending = (await selectedRepository.listApprovals({ runId: run.runId, status: 'PENDING' })).find((item) => item.decisionId === decisionId);
    if (!pending) throw Object.assign(new Error('approval not found or already resolved'), { code: 'APPROVAL_NOT_PENDING' });
    const allowed = pending.request?.options?.map((option) => option.option_id ?? option.id).filter(Boolean) ?? [];
    if (!allowed.includes(choice)) throw Object.assign(new Error('approval choice is not allowed'), { code: 'APPROVAL_OPTION_INVALID' });
    if (pending.trigger === 'TASK_RETRY_EXHAUSTED') {
      const resolved = await selectedRepository.resolveRetryExhaustedApproval({ decisionId,
        response: { outcome: choice, notes, actor, decided_at: now(clock) } });
      if (['ABORT', 'CANCEL', 'REJECTED'].includes(choice)) {
        await queueDailyReport(resolved.run, resolved.task, 'CANCELLED');
        await announce(resolved.run, 'WORKFLOW_TERMINAL', { outcome: 'CANCELLED', reason: 'user declined an exhausted retry approval',
          published_result: publishedResult(resolved.task) }, resolved.task.taskId);
      } else {
        await announce(resolved.run, 'TASK_RETRY_BATCH_APPROVED',
          { task_id: resolved.task.taskId, decision_id: resolved.approval.decisionId, choice }, resolved.task.taskId);
      }
      return resolved.run;
    }
    const approval = await selectedRepository.resolveApproval({ decisionId, response: { outcome: choice, notes, actor, decided_at: now(clock) } });
    const task = approval.taskId ? await selectedRepository.getTask(approval.taskId) : null;
    if (['CANCEL', 'ABORT', 'REJECTED'].includes(choice)) {
      if (task) {
        const cancelled = await selectedRepository.updateTask(task.taskId, { state: 'CANCELLED' }, { eventType: 'TASK_CANCELLED_BY_HUMAN', eventPayload: { decision_id: approval.decisionId } });
        await queueDailyReport(run, cancelled, 'CANCELLED');
      }
      return finishRun(run, 'CANCELLED', 'user declined an approval through Manager', task);
    }
    if (task?.payload?.result?.result_status === 'HUMAN_DECISION_REQUIRED') {
      const resolvedDecisions = [...(task.payload?.resolved_decisions ?? []), { decision_id: approval.decisionId, choice, notes, actor }];
      const retried = await selectedRepository.updateTask(task.taskId, { state: 'READY', attempt: task.attempt + 1,
        jsonRegenerations: 0, executionRound: task.executionRound + 1, contextManifest: {},
        payload: { ...(task.payload ?? {}), resolved_decisions: resolvedDecisions,
          workspace_root_abs: null, workspace_attempt: null, artifact_root_abs: null, worktree_path_abs: null } },
      { eventType: 'TASK_AGENT_DECISION_RESOLVED', eventPayload: { decision_id: approval.decisionId, choice } });
      const active = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', statusReason: 'agent decision resolved; current task will re-run' },
        { eventType: 'WORKFLOW_RESUMED', eventPayload: { decision_id: approval.decisionId, choice } });
      await announce(active, 'HUMAN_APPROVAL_RESOLVED', { decision_id: approval.decisionId, choice, actor, notes, re_dispatch_task_id: retried.taskId }, retried.taskId);
      return active;
    }
    if (approval.trigger === 'UPSTREAM_IMPLEMENTATION_MISSING' && task && choice === 'REWORK') {
      const upstream = approval.request?.upstream_task_id ? await selectedRepository.getTask(approval.request.upstream_task_id) : null;
      const upstreamIndex = upstream ? run.routePlan.steps.findIndex((step) => step.step_id === upstream.stepId) : -1;
      if (!upstream || upstreamIndex < 0) throw Object.assign(new Error('upstream DEVELOPMENT task is unavailable for rework'), { code: 'UPSTREAM_REWORK_TARGET_MISSING' });
      await selectedRepository.updateTask(upstream.taskId, { state: 'READY', attempt: upstream.attempt + 1,
        jsonRegenerations: 0, executionRound: upstream.executionRound + 1, contextManifest: {},
        payload: { ...(upstream.payload ?? {}), rework_authorization: { decision_id: approval.decisionId, choice, notes, actor },
          workspace_root_abs: null, workspace_attempt: null, artifact_root_abs: null, worktree_path_abs: null } },
      { eventType: 'TASK_UPSTREAM_REWORK_APPROVED', eventPayload: { decision_id: approval.decisionId, source_task_id: task.taskId } });
      await selectedRepository.updateTask(task.taskId, { state: 'READY', contextManifest: {},
        payload: { ...(task.payload ?? {}), workspace_root_abs: null, workspace_attempt: null, artifact_root_abs: null, worktree_path_abs: null } });
      const active = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', currentStepIndex: upstreamIndex, statusReason: 'user approved upstream development rework' },
        { eventType: 'WORKFLOW_REWOUND_FOR_REWORK', eventPayload: { decision_id: approval.decisionId, source_task_id: task.taskId, upstream_task_id: upstream.taskId } });
      await announce(active, 'TASK_REWORK_APPROVED', { task_id: upstream.taskId, decision_id: approval.decisionId, choice, actor, notes }, upstream.taskId);
      return active;
    }
    if (['RETRY_SAME_AGENT', 'REWORK', 'REVISE'].includes(choice) && task) {
      const exhausted = pending.trigger === 'TASK_RETRY_EXHAUSTED';
      await selectedRepository.updateTask(task.taskId, { state: 'READY', attempt: task.attempt + 1,
        maxAttempts: exhausted ? task.maxAttempts + 3 : task.maxAttempts,
        jsonRegenerations: 0, executionRound: task.executionRound + 1, contextManifest: {},
        payload: { ...(task.payload ?? {}), retry_authorization: { decision_id: approval.decisionId, choice, notes, actor, exhausted } } },
      { eventType: 'TASK_REWORK_APPROVED', eventPayload: { decision_id: approval.decisionId, choice } });
      const active = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', statusReason: exhausted ? 'user approved a new retry batch' : 'user requested rework' },
        { eventType: 'WORKFLOW_RESUMED', eventPayload: { decision_id: approval.decisionId, choice } });
      await announce(active, exhausted ? 'TASK_RETRY_BATCH_APPROVED' : 'TASK_REWORK_APPROVED',
        { task_id: task.taskId, decision_id: approval.decisionId, choice }, task.taskId);
      return active;
    }
    const nextIndex = run.currentStepIndex + 1;
    const resumed = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', currentStepIndex: nextIndex, statusReason: 'human approval accepted' }, { eventType: 'WORKFLOW_RESUMED', eventPayload: { decision_id: approval.decisionId, choice } });
    await announce(resumed, 'HUMAN_APPROVAL_RESOLVED', { decision_id: approval.decisionId, choice, actor, notes }, task?.taskId ?? null);
    return nextIndex >= run.routePlan.steps.length ? finishRun(resumed, 'SUCCEEDED', 'all route steps approved') : resumed;
  }

  async function resolveApprovalCommand(command) {
    const run = await selectedRepository.getRun(command.workflow_id);
    if (!run) throw Object.assign(new Error(`workflow not found: ${command.workflow_id}`), { code: 'WORKFLOW_NOT_FOUND' });
    if (run.runId !== command.run_id) throw Object.assign(new Error('approval command run does not match workflow'), { code: 'APPROVAL_COMMAND_RUN_MISMATCH' });
    const approval = (await selectedRepository.listApprovals({ runId: run.runId, status: 'PENDING' })).find((item) => item.decisionId === command.decision_id);
    if (!approval) throw Object.assign(new Error('approval not found or already resolved'), { code: 'APPROVAL_NOT_PENDING' });
    if (approval.taskId !== command.task_id) throw Object.assign(new Error('approval command task does not match pending approval'), { code: 'APPROVAL_COMMAND_TASK_MISMATCH' });
    return resolveDecision({ run, decisionId: command.decision_id, choice: command.choice, notes: command.notes, actor: command.actor });
  }

  async function pauseRun({ workflowId, runId, actor, notes = '' }) {
    const run = await selectedRepository.getRun(workflowId);
    if (!run || run.runId !== runId) throw Object.assign(new Error('workflow control command does not match a current workflow run'), { code: 'WORKFLOW_CONTROL_RUN_MISMATCH' });
    if (run.state === 'TERMINAL') throw Object.assign(new Error('terminal workflows cannot be paused'), { code: 'WORKFLOW_CONTROL_TERMINAL' });
    if (run.state === 'HOLD') return run;
    if (run.state !== 'ACTIVE') throw Object.assign(new Error('workflow cannot be paused in its current state'), { code: 'WORKFLOW_CONTROL_PAUSE_INVALID_STATE' });
    const held = await selectedRepository.updateRun(run.runId, { state: 'HOLD', statusReason: 'paused by explicit human request' }, { eventType: 'WORKFLOW_PAUSED', eventPayload: { actor, notes } });
    await announce(held, 'WORKFLOW_PAUSED', { actor, notes });
    return held;
  }

  async function resumeRun({ workflowId, runId, actor, notes = '' }) {
    const run = await selectedRepository.getRun(workflowId);
    if (!run || run.runId !== runId) throw Object.assign(new Error('workflow control command does not match a current workflow run'), { code: 'WORKFLOW_CONTROL_RUN_MISMATCH' });
    if (run.state === 'TERMINAL') throw Object.assign(new Error('terminal workflows cannot be resumed'), { code: 'WORKFLOW_CONTROL_TERMINAL' });
    if (run.state === 'ACTIVE') return run;
    if (run.state !== 'HOLD') throw Object.assign(new Error('workflow can be resumed only from HOLD'), { code: 'WORKFLOW_CONTROL_RESUME_INVALID_STATE' });
    const active = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', statusReason: 'resumed by explicit human request' }, { eventType: 'WORKFLOW_RESUMED_FROM_HOLD', eventPayload: { actor, notes } });
    await announce(active, 'WORKFLOW_RESUMED_FROM_HOLD', { actor, notes });
    return active;
  }

  async function resolveWorkflowControlCommand(command) {
    if (command.action === 'PAUSE') return pauseRun({ workflowId: command.workflow_id, runId: command.run_id, actor: command.actor, notes: command.notes });
    if (command.action === 'RESUME') return resumeRun({ workflowId: command.workflow_id, runId: command.run_id, actor: command.actor, notes: command.notes });
    throw Object.assign(new Error('workflow control action is invalid'), { code: 'WORKFLOW_CONTROL_ACTION_INVALID' });
  }

  async function decide(request) {
    const run = await selectedRepository.getRun(request.workflow_id);
    if (!run) throw Object.assign(new Error(`workflow not found: ${request.workflow_id}`), { code: 'WORKFLOW_NOT_FOUND' });
    if (run.managerSessionId !== request.manager_session_id || run.managerSessionKey !== request.manager_session_key) throw Object.assign(new Error('decision session does not match workflow origin'), { code: 'MANAGER_SESSION_MISMATCH' });
    return resolveDecision({ run, decisionId: request.decision_id, choice: request.choice, notes: request.notes ?? '', actor: request.user_authorized.actor });
  }

  async function close() { if (ownedDatabase) selectedDatabase.close(); }
  function attachHrService(value) { hrService = value; return hrService; }
  return { projectRoot, runtimeRoot, repository: selectedRepository, kernel: selectedKernel, snapshots: selectedSnapshots, approvalCommands, workflowControlCommands, createRun, reviseRun, decide, resolveApprovalCommand, resolveWorkflowControlCommand, pauseRun, resumeRun, tick, tickAll, deliverNotifications, attachHrService, close };
}
