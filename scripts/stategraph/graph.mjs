import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { END, START, StateGraph } from '@langchain/langgraph';
import { WorkflowState } from './state.mjs';
import { appendStateEvent } from './events.mjs';
import { buildLocalGate } from './output-ingestion.mjs';
import { compileRoutePlan, routePlanApprovalRequest, verifyFrozenRoute } from './policy.mjs';
import { createCompactManagerContext } from './manager-context.mjs';

function now(dependencies) {
  return dependencies.clock().toISOString();
}

function taskIndex(state, taskId = state.activeTaskId) {
  return (state.tasks ?? []).findIndex((task) => task.task_id === taskId);
}

function replaceTask(state, task) {
  const tasks = [...(state.tasks ?? [])];
  const index = taskIndex(state, task.task_id);
  if (index < 0) tasks.push(task);
  else tasks[index] = task;
  return tasks;
}

function sanitized(value) {
  return String(value).replaceAll(/[^A-Za-z0-9-]/gu, '-').replaceAll(/-+/gu, '-').slice(0, 80);
}

function runId(task, attempt = task.attempt, manualBatch = task.manual_retry_batch ?? 0) {
  return `RUN-${sanitized(task.task_id.slice(5))}${manualBatch ? `-M${manualBatch}` : ''}-A${attempt}`;
}

function approvalForStep(state, step, task, occurredAt) {
  return {
    decision_id: `DEC-${sanitized(state.workflowId.slice(3))}-${step.step_id}-${state.revision + 1}`,
    kind: 'STEP_CONFIRMATION',
    node_id: `approval-after-${step.step_id}`,
    route_hash: state.routePlan.route_hash,
    step_id: step.step_id,
    task_id: task.task_id,
    candidate_commit: ['DEVELOPMENT', 'TEST'].includes(task.kind) ? task.result?.output_commit ?? state.candidateCommit : state.candidateCommit,
    title: `确认 ${step.title}`,
    question: step.approval_reason,
    options: [
      { id: 'APPROVE', label: '确认并继续' },
      { id: 'REWORK', label: '由同一 Agent 重做' },
      { id: 'ABORT', label: '终止本轮' },
    ],
    status: 'PENDING',
    requested_at: occurredAt,
  };
}

function bindRunPaths(task, dependencies) {
  task.artifact_root_abs = join(dependencies.projectRoot, 'runtime', 'artifacts', task.workflow_id, task.task_id, 'runs', task.run_id);
  task.worktree_path_abs = dependencies.worktrees.pathFor(task);
  task.context_manifest_path_abs = null;
  task.context_manifest_sha256 = null;
  task.sandbox_attestation = null;
  return task;
}

function candidatePatch(state, task, occurredAt) {
  if (!['DEVELOPMENT', 'TEST'].includes(task.kind) || !task.result?.output_commit || task.result.output_commit === state.candidateCommit) return {};
  return {
    candidateCommit: task.result.output_commit,
    candidateHistory: [...(state.candidateHistory ?? []), {
      task_id: task.task_id,
      run_id: task.run_id,
      kind: task.kind,
      from_commit: state.candidateCommit,
      to_commit: task.result.output_commit,
      accepted_at: occurredAt,
    }],
  };
}

function errorApproval(state, task, error, occurredAt) {
  return {
    decision_id: `DEC-${sanitized(state.workflowId.slice(3))}-${sanitized(task.task_id.slice(5))}-ERROR-${state.revision + 1}`,
    kind: 'ERROR_ESCALATION',
    node_id: `error-after-${task.task_id}`,
    route_hash: state.routePlan?.route_hash ?? null,
    task_id: task.task_id,
    title: `${task.agent_id} 连续三次执行失败`,
    question: '自动重试预算已耗尽，需要人工决定是否开启同一 Agent 的新重试批次。',
    error,
    options: [
      { id: 'RETRY_SAME_AGENT', label: '同一 Agent 再重试' },
      { id: 'ABORT', label: '终止本轮' },
    ],
    status: 'PENDING',
    requested_at: occurredAt,
  };
}

