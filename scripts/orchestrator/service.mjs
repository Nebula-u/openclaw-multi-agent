import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile, atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { createKernel } from '../control-kernel/kernel.mjs';
import { createKernelPool, resolveKernelConfig } from '../control-kernel/pool.mjs';
import { createWorkflowRepository } from '../control-kernel/workflow-repository.mjs';
import { assertOrchestratorWorker, loadActiveAgentRegistry } from './agent-registry.mjs';
import { createContextManifest } from './context-manifest.mjs';
import { createGitWorktreeManager } from './git-worktree.mjs';
import { ingestTaskOutput, writeFailureReceipt } from './output-ingestion.mjs';
import { runOpenClawAgent } from './openclaw-runner.mjs';
import { compileRoutePlan, GATE_CHECKS_BY_KIND } from './route-policy.mjs';

function now(clock) { const value = clock(); return value instanceof Date ? value.toISOString() : value; }
function taskRoot(projectRoot, workflowId, taskId) { return join(projectRoot, 'runtime', 'artifacts', workflowId, taskId); }
function taskSession(task) { return `orc-${task.runId.toLowerCase()}-${task.taskId.toLowerCase()}-a${task.attempt}`.slice(0, 120); }
function processLog(task, name, content) { const path = join(task.artifactRootAbs, 'logs', name); mkdirSync(join(task.artifactRootAbs, 'logs'), { recursive: true }); atomicWriteFile(path, String(content ?? '')); return path; }
function notificationMessage(notification, run) {
  return `# Orchestrator update\n\nA workflow event must be explained to the user in the current native Manager conversation. Do not make a workflow decision on the user's behalf.\n\n${JSON.stringify({ workflow_id: run.workflowId, notification_type: notification.type, task_id: notification.taskId, payload: notification.payload }, null, 2)}\n`;
}
function approvalRequest(task, result = null, step = null) {
  const requested = result?.decisions_required?.[0] ?? {};
  const options = Array.isArray(requested.options) && requested.options.length ? requested.options : [{ option_id: 'APPROVE', description: 'Approve and continue' }, { option_id: 'REWORK', description: 'Request another attempt' }, { option_id: 'CANCEL', description: 'Cancel this workflow' }];
  return {
    decision_id: `DEC-${task.taskId.slice(5)}-${randomUUID().slice(0, 8)}`,
    workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    summary: requested.summary ?? step?.approval_reason ?? result?.summary_for_user ?? 'Human approval is required before this route can continue.',
    trigger: requested.trigger ?? (step ? 'ROUTE_STEP_APPROVAL' : 'AGENT_DECISION_REQUIRED'), options,
  };
}

export function taskMessage(task) {
  return `# Orchestrator task\n\n- workflow_id: ${task.workflowId}\n- task_id: ${task.taskId}\n- run_id: ${task.runId}\n- step_id: ${task.stepId}\n- assigned_agent: ${task.agentId}\n- attempt: ${task.attempt}\n- worktree_path_abs: ${task.worktreePathAbs}\n- context_manifest_path_abs: ${task.contextManifestPathAbs}\n- context_manifest_sha256: ${task.contextManifestSha256}\n\nComplete only this assigned step. Read the immutable context manifest. Do not communicate with other Agents, alter route or approval records, write to PostgreSQL, or call Monitor controls. Write exactly one result.schema.json object only to:\n\n${task.rawOutputPath}\n\nThe Orchestrator will validate and publish it. Do not write final outputs directly.\n`;
}

