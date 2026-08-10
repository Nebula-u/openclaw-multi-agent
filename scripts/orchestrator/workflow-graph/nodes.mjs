function finish(status, stopReason, extra = {}) {
  return { route: 'finish', status, stopReason, ...extra };
}

function holdDecision(reason) {
  return {
    route: 'apply',
    status: 'HOLD',
    stopReason: reason,
    action: 'HOLD',
    command: { command_type: 'HOLD', reason, payload: { graph_stop_reason: reason } },
  };
}

function advanceDecision(targetPhase, reason, payload = {}) {
  return {
    route: 'apply',
    status: 'PROGRESSED',
    stopReason: null,
    action: 'ADVANCE_PHASE',
    nextPhase: targetPhase,
    command: { command_type: 'ADVANCE_PHASE', target_phase: targetPhase, reason, payload },
  };
}

function taskState(adapter, task) {
  return { currentTask: task, taskResult: task ? adapter.taskResult(task.run_id) : null };
}

function recomputeGate(items) {
  if (items.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (items.some((item) => item.status === 'HOLD' || (item.blocking && item.status === 'UNKNOWN'))) return 'HOLD';
  return 'PASS';
}

function recomputeRelease(checks) {
  if (!checks.length || checks.some((check) => ['HOLD', 'UNKNOWN', 'NOT_APPLICABLE'].includes(check.status))) return 'HOLD';
  if (checks.some((check) => check.status === 'FAIL')) return 'NO_GO';
  return checks.every((check) => check.status === 'PASS') ? 'GO' : 'HOLD';
}

function releaseOutput(adapter, state) {
  const found = adapter.latestDeclaredOutput(state.workflowId, 'release-decision.schema.json');
  if (!found) return { error: 'GRAPH_RELEASE_DECISION_REQUIRED' };
  const value = found.value;
  if (value.workflow_id !== state.workflowId || value.task_id !== found.task.task_id || value.run_id !== found.task.run_id) {
    return { error: 'GRAPH_RELEASE_DECISION_BINDING_INVALID' };
  }
  if (value.candidate_commit !== state.control.current_candidate_commit) return { error: 'GRAPH_RELEASE_CANDIDATE_MISMATCH' };
  const recomputed = recomputeRelease(value.checks ?? []);
  if (value.verdict !== recomputed) return { error: 'GRAPH_RELEASE_VERDICT_MISMATCH' };
  return { found, value };
}

export function createGraphNodes({ adapter, policy, machine }) {
  return {
    loadControlState(state) {
      const audit = adapter.audit();
      const control = adapter.getWorkflow(state.workflowId);
      if (!control) throw Object.assign(new Error(`workflow does not exist: ${state.workflowId}`), { code: 'CONTROL_WORKFLOW_NOT_FOUND' });
      return {
        audit,
        control,
        snapshot: adapter.snapshot(state.workflowId),
        beforeRevision: control.revision,
        afterRevision: control.revision,
      };
    },

    classifyControl(state) {
      if (!state.audit.ok) return finish('HOLD', 'CONTROL_AUDIT_FAILED');
      if (state.control.condition === 'TERMINAL') return finish('TERMINAL', state.control.outcome);
      if (state.control.condition === 'WAITING_HUMAN') return finish('WAITING_HUMAN', 'CONTROL_WAITING_HUMAN');
      if (state.control.condition === 'HOLD') return finish('HOLD', 'CONTROL_ON_HOLD');
      return { route: 'phase' };
    },

    routePhase(state) {
      const phaseSpec = policy.phases[state.control.phase];
      const route = ({ intake: 'intake', task: 'task', gate: 'gate', triage: 'task', release: 'task', final: 'final' })[phaseSpec.kind];
      if (!route) throw Object.assign(new Error(`unsupported graph phase kind: ${phaseSpec.kind}`), { code: 'GRAPH_PHASE_KIND_UNSUPPORTED' });
      return { phaseSpec, route };
    },

    handleIntake(state) {
      const demoDecisionId = `DEC-${state.workflowId}-DEMO-FAST`;
      const demo = adapter.approvals(state.workflowId, 'RESOLVED').find((item) => item.decision_id === demoDecisionId
        && item.request?.trigger === 'IMPLEMENTATION_TRADEOFF'
        && item.response?.outcome !== 'REJECTED' && item.response?.chosen_option_id === 'DEMO_FAST');
      if (demo) return advanceDecision(state.phaseSpec.demo_fast_next, 'StateGraph 使用已解决的 DEMO_FAST 审批推进流程', { approval_decision_id: demo.decision_id });
      return advanceDecision(state.phaseSpec.standard_next, 'StateGraph 启动标准工作流');
    },

    async handleTask(state) {
      let task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
      let control = state.control;
      if (!task || ['CANCELLED', 'SUPERSEDED'].includes(task.status)) {
        return finish('NEEDS_TASK', `GRAPH_TASK_REQUIRED:${state.phaseSpec.task_type}`, { currentTask: task });
      }
      if (task.assigned_agent !== state.phaseSpec.agent) return { ...holdDecision('GRAPH_TASK_AGENT_MISMATCH'), ...taskState(adapter, task) };
      if (task.status === 'CREATED') {
        adapter.validateTask(task.task_id);
        task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
      }
      if (task.status === 'READY') {
        await adapter.dispatch(task.task_id);
        task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
        control = adapter.getWorkflow(state.workflowId);
      }
      const refreshed = { ...taskState(adapter, task), control, afterRevision: control.revision };
      if (['DISPATCHED', 'RUNNING'].includes(task.status)) return finish('RUNNING', `TASK_${task.status}`, refreshed);
      if (task.status === 'WAITING_HUMAN') return finish('WAITING_HUMAN', 'TASK_WAITING_HUMAN', refreshed);
      return { route: 'evaluate', ...refreshed };
    },

    evaluateTask(state) {
      const task = state.currentTask;
      if (task.status === 'BLOCKED') return holdDecision('GRAPH_TASK_BLOCKED');
      if (['FAILED', 'LOST'].includes(task.status)) {
        return state.phaseSpec.on_failed
          ? advanceDecision(state.phaseSpec.on_failed, `StateGraph 处理 ${task.status} task`)
          : holdDecision(`GRAPH_TASK_${task.status}`);
      }
      if (task.status === 'NEEDS_REWORK') {
        return state.phaseSpec.on_needs_rework
          ? advanceDecision(state.phaseSpec.on_needs_rework, 'StateGraph 根据 task 结果进入返工')
          : holdDecision('GRAPH_REWORK_TARGET_REQUIRED');
      }
      if (task.status !== 'COMPLETED' || !state.taskResult) return holdDecision('GRAPH_TASK_RESULT_REQUIRED');

      if (['CODE_REVIEW', 'TEST_CODE_REVIEW'].includes(state.phaseSpec.task_type)) {
        const review = adapter.readDeclaredOutput(task, 'review-findings.schema.json');
        if (!review) return holdDecision('GRAPH_REVIEW_FINDINGS_REQUIRED');
        if (review.value.workflow_id !== state.workflowId || review.value.task_id !== task.task_id) return holdDecision('GRAPH_REVIEW_BINDING_INVALID');
        if (review.value.reviewed_commit !== state.control.current_candidate_commit) return holdDecision('GRAPH_REVIEW_CANDIDATE_MISMATCH');
        if (review.value.verdict === 'BLOCKED') return holdDecision('GRAPH_REVIEW_BLOCKED');
        if (review.value.verdict === 'REQUEST_CHANGES') {
          return advanceDecision(state.phaseSpec.on_needs_rework, 'StateGraph 根据 review findings 进入返工');
        }
        if (review.value.verdict !== 'APPROVE') return holdDecision('GRAPH_REVIEW_VERDICT_INVALID');
      }

      if (state.phaseSpec.kind === 'release') {
        const release = releaseOutput(adapter, state);
        if (release.error) return holdDecision(release.error);
        if (release.value.verdict === 'HOLD') return holdDecision('GRAPH_RELEASE_DECISION_HOLD');
        const target = release.value.verdict === 'GO' ? state.phaseSpec.on_go : state.phaseSpec.on_no_go;
        return advanceDecision(target, `StateGraph 接受已校验的 release verdict ${release.value.verdict}`);
      }

      if (state.phaseSpec.kind === 'triage') {
        const exactRecommendation = String(state.taskResult.recommended_next_action ?? '').trim().toUpperCase();
        const target = state.requestedTargetPhase ?? exactRecommendation;
        const allowed = machine.phase_transitions[state.control.phase] ?? [];
        if (!allowed.includes(target)) return holdDecision('GRAPH_TRIAGE_TARGET_REQUIRED');
        return advanceDecision(target, `StateGraph 根据失败分诊进入 ${target}`);
      }

      if (['DEVELOPMENT', 'DEVELOPER_REWORK'].includes(state.phaseSpec.task_type) && !state.taskResult.output_commit) {
        return holdDecision('GRAPH_CANDIDATE_COMMIT_REQUIRED');
      }
      if (['DEVELOPMENT', 'DEVELOPER_REWORK'].includes(state.phaseSpec.task_type)
        && state.taskResult.output_commit !== state.control.current_candidate_commit) {
        return {
          route: 'apply', status: 'PROGRESSED', stopReason: null, action: 'SET_CANDIDATE', nextPhase: null,
          command: { command_type: 'SET_CANDIDATE', candidate_commit: state.taskResult.output_commit, reason: 'StateGraph 固定已验证开发候选 commit' },
        };
      }
      return advanceDecision(state.phaseSpec.on_completed, `StateGraph 完成 ${state.phaseSpec.task_type} 阶段`);
    },

    handleGate(state) {
      const gate = adapter.latestDeclaredOutput(state.workflowId, 'gate-result.schema.json', (value) => value.gate_name === state.phaseSpec.gate_name);
      if (!gate) return holdDecision(`GRAPH_GATE_RESULT_REQUIRED:${state.phaseSpec.gate_name}`);
      if (gate.value.workflow_id !== state.workflowId || (gate.value.task_id && gate.value.task_id !== gate.task.task_id)) {
        return holdDecision('GRAPH_GATE_BINDING_INVALID');
      }
      const recomputed = recomputeGate(gate.value.items ?? []);
      if (recomputed !== gate.value.overall) return holdDecision('GRAPH_GATE_OVERALL_MISMATCH');
      if (recomputed === 'HOLD') return holdDecision(`GRAPH_GATE_HOLD:${state.phaseSpec.gate_name}`);
      const target = recomputed === 'PASS' ? state.phaseSpec.on_pass : state.phaseSpec.on_fail;
      return advanceDecision(target, `StateGraph 根据 ${state.phaseSpec.gate_name}=${recomputed} 推进`);
    },

    handleFinal(state) {
      const release = releaseOutput(adapter, state);
      if (release.error) return holdDecision(release.error);
      if (release.value.verdict === 'HOLD') return holdDecision('GRAPH_RELEASE_DECISION_HOLD');
      const outcome = release.value.verdict === 'GO' ? 'READY_FOR_OPERATIONS_HANDOFF' : 'RELEASE_NO_GO';
      return {
        route: 'apply', status: 'TERMINAL', stopReason: outcome, action: 'COMPLETE', nextPhase: null,
        command: { command_type: 'COMPLETE', outcome, reason: `StateGraph 根据 release verdict ${release.value.verdict} 完成 workflow` },
      };
    },

    applyTransition(state) {
      const result = adapter.apply(state.graphRunId, state.control, state.command);
      return { control: result.state, afterRevision: result.state.revision, route: 'finish' };
    },

    finish() { return {}; },
  };
}