function agentDecisionApproval(state, task, occurredAt) {
  return {
    decision_id: `DEC-${sanitized(state.workflowId.slice(3))}-${sanitized(task.task_id.slice(5))}-AGENT-${state.revision + 1}`,
    kind: 'AGENT_DECISION',
    node_id: `agent-decision-${task.task_id}`,
    route_hash: state.routePlan.route_hash,
    task_id: task.task_id,
    title: `${task.agent_id} 请求人工决定`,
    question: task.result.summary_for_user,
    decisions_required: task.result.decisions_required ?? [],
    options: [
      { id: 'REWORK', label: '携带人工决定由同一 Agent 重做并重新过 Gate' },
      { id: 'ABORT', label: '终止本轮' },
    ],
    status: 'PENDING',
    requested_at: occurredAt,
  };
}

function failurePatch(state, taskInput, error, dependencies) {
  const occurredAt = now(dependencies);
  const task = structuredClone(taskInput);
  const report = {
    report_id: `MGR-ERR-${sanitized(task.task_id.slice(5))}-${task.attempt}-${state.revision + 1}`,
    workflow_id: state.workflowId,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.agent_id,
    attempt: task.attempt,
    error,
    reported_at: occurredAt,
    automatic_retry: task.attempt < dependencies.policy.agent_attempts,
  };
  task.attempt_history = [...(task.attempt_history ?? []), {
    run_id: task.run_id,
    attempt: task.attempt,
    json_regenerations: task.json_regenerations ?? 0,
    worktree_path_abs: task.worktree_path_abs,
    artifact_root_abs: task.artifact_root_abs,
    context_manifest_sha256: task.context_manifest_sha256 ?? null,
    error,
    failed_at: occurredAt,
  }];
  if (task.attempt < dependencies.policy.agent_attempts) {
    task.attempt += 1;
    task.run_id = runId(task);
    bindRunPaths(task, dependencies);
    task.session_id = null;
    task.status = 'READY';
    task.current_cycle = null;
    task.json_regenerations = 0;
    task.last_error = error;
    task.result = null;
    task.output_path_abs = null;
    task.ingestion_receipt_path_abs = null;
    task.updated_at = occurredAt;
    return appendStateEvent(state, {
      tasks: replaceTask(state, task),
      managerReports: [...(state.managerReports ?? []), report],
      stopReason: 'AGENT_AUTO_RETRY_READY',
      action: 'finish',
    }, 'AGENT_ATTEMPT_FAILED', { task_id: task.task_id, agent_id: task.agent_id, failed_attempt: task.attempt - 1, next_attempt: task.attempt, error }, occurredAt);
  }
  task.status = 'WAITING_HUMAN';
  task.last_error = error;
  task.updated_at = occurredAt;
  const pendingApproval = errorApproval(state, task, error, occurredAt);
  return appendStateEvent(state, {
    tasks: replaceTask(state, task),
    managerReports: [...(state.managerReports ?? []), report],
    pendingApproval,
    condition: 'WAITING_HUMAN',
    phase: 'HUMAN_APPROVAL',
    stopReason: 'AGENT_RETRY_BUDGET_EXHAUSTED',
    action: 'finish',
  }, 'AGENT_ERROR_ESCALATED', { task_id: task.task_id, agent_id: task.agent_id, attempts: task.attempt, decision_id: pendingApproval.decision_id, error }, occurredAt);
}

function createTask(state, { kind, stepId, title, prompt, executionRound = 1 }, dependencies) {
  const suffix = kind === 'MANAGER_ANALYSIS' ? `manager-${(state.tasks ?? []).filter((task) => task.kind === kind).length + 1}` : `${stepId}-R${executionRound}`;
  const taskId = `TASK-${sanitized(state.workflowId.slice(3))}-${sanitized(suffix)}`;
  const task = {
    schema_version: 1,
    workflow_id: state.workflowId,
    task_id: taskId,
    run_id: null,
    step_id: stepId,
    kind,
    title,
    prompt,
    agent_id: dependencies.policy.task_agents[kind],
    attempt: 1,
    max_attempts: dependencies.policy.agent_attempts,
    manual_retry_batch: 0,
    json_regenerations: 0,
    max_json_regenerations: dependencies.policy.json_regeneration_retries,
    status: 'READY',
    session_id: null,
    current_cycle: null,
    required_gate_checks: dependencies.policy.gate_checks[kind] ?? [],
    input_commit: state.candidateCommit,
    target_project_root_abs: state.targetProjectRootAbs,
    route_hash: state.routePlan?.route_hash ?? null,
    worktree_path_abs: null,
    artifact_root_abs: null,
    dispatches: [],
    attempt_history: [],
    result: null,
    created_at: now(dependencies),
    updated_at: now(dependencies),
  };
  task.run_id = runId(task);
  return bindRunPaths(task, dependencies);
}