export function createOrchestrator({ projectRoot: projectRootInput, pool = null, kernel = null, repository = null, worktrees = null,
  runner = runOpenClawAgent, notificationRunner = runOpenClawAgent, hr = null, clock = () => new Date(), maxAttempts = 3, timeoutSeconds = 900 } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const ownedPool = !pool && !kernel && !repository;
  const config = resolveKernelConfig({ projectRoot });
  const selectedPool = pool ?? (kernel ? null : createKernelPool({ ...config }));
  const selectedKernel = kernel ?? createKernel({ pool: selectedPool, workerId: config.workerId, leaseSeconds: config.leaseSeconds, clock });
  const selectedRepository = repository ?? createWorkflowRepository({ pool: selectedPool, kernel: selectedKernel, clock });
  const selectedWorktrees = worktrees ?? createGitWorktreeManager({ projectRoot });
  const registry = loadActiveAgentRegistry(projectRoot);
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
      const run = await selectedRepository.getRunById(notification.runId);
      if (!run?.managerSessionId || !run.managerSessionKey) {
        delivered.push(await selectedRepository.updateNotification(notification.notificationId, { status: 'FAILED', incrementAttempts: true, lastError: { code: 'MANAGER_SESSION_MISSING', message: 'originating Manager session metadata is missing' } }));
        continue;
      }
      const root = join(projectRoot, 'runtime', 'orchestrator', 'notifications', notification.notificationId);
      mkdirSync(root, { recursive: true });
      const messagePath = join(root, 'manager-message.md'); atomicWriteFile(messagePath, notificationMessage(notification, run));
      try {
        const result = await notificationRunner({ agentId: 'manager-agent', sessionId: run.managerSessionId, messagePath, timeoutSeconds, deliver: run.managerDelivery });
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
    const target = selectedWorktrees.inspectTarget(request.project_path_abs);
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

  async function finishRun(run, outcome, reason) {
    const finished = await selectedRepository.updateRun(run.runId, { state: 'TERMINAL', outcome, statusReason: reason, completedAt: now(clock) }, { eventType: 'RUN_TERMINAL', eventPayload: { outcome, reason } });
    await announce(finished, 'WORKFLOW_TERMINAL', { outcome, reason });
    return finished;
  }

  async function advanceAfterSuccess(run, task, result) {
    const step = run.routePlan.steps[run.currentStepIndex];
    if (step.human_approval_after) {
      const request = approvalRequest(task, null, step);
      await selectedRepository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: step.step_id, trigger: request.trigger, request });
      await announce(run, 'HUMAN_APPROVAL_REQUIRED', { approval: request, result_summary: result.summary_for_user }, task.taskId);
      await queueDailyReport(run, task, 'WAITING_HUMAN');
      return { state: 'WAITING_HUMAN', task };
    }
    const nextIndex = run.currentStepIndex + 1;
    if (nextIndex >= run.routePlan.steps.length) {
      await queueDailyReport(run, task, 'SUCCEEDED');
      return { state: 'TERMINAL', run: await finishRun(run, 'SUCCEEDED', 'all confirmed route steps completed') };
    }
    await queueDailyReport(run, task, 'SUCCEEDED');
    const updated = await selectedRepository.updateRun(run.runId, { currentStepIndex: nextIndex, state: 'ACTIVE', statusReason: `step ${step.step_id} completed` }, { eventType: 'ROUTE_ADVANCED', eventPayload: { completed_step_id: step.step_id, next_step_index: nextIndex } });
    await announce(updated, 'TASK_COMPLETED', { task_id: task.taskId, step_id: step.step_id, summary: result.summary_for_user }, task.taskId);
    return { state: 'ACTIVE', run: updated };
  }

  async function taskForStep(run, step) {
    const prior = await selectedRepository.listTasks({ runId: run.runId });
    let stored = prior.find((task) => task.stepId === step.step_id);
    if (!stored) stored = await selectedRepository.createTask({ runId: run.runId, step, agentId: step.agent_id, inputCommit: run.candidateCommit ?? run.baseCommit, maxAttempts, payload: { step, prior_artifacts: prior.filter((task) => task.state === 'SUCCEEDED').map((task) => task.payload?.published_output_path_abs).filter(Boolean) } });
    const artifactRootAbs = taskRoot(projectRoot, run.workflowId, stored.taskId);
    mkdirSync(artifactRootAbs, { recursive: true });
    const prepared = selectedWorktrees.prepare({ workflowId: run.workflowId, taskId: stored.taskId, runId: run.runId, inputCommit: stored.inputCommit, targetProjectRootAbs: run.targetProjectRootAbs });
    const task = { workflowId: run.workflowId, runId: run.runId, taskId: stored.taskId, stepId: stored.stepId, kind: stored.kind, title: stored.title,
      agentId: stored.agentId, attempt: stored.attempt, routeHash: stored.routeHash, inputCommit: stored.inputCommit,
      targetProjectRootAbs: run.targetProjectRootAbs, worktreePathAbs: prepared.worktreePathAbs, artifactRootAbs,
      requiredGateChecks: GATE_CHECKS_BY_KIND[stored.kind] ?? [], contextManifestPathAbs: stored.contextManifest?.path_abs ?? null,
      contextManifestSha256: stored.contextManifest?.sha256 ?? null };
    if (!task.contextManifestPathAbs || !existsSync(task.contextManifestPathAbs)) {
      const context = createContextManifest({ projectRoot, task, priorArtifacts: stored.payload?.prior_artifacts ?? [] });
      task.contextManifestPathAbs = context.path; task.contextManifestSha256 = context.sha256;
      stored = await selectedRepository.updateTask(stored.taskId, { contextManifest: { path_abs: context.path, sha256: context.sha256 }, payload: { ...(stored.payload ?? {}), artifact_root_abs: artifactRootAbs, worktree_path_abs: prepared.worktreePathAbs } }, { eventType: 'TASK_CONTEXT_PREPARED', eventPayload: { context_manifest_sha256: context.sha256 } });
    }
    task.rawOutputPath = join(artifactRootAbs, '.agent-raw', 'result.json.raw');
    return { stored, task };
  }

  async function executeTask(run, step, stored) {
    const { stored: current, task } = await taskForStep(run, step);
    assertOrchestratorWorker(registry, task.agentId);
    if (current.state === 'SUCCEEDED') return advanceAfterSuccess(run, current, current.payload?.result ?? { summary_for_user: 'Previously published task result.' });
    if (current.state === 'WAITING_HUMAN') return { state: 'WAITING_HUMAN', task: current };
    if (current.state === 'FAILED') {
      if (current.attempt >= current.maxAttempts) {
        const held = await selectedRepository.updateRun(run.runId, { state: 'HOLD', statusReason: `task ${current.taskId} exhausted retries` }, { eventType: 'TASK_RETRY_EXHAUSTED', eventPayload: { task_id: current.taskId } });
        await announce(held, 'TASK_RETRY_EXHAUSTED', { task_id: current.taskId, error: current.lastError }, current.taskId);
        return { state: 'HOLD', run: held };
      }
      const retry = await selectedRepository.updateTask(current.taskId, { state: 'READY', attempt: current.attempt + 1, lastError: current.lastError, contextManifest: {} }, { eventType: 'TASK_RETRY_READY', eventPayload: { next_attempt: current.attempt + 1 } });
      await announce(run, 'TASK_RETRY_READY', { task_id: retry.taskId, attempt: retry.attempt }, retry.taskId);
      return { state: 'READY', task: retry };
    }
    if (current.state !== 'READY') return { state: current.state, task: current };
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
    await announce(run, 'TASK_STARTED', { task_id: task.taskId, agent_id: task.agentId, step_id: task.stepId }, task.taskId);
    const dispatchRoot = join(task.artifactRootAbs, '.orchestrator'); mkdirSync(dispatchRoot, { recursive: true });
    const messagePath = join(dispatchRoot, `attempt-${task.attempt}.message.md`); atomicWriteFile(messagePath, taskMessage(task));
    atomicWriteJson(join(dispatchRoot, `attempt-${task.attempt}.dispatch.json`), { schema_version: 1, execution_id: execution.executionId, session_id: sessionId, message_path_abs: messagePath, started_at: now(clock) });
    try {
      const result = await runner({ agentId: task.agentId, sessionId, messagePath, timeoutSeconds });
      processLog(task, `attempt-${task.attempt}.stdout.log`, result.stdout); processLog(task, `attempt-${task.attempt}.stderr.log`, result.stderr);
      if (result.exitCode !== 0) throw Object.assign(new Error(`OpenClaw Agent exited with ${result.exitCode}`), { code: 'OPENCLAW_AGENT_EXIT_NONZERO', details: { stderr: String(result.stderr ?? '').slice(-4000) } });
      const ingested = ingestTaskOutput({ projectRoot, task, occurredAt: now(clock) });
      await selectedKernel.lease.releaseLease({ executionId: execution.executionId, state: 'SUCCEEDED', exitCode: result.exitCode });
      const payload = { ...(current.payload ?? {}), result: ingested.value, published_output_path_abs: ingested.outputPath, ingestion_receipt_path_abs: ingested.receiptPath, session_id: sessionId };
      const completed = await selectedRepository.updateTask(task.taskId, { state: 'SUCCEEDED', payload }, { eventType: 'TASK_SUCCEEDED', eventPayload: { result_status: ingested.value.result_status, output_path_abs: ingested.outputPath } });
      await selectedRepository.registerArtifact({ runId: run.runId, taskId: task.taskId, executionId: execution.executionId, kind: 'RESULT', uri: ingested.outputPath, sha256: sha256File(ingested.outputPath), sizeBytes: 0, mediaType: 'application/json' });
      await selectedRepository.registerArtifact({ runId: run.runId, taskId: task.taskId, executionId: execution.executionId, kind: 'INGESTION_RECEIPT', uri: ingested.receiptPath, sha256: sha256File(ingested.receiptPath), sizeBytes: 0, mediaType: 'application/json' });
      if (ingested.value.result_status === 'HUMAN_DECISION_REQUIRED') {
        const request = approvalRequest(task, ingested.value);
        await selectedRepository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: request.trigger, request });
        await announce(run, 'HUMAN_APPROVAL_REQUIRED', { approval: request, result_summary: ingested.value.summary_for_user }, task.taskId);
        return { state: 'WAITING_HUMAN', task: completed };
      }
      if (['NEEDS_REWORK', 'BLOCKED', 'FAILED'].includes(ingested.value.result_status)) {
        const failed = await selectedRepository.updateTask(task.taskId, { state: 'FAILED', lastError: { code: `AGENT_${ingested.value.result_status}`, summary: ingested.value.summary_for_manager } }, { eventType: 'TASK_REWORK_OR_FAILURE', eventPayload: { result_status: ingested.value.result_status } });
        await announce(run, ingested.value.result_status === 'NEEDS_REWORK' ? 'TASK_REWORK_REQUESTED' : 'TASK_FAILED', { task_id: task.taskId, result_status: ingested.value.result_status, summary: ingested.value.summary_for_user }, task.taskId);
        await queueDailyReport(run, failed, ingested.value.result_status);
        return { state: 'FAILED', task: failed };
      }
      return advanceAfterSuccess(run, completed, ingested.value);
    } catch (error) {
      await selectedKernel.lease.releaseLease({ executionId: execution.executionId, state: 'FAILED', exitCode: 1, error: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message } });
      const receipt = writeFailureReceipt(task, error, now(clock));
      const failed = await selectedRepository.updateTask(task.taskId, { state: 'FAILED', lastError: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message, receipt_path_abs: receipt } }, { eventType: 'TASK_FAILED', eventPayload: { code: error.code ?? 'TASK_EXECUTION_FAILED', message: error.message } });
      await announce(run, 'TASK_FAILED', { task_id: task.taskId, agent_id: task.agentId, error: failed.lastError }, task.taskId);
      await queueDailyReport(run, failed, 'FAILED');
      return { state: 'FAILED', task: failed };
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
    const runs = await selectedRepository.listRuns(); const results = [];
    for (const run of runs) if (run.state === 'ACTIVE') results.push(await tick(run.workflowId));
    await deliverNotifications(); return results;
  }

  async function decide(request) {
    const run = await selectedRepository.getRun(request.workflow_id);
    if (!run) throw Object.assign(new Error(`workflow not found: ${request.workflow_id}`), { code: 'WORKFLOW_NOT_FOUND' });
    if (run.managerSessionId !== request.manager_session_id || run.managerSessionKey !== request.manager_session_key) throw Object.assign(new Error('decision session does not match workflow origin'), { code: 'MANAGER_SESSION_MISMATCH' });
    const approval = await selectedRepository.resolveApproval({ decisionId: request.decision_id, response: { outcome: request.choice, notes: request.notes ?? '', actor: request.user_authorized.actor, decided_at: request.submitted_at ?? now(clock) } });
    const task = approval.taskId ? await selectedRepository.getTask(approval.taskId) : null;
    if (['CANCEL', 'ABORT', 'REJECTED'].includes(request.choice)) {
      if (task) {
        const cancelled = await selectedRepository.updateTask(task.taskId, { state: 'CANCELLED' }, { eventType: 'TASK_CANCELLED_BY_HUMAN', eventPayload: { decision_id: approval.decisionId } });
        await queueDailyReport(run, cancelled, 'CANCELLED');
      }
      return finishRun(run, 'CANCELLED', 'user declined an approval through Manager');
    }
    if (['REWORK', 'REVISE'].includes(request.choice) && task) {
      await selectedRepository.updateTask(task.taskId, { state: 'READY', attempt: task.attempt + 1, contextManifest: {} }, { eventType: 'TASK_REWORK_APPROVED', eventPayload: { decision_id: approval.decisionId } });
      const active = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', statusReason: 'user requested rework' }, { eventType: 'WORKFLOW_RESUMED', eventPayload: { decision_id: approval.decisionId } });
      await announce(active, 'TASK_REWORK_APPROVED', { task_id: task.taskId, decision_id: approval.decisionId }, task.taskId);
      return active;
    }
    const nextIndex = run.currentStepIndex + 1;
    const resumed = await selectedRepository.updateRun(run.runId, { state: 'ACTIVE', currentStepIndex: nextIndex, statusReason: 'human approval accepted' }, { eventType: 'WORKFLOW_RESUMED', eventPayload: { decision_id: approval.decisionId, choice: request.choice } });
    await announce(resumed, 'HUMAN_APPROVAL_RESOLVED', { decision_id: approval.decisionId, choice: request.choice }, task?.taskId ?? null);
    return nextIndex >= run.routePlan.steps.length ? finishRun(resumed, 'SUCCEEDED', 'all route steps approved') : resumed;
  }

  async function close() { if (ownedPool) await selectedPool.end(); }
  function attachHrService(value) { hrService = value; return hrService; }
  return { projectRoot, repository: selectedRepository, kernel: selectedKernel, createRun, reviseRun, decide, tick, tickAll, deliverNotifications, attachHrService, close };
}
