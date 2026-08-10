import { guardLayer, resolveDynamicRoute } from './dynamic-router.mjs';

function routed(context, machine) {
  const resolved = resolveDynamicRoute({ ...context, machine });
  return {
    ...resolved.result,
    routeFacts: resolved.facts,
    routeDecision: resolved.decision,
  };
}

function taskState(adapter, task, control) {
  return {
    currentTask: task,
    taskResult: task ? adapter.taskResult(task.run_id) : null,
    control,
    afterRevision: control.revision,
  };
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
      const guarded = guardLayer({ audit: state.audit, control: state.control });
      if (guarded) {
        return {
          ...routed({ audit: state.audit, control: state.control }, machine),
          routeFacts: null,
          routeDecision: guarded,
        };
      }
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
      const demoApproval = adapter.approvals(state.workflowId, 'RESOLVED').find((item) => item.decision_id === demoDecisionId
        && item.request?.trigger === 'IMPLEMENTATION_TRADEOFF'
        && item.response?.outcome !== 'REJECTED' && item.response?.chosen_option_id === 'DEMO_FAST');
      return routed({
        kind: 'intake', phaseSpec: state.phaseSpec, state, control: state.control,
        audit: state.audit, demoApproval,
      }, machine);
    },

    async handleTask(state) {
      let task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
      let control = state.control;
      if (task?.status === 'CREATED') {
        adapter.validateTask(task.task_id);
        task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
      }
      if (task?.status === 'READY') {
        await adapter.dispatch(task.task_id);
        task = adapter.latestTask(state.workflowId, state.phaseSpec.task_type);
        control = adapter.getWorkflow(state.workflowId);
      }
      const refreshed = taskState(adapter, task, control);
      const route = routed({
        kind: state.phaseSpec.kind === 'triage' ? 'triage' : 'task',
        phaseSpec: state.phaseSpec,
        state: { ...state, control },
        control,
        audit: state.audit,
        task,
        taskResult: refreshed.taskResult,
        taskAgentValid: !task || task.assigned_agent === state.phaseSpec.agent,
        review: task ? adapter.readDeclaredOutput(task, 'review-findings.schema.json')?.value ?? null : null,
        release: task ? adapter.readDeclaredOutput(task, 'release-decision.schema.json')?.value ?? null : null,
        releaseTaskId: task?.task_id ?? null,
        releaseRunId: task?.run_id ?? null,
      }, machine);
      return { ...refreshed, ...route };
    },

    evaluateTask(state) {
      // Kept as a graph boundary for observability and compatibility; all
      // decisions now come from the five-layer router in handleTask.
      return state;
    },

    handleGate(state) {
      const found = adapter.latestDeclaredOutput(state.workflowId, 'gate-result.schema.json', (value) => value.gate_name === state.phaseSpec.gate_name);
      return routed({
        kind: 'gate', phaseSpec: state.phaseSpec, state, control: state.control,
        audit: state.audit,
        gate: found?.value ?? null,
        gateTaskId: found?.task?.task_id ?? null,
      }, machine);
    },

    handleFinal(state) {
      const found = adapter.latestDeclaredOutput(state.workflowId, 'release-decision.schema.json');
      return routed({
        kind: 'final', phaseSpec: state.phaseSpec, state, control: state.control,
        audit: state.audit,
        release: found?.value ?? null,
        releaseTaskId: found?.task?.task_id ?? null,
        releaseRunId: found?.task?.run_id ?? null,
      }, machine);
    },

    applyTransition(state) {
      const result = adapter.apply(state.graphRunId, state.control, state.command);
      return { control: result.state, afterRevision: result.state.revision, route: 'finish' };
    },

    finish() { return {}; },
  };
}