export function createWorkflowNodes(dependencies) {
  return {
    initialize(state) {
      if (state.createdAt) return { stopReason: null };
      const occurredAt = now(dependencies);
      if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(state.workflowId ?? '')) throw Object.assign(new Error('workflowId must start with WF-'), { code: 'WORKFLOW_ID_INVALID' });
      if (!state.request || typeof state.request.text !== 'string' || !state.request.text.trim()) throw Object.assign(new Error('initial request.text is required'), { code: 'WORKFLOW_REQUEST_REQUIRED' });
      if (!isAbsolute(state.request.project_path_abs ?? '') || !existsSync(state.request.project_path_abs)) throw Object.assign(new Error('request.project_path_abs must be an existing absolute path'), { code: 'WORKFLOW_PROJECT_PATH_INVALID' });
      const target = dependencies.worktrees.inspectTarget(state.request.project_path_abs);
      return appendStateEvent(state, {
        schemaVersion: 1,
        createdAt: occurredAt,
        phase: 'MANAGER_ANALYSIS',
        condition: 'ACTIVE',
        outcome: null,
        statusReason: '需求等待 Manager 生成动态路线',
        targetProjectRootAbs: target.target_project_root_abs,
        baseCommit: target.head_commit,
        candidateCommit: target.head_commit,
        candidateHistory: [],
        routePlan: null,
        approvalPlan: [],
        pendingApproval: null,
        steps: [],
        currentStepIndex: 0,
        tasks: [],
        activeTaskId: null,
        events: [],
        managerReports: [],
        stopReason: null,
      }, 'WORKFLOW_CREATED', { request_sha256: dependencies.sha256(state.request), project_path_abs: target.target_project_root_abs, base_commit: target.head_commit }, occurredAt);
    },

    decide(state) {
      if (state.routePlan?.status === 'FROZEN' && !verifyFrozenRoute(state.routePlan)) return { action: 'integrity_hold' };
      if (state.operatorCommand) return { action: state.pendingApproval ? 'apply_human' : 'integrity_hold' };
      if (['TERMINAL', 'HOLD'].includes(state.condition)) return { action: 'finish' };
      if (state.condition === 'WAITING_HUMAN' || state.pendingApproval) return { action: 'finish', stopReason: 'WAITING_HUMAN' };
      const active = state.tasks?.find((task) => task.task_id === state.activeTaskId);
      if (active) {
        if (['READY', 'REPAIR_READY'].includes(active.status)) return { action: 'dispatch' };
        if (['DISPATCHED', 'STARTING', 'RUNNING'].includes(active.status)) return { action: 'reconcile' };
        if (active.status === 'SUCCEEDED') return { action: active.kind === 'MANAGER_ANALYSIS' ? 'compile_plan' : 'evaluate' };
      }
      if (!state.routePlan) return { action: 'prepare_manager' };
      if (state.routePlan.status !== 'FROZEN') return { action: 'finish', stopReason: 'ROUTE_PLAN_NOT_FROZEN' };
      if (state.currentStepIndex >= state.steps.length) return { action: 'complete' };
      return { action: 'prepare_step' };
    },

    prepareManager(state) {
      const context = createCompactManagerContext(state, dependencies.policy);
      const task = createTask(state, {
        kind: 'MANAGER_ANALYSIS',
        stepId: 'manager-analysis',
        title: '分析用户需求并提出本轮动态路线',
        prompt: `用户需求：\n${state.request.text}\n\n代码可见紧凑状态：\n${JSON.stringify(context, null, 2)}`,
      }, dependencies);
      return appendStateEvent(state, { tasks: [...state.tasks, task], activeTaskId: task.task_id, phase: 'MANAGER_ANALYSIS', stopReason: 'MANAGER_TASK_READY' },
        'TASK_PREPARED', { task_id: task.task_id, kind: task.kind, agent_id: task.agent_id }, now(dependencies));
    },

    prepareStep(state) {
      const step = state.steps[state.currentStepIndex];
      const task = createTask(state, {
        kind: step.kind,
        stepId: step.step_id,
        title: step.title,
        executionRound: step.execution_round,
        prompt: `已冻结 route_hash: ${state.routePlan.route_hash}\n需求摘要：${state.routePlan.summary}\n本阶段理由：${step.rationale}\n原始用户需求：${state.request.text}`,
      }, dependencies);
      const steps = state.steps.map((item, index) => index === state.currentStepIndex ? { ...item, status: 'RUNNING', task_id: task.task_id } : item);
      return appendStateEvent(state, { tasks: [...state.tasks, task], steps, activeTaskId: task.task_id, phase: step.kind, stopReason: 'TASK_READY' },
        'TASK_PREPARED', { task_id: task.task_id, step_id: step.step_id, kind: step.kind, agent_id: task.agent_id, route_hash: state.routePlan.route_hash }, now(dependencies));
    },

    async dispatch(state) {
      const task = state.tasks[taskIndex(state)];
      try {
        const started = await dependencies.dispatcher.start(task);
        return appendStateEvent(state, { tasks: replaceTask(state, started), stopReason: 'TASK_DISPATCHED' }, 'TASK_DISPATCHED', {
          task_id: started.task_id,
          run_id: started.run_id,
          agent_id: started.agent_id,
          attempt: started.attempt,
          cycle: started.current_cycle,
          context_manifest_sha256: started.context_manifest_sha256,
          input_commit: started.input_commit,
        }, now(dependencies));
      } catch (error) {
        if (error.code === 'SANDBOX_GLOBAL_BUSY') {
          return appendStateEvent(state, { stopReason: 'SANDBOX_DISPATCH_DEFERRED' }, 'TASK_DISPATCH_DEFERRED', {
            task_id: task.task_id, run_id: task.run_id, reason: error.code,
          }, now(dependencies));
        }
        return failurePatch(state, task, { code: error.code ?? 'DISPATCH_PREPARATION_FAILED', message: error.message, details: error.details ?? null }, dependencies);
      }
    },

    reconcile(state) {
      const task = state.tasks[taskIndex(state)];
      const result = dependencies.dispatcher.reconcile(task);
      if (result.kind === 'WAITING') {
        const changed = result.task.status !== task.status;
        if (!changed) return { stopReason: 'TASK_RUNNING' };
        return appendStateEvent(state, { tasks: replaceTask(state, result.task), stopReason: 'TASK_RUNNING' }, 'TASK_RUNNING', { task_id: task.task_id, run_id: task.run_id }, now(dependencies));
      }
      if (result.kind === 'JSON_REPAIR') {
        const report = {
          report_id: `MGR-JSON-${sanitized(task.task_id.slice(5))}-${task.attempt}-${result.task.json_regenerations}`,
          workflow_id: state.workflowId,
          task_id: task.task_id,
          run_id: task.run_id,
          agent_id: task.agent_id,
          attempt: task.attempt,
          error: result.error,
          reported_at: now(dependencies),
          automatic_json_regeneration: true,
        };
        return appendStateEvent(state, {
          tasks: replaceTask(state, result.task),
          managerReports: [...state.managerReports, report],
          stopReason: 'JSON_REPAIR_READY',
        }, 'AGENT_JSON_REGEN_REQUESTED', { task_id: task.task_id, attempt: task.attempt, regeneration: result.task.json_regenerations, max: task.max_json_regenerations, error: result.error }, now(dependencies));
      }
      if (result.kind === 'ERROR') return failurePatch(state, result.task, { code: result.code, message: result.message, details: result.details ?? null }, dependencies);
      return appendStateEvent(state, { tasks: replaceTask(state, result.task), stopReason: 'TASK_OUTPUT_ACCEPTED' }, 'TASK_OUTPUT_ACCEPTED', {
        task_id: result.task.task_id,
        run_id: result.task.run_id,
        agent_id: result.task.agent_id,
        attempt: result.task.attempt,
        json_regenerations: result.task.json_regenerations,
      }, now(dependencies));
    },

    compilePlan(state) {
      const task = state.tasks[taskIndex(state)];
      try {
        const plan = compileRoutePlan(dependencies.projectRoot, task.result, dependencies.policy);
        if (plan.workflow_id !== state.workflowId) throw Object.assign(new Error('route plan is bound to another workflow'), { code: 'ROUTE_PLAN_WORKFLOW_MISMATCH' });
        const occurredAt = now(dependencies);
        const pendingApproval = routePlanApprovalRequest(plan, occurredAt);
        const acceptedTask = { ...task, status: 'ACCEPTED', updated_at: occurredAt };
        return appendStateEvent(state, {
          routePlan: plan,
          approvalPlan: plan.approval_plan,
          pendingApproval,
          condition: 'WAITING_HUMAN',
          phase: 'HUMAN_APPROVAL',
          tasks: replaceTask(state, acceptedTask),
          activeTaskId: null,
          stopReason: 'ROUTE_PLAN_APPROVAL_REQUIRED',
        }, 'ROUTE_PLAN_PROPOSED', { route_hash: plan.route_hash, decision_id: pendingApproval.decision_id, approval_nodes: plan.approval_plan }, occurredAt);
      } catch (error) {
        return failurePatch(state, task, { code: error.code ?? 'ROUTE_PLAN_INVALID', message: error.message, details: error.details ?? null }, dependencies);
      }
    },

    evaluate(state) {
      const task = state.tasks[taskIndex(state)];
      const occurredAt = now(dependencies);
      if (task.result?.result_status === 'HUMAN_DECISION_REQUIRED') {
        const pendingApproval = agentDecisionApproval(state, task, occurredAt);
        const waitingTask = { ...task, status: 'WAITING_HUMAN', updated_at: occurredAt };
        return appendStateEvent(state, { tasks: replaceTask(state, waitingTask), pendingApproval, condition: 'WAITING_HUMAN', phase: 'HUMAN_APPROVAL', stopReason: 'AGENT_DECISION_REQUIRED' },
          'HUMAN_APPROVAL_REQUESTED', { task_id: task.task_id, decision_id: pendingApproval.decision_id, route_hash: state.routePlan.route_hash }, occurredAt);
      }
      const { gate, path } = buildLocalGate(task, task.result, dependencies.policy.gate_checks[task.kind] ?? [], occurredAt, { worktrees: dependencies.worktrees });
      if (gate.overall !== 'PASS') return failurePatch(state, task, { code: 'LOCAL_GATE_FAILED', message: gate.overall_reason, gate_path_abs: path, items: gate.items }, dependencies);
      const step = state.steps[state.currentStepIndex];
      const acceptedTask = { ...task, status: 'ACCEPTED', local_gate: gate, local_gate_path_abs: path, updated_at: occurredAt };
      if (step.human_approval_after) {
        const pendingApproval = approvalForStep(state, step, task, occurredAt);
        const steps = state.steps.map((item, index) => index === state.currentStepIndex ? { ...item, status: 'WAITING_HUMAN' } : item);
        return appendStateEvent(state, { tasks: replaceTask(state, acceptedTask), steps, activeTaskId: null, pendingApproval, condition: 'WAITING_HUMAN', phase: 'HUMAN_APPROVAL', stopReason: 'STEP_APPROVAL_REQUIRED' },
          'HUMAN_APPROVAL_REQUESTED', { task_id: task.task_id, step_id: step.step_id, decision_id: pendingApproval.decision_id, route_hash: state.routePlan.route_hash }, occurredAt);
      }
      const steps = state.steps.map((item, index) => index === state.currentStepIndex ? { ...item, status: 'COMPLETED', completed_at: occurredAt } : item);
      const candidate = candidatePatch(state, task, occurredAt);
      return appendStateEvent(state, { tasks: replaceTask(state, acceptedTask), steps, activeTaskId: null, currentStepIndex: state.currentStepIndex + 1, phase: 'ROUTING', stopReason: 'STEP_COMPLETED', ...candidate },
        'STEP_COMPLETED', { task_id: task.task_id, step_id: step.step_id, route_hash: state.routePlan.route_hash, gate_path_abs: path, candidate_commit: candidate.candidateCommit ?? state.candidateCommit }, occurredAt);
    },

    applyHuman(state) {
      const command = state.operatorCommand;
      const pending = state.pendingApproval;
      const occurredAt = now(dependencies);
      if (!command || command.decision_id !== pending.decision_id) return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批命令未绑定当前节点', stopReason: 'APPROVAL_BINDING_INVALID' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_BINDING_INVALID' }, occurredAt);
      if (!/^human:[A-Za-z0-9._-]+$/u.test(command.decided_by ?? '')) return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批者不是明确人工身份', stopReason: 'APPROVAL_ACTOR_INVALID' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_ACTOR_INVALID' }, occurredAt);
      if (!pending.options.some((option) => option.id === command.choice)) return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批选项不在代码定义范围', stopReason: 'APPROVAL_CHOICE_INVALID' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_CHOICE_INVALID' }, occurredAt);
      if (pending.route_hash && pending.route_hash !== state.routePlan?.route_hash) return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批绑定的路线哈希已变化', stopReason: 'APPROVAL_ROUTE_HASH_MISMATCH' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_ROUTE_HASH_MISMATCH' }, occurredAt);

      if (command.choice === 'ABORT') return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'TERMINAL', phase: 'TERMINAL', outcome: 'ABORTED', statusReason: command.notes ?? '人工终止', stopReason: 'ABORTED' }, 'WORKFLOW_ABORTED', { decision_id: pending.decision_id, decided_by: command.decided_by }, occurredAt);
      if (pending.kind === 'ROUTE_PLAN_CONFIRMATION') {
        if (command.choice === 'REVISE') {
          return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'ACTIVE', phase: 'MANAGER_ANALYSIS', routePlan: null, approvalPlan: [], steps: [], currentStepIndex: 0, activeTaskId: null, request: { ...state.request, human_revision_note: command.notes ?? '' }, stopReason: 'ROUTE_REANALYSIS_REQUIRED' },
            'ROUTE_PLAN_REJECTED', { decision_id: pending.decision_id, decided_by: command.decided_by, notes: command.notes ?? '' }, occurredAt);
        }
        const plan = { ...state.routePlan, status: 'FROZEN', frozen_at: occurredAt, frozen_by: command.decided_by };
        const approvalPlan = state.approvalPlan.map((item) => item.node_id === pending.node_id ? { ...item, status: 'APPROVED', decision_id: pending.decision_id, decided_at: occurredAt } : item);
        return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'ACTIVE', phase: 'ROUTING', routePlan: plan, approvalPlan, steps: plan.steps, currentStepIndex: 0, stopReason: 'ROUTE_PLAN_FROZEN' },
          'ROUTE_PLAN_FROZEN', { route_hash: plan.route_hash, decision_id: pending.decision_id, decided_by: command.decided_by, approval_nodes: approvalPlan }, occurredAt);
      }
      if (pending.kind === 'ERROR_ESCALATION' && command.choice === 'RETRY_SAME_AGENT') {
        const task = structuredClone(state.tasks.find((item) => item.task_id === pending.task_id));
        task.manual_retry_batch = (task.manual_retry_batch ?? 0) + 1;
        task.attempt = 1;
        task.run_id = runId(task);
        bindRunPaths(task, dependencies);
        task.session_id = null;
        task.status = 'READY';
        task.json_regenerations = 0;
        task.current_cycle = null;
        task.result = null;
        task.output_path_abs = null;
        task.ingestion_receipt_path_abs = null;
        task.updated_at = occurredAt;
        return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'ACTIVE', phase: task.kind, tasks: replaceTask(state, task), activeTaskId: task.task_id, stopReason: 'MANUAL_RETRY_READY' },
          'HUMAN_RETRY_APPROVED', { decision_id: pending.decision_id, task_id: task.task_id, agent_id: task.agent_id, manual_retry_batch: task.manual_retry_batch, decided_by: command.decided_by }, occurredAt);
      }
      if (['STEP_CONFIRMATION', 'AGENT_DECISION'].includes(pending.kind)) {
        const step = state.steps[state.currentStepIndex];
        if (command.choice === 'REWORK') {
          const steps = state.steps.map((item, index) => index === state.currentStepIndex ? { ...item, status: 'PENDING', execution_round: item.execution_round + 1, task_id: null } : item);
          return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'ACTIVE', phase: 'ROUTING', steps, activeTaskId: null, stopReason: 'STEP_REWORK_READY' },
            'STEP_REWORK_APPROVED', { decision_id: pending.decision_id, step_id: step.step_id, agent_id: step.agent_id, decided_by: command.decided_by }, occurredAt);
        }
        const steps = state.steps.map((item, index) => index === state.currentStepIndex ? { ...item, status: 'COMPLETED', completed_at: occurredAt } : item);
        const approvalPlan = state.approvalPlan.map((item) => item.node_id === pending.node_id ? { ...item, status: 'APPROVED', decision_id: pending.decision_id, decided_at: occurredAt } : item);
        const task = state.tasks.find((item) => item.task_id === pending.task_id) ?? state.tasks.find((item) => item.task_id === step.task_id);
        const candidate = task ? candidatePatch(state, task, occurredAt) : {};
        if (pending.candidate_commit && candidate.candidateCommit && pending.candidate_commit !== candidate.candidateCommit) {
          return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批绑定候选提交与任务结果不一致', stopReason: 'APPROVAL_CANDIDATE_MISMATCH' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_CANDIDATE_MISMATCH' }, occurredAt);
        }
        return appendStateEvent(state, { operatorCommand: null, pendingApproval: null, condition: 'ACTIVE', phase: 'ROUTING', steps, approvalPlan, activeTaskId: null, currentStepIndex: state.currentStepIndex + 1, stopReason: 'STEP_APPROVED', ...candidate },
          'HUMAN_APPROVAL_RESOLVED', { decision_id: pending.decision_id, step_id: step.step_id, route_hash: state.routePlan.route_hash, decided_by: command.decided_by, candidate_commit: candidate.candidateCommit ?? state.candidateCommit }, occurredAt);
      }
      return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '审批类型与选项组合未被代码允许', stopReason: 'APPROVAL_TRANSITION_INVALID' }, 'INTEGRITY_HOLD', { code: 'APPROVAL_TRANSITION_INVALID', kind: pending.kind, choice: command.choice }, occurredAt);
    },

    complete(state) {
      return appendStateEvent(state, { condition: 'TERMINAL', phase: 'TERMINAL', outcome: 'COMPLETED', statusReason: '冻结路线的全部阶段与审批节点均已完成', stopReason: 'COMPLETED' },
        'WORKFLOW_COMPLETED', { route_hash: state.routePlan.route_hash, completed_steps: state.steps.map((step) => step.step_id) }, now(dependencies));
    },

    integrityHold(state) {
      return appendStateEvent(state, { operatorCommand: null, condition: 'HOLD', phase: 'HOLD', statusReason: '冻结路线或操作命令完整性校验失败', stopReason: 'STATE_INTEGRITY_HOLD' },
        'INTEGRITY_HOLD', { code: 'STATE_INTEGRITY_HOLD' }, now(dependencies));
    },

    finish() { return {}; },
  };
}

export function buildWorkflowGraph(dependencies, { checkpointer } = {}) {
  const nodes = createWorkflowNodes(dependencies);
  return new StateGraph(WorkflowState)
    .addNode('initialize', nodes.initialize)
    .addNode('decide', nodes.decide)
    .addNode('prepare_manager', nodes.prepareManager)
    .addNode('prepare_step', nodes.prepareStep)
    .addNode('dispatch', nodes.dispatch)
    .addNode('reconcile', nodes.reconcile)
    .addNode('compile_plan', nodes.compilePlan)
    .addNode('evaluate', nodes.evaluate)
    .addNode('apply_human', nodes.applyHuman)
    .addNode('complete', nodes.complete)
    .addNode('integrity_hold', nodes.integrityHold)
    .addNode('finish', nodes.finish)
    .addEdge(START, 'initialize')
    .addEdge('initialize', 'decide')
    .addConditionalEdges('decide', (state) => state.action, {
      prepare_manager: 'prepare_manager',
      prepare_step: 'prepare_step',
      dispatch: 'dispatch',
      reconcile: 'reconcile',
      compile_plan: 'compile_plan',
      evaluate: 'evaluate',
      apply_human: 'apply_human',
      complete: 'complete',
      integrity_hold: 'integrity_hold',
      finish: 'finish',
    })
    .addEdge('prepare_manager', END)
    .addEdge('prepare_step', END)
    .addEdge('dispatch', END)
    .addEdge('reconcile', END)
    .addEdge('compile_plan', END)
    .addEdge('evaluate', END)
    .addEdge('apply_human', END)
    .addEdge('complete', END)
    .addEdge('integrity_hold', END)
    .addEdge('finish', END)
    .compile({ checkpointer });
}
