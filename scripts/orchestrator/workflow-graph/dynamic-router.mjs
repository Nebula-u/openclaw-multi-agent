function decision(kind, status, reason, extra = {}) {
  return { kind, status, reason, ...extra };
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

function classifyReview({ state, task, review }) {
  if (!review) return { outcome: 'HOLD', reason: 'GRAPH_REVIEW_FINDINGS_REQUIRED' };
  if (review.workflow_id !== state.workflowId || review.task_id !== task.task_id) {
    return { outcome: 'HOLD', reason: 'GRAPH_REVIEW_BINDING_INVALID' };
  }
  if (review.reviewed_commit !== state.control.current_candidate_commit) {
    return { outcome: 'HOLD', reason: 'GRAPH_REVIEW_CANDIDATE_MISMATCH' };
  }
  if (review.verdict === 'BLOCKED') return { outcome: 'HOLD', reason: 'GRAPH_REVIEW_BLOCKED' };
  if (review.verdict === 'REQUEST_CHANGES') return { outcome: 'NEEDS_REWORK', reason: 'GRAPH_REVIEW_REQUEST_CHANGES' };
  if (review.verdict === 'APPROVE') return { outcome: 'COMPLETED', reason: 'GRAPH_REVIEW_APPROVED' };
  return { outcome: 'HOLD', reason: 'GRAPH_REVIEW_VERDICT_INVALID' };
}

function classifyRelease({ state, release, releaseTaskId, releaseRunId }) {
  if (!release) return { outcome: 'HOLD', reason: 'GRAPH_RELEASE_DECISION_REQUIRED' };
  if (release.workflow_id !== state.workflowId || release.task_id !== releaseTaskId || release.run_id !== releaseRunId) {
    return { outcome: 'HOLD', reason: 'GRAPH_RELEASE_DECISION_BINDING_INVALID' };
  }
  if (release.candidate_commit !== state.control.current_candidate_commit) {
    return { outcome: 'HOLD', reason: 'GRAPH_RELEASE_CANDIDATE_MISMATCH' };
  }
  const recomputed = recomputeRelease(release.checks ?? []);
  if (release.verdict !== recomputed) return { outcome: 'HOLD', reason: 'GRAPH_RELEASE_VERDICT_MISMATCH' };
  if (recomputed === 'GO') return { outcome: 'RELEASE_GO', reason: 'GRAPH_RELEASE_GO', verdict: recomputed };
  if (recomputed === 'NO_GO') return { outcome: 'RELEASE_NO_GO', reason: 'GRAPH_RELEASE_NO_GO', verdict: recomputed };
  return { outcome: 'HOLD', reason: 'GRAPH_RELEASE_DECISION_HOLD', verdict: recomputed };
}

// Layer 1: global execution safety. A stop here is intentionally not a
// Control Kernel mutation; the durable state already represents the stop.
export function guardLayer({ audit, control }) {
  if (!audit?.ok) return decision('STOP', 'HOLD', 'CONTROL_AUDIT_FAILED');
  if (!control) return decision('STOP', 'FAILED', 'CONTROL_WORKFLOW_NOT_FOUND');
  if (control.condition === 'TERMINAL') return decision('STOP', 'TERMINAL', control.outcome);
  if (control.condition === 'WAITING_HUMAN') return decision('STOP', 'WAITING_HUMAN', 'CONTROL_WAITING_HUMAN');
  if (control.condition === 'HOLD') return decision('STOP', 'HOLD', 'CONTROL_ON_HOLD');
  return null;
}

// Layer 2: translate already validated task/artifact facts into a small,
// deterministic outcome vocabulary. This layer never chooses a phase.
export function classifierLayer(context) {
  const { kind, phaseSpec, state, task, taskResult, review, gate, gateTaskId, release, demoApproval } = context;
  if (kind === 'intake') {
    return demoApproval
      ? { outcome: 'DEMO_FAST_APPROVED', reason: 'GRAPH_DEMO_FAST_APPROVED', decisionId: demoApproval.decision_id }
      : { outcome: 'STANDARD_FLOW', reason: 'GRAPH_STANDARD_FLOW' };
  }
  if (kind === 'gate') {
    if (!gate) return { outcome: 'HOLD', reason: `GRAPH_GATE_RESULT_REQUIRED:${phaseSpec.gate_name}` };
    if (gate.workflow_id !== state.workflowId || (gate.task_id && gate.task_id !== gateTaskId)) {
      return { outcome: 'HOLD', reason: 'GRAPH_GATE_BINDING_INVALID' };
    }
    const recomputed = recomputeGate(gate.items ?? []);
    if (recomputed !== gate.overall) return { outcome: 'HOLD', reason: 'GRAPH_GATE_OVERALL_MISMATCH' };
    return { outcome: `GATE_${recomputed}`, reason: `GRAPH_${phaseSpec.gate_name}_${recomputed}`, overall: recomputed };
  }
  if (kind === 'final') return classifyRelease(context);
  if (context.taskAgentValid === false) return { outcome: 'HOLD', reason: 'GRAPH_TASK_AGENT_MISMATCH' };
  if (!task || ['CANCELLED', 'SUPERSEDED'].includes(task.status)) {
    return { outcome: 'NEEDS_TASK', reason: `GRAPH_TASK_REQUIRED:${phaseSpec.task_type}` };
  }
  if (task.status === 'BLOCKED') return { outcome: 'HOLD', reason: 'GRAPH_TASK_BLOCKED' };
  if (task.status === 'WAITING_HUMAN') return { outcome: 'WAITING_HUMAN', reason: 'TASK_WAITING_HUMAN' };
  if (['FAILED', 'LOST'].includes(task.status)) return { outcome: task.status, reason: `GRAPH_TASK_${task.status}` };
  if (task.status === 'NEEDS_REWORK') return { outcome: 'NEEDS_REWORK', reason: 'GRAPH_TASK_NEEDS_REWORK' };
  if (['DISPATCHED', 'RUNNING'].includes(task.status)) return { outcome: 'RUNNING', reason: `TASK_${task.status}` };
  if (task.status !== 'COMPLETED' || !taskResult) return { outcome: 'HOLD', reason: 'GRAPH_TASK_RESULT_REQUIRED' };

  if (['CODE_REVIEW', 'TEST_CODE_REVIEW'].includes(phaseSpec.task_type)) {
    return classifyReview({ state, task, review });
  }
  if (phaseSpec.kind === 'release') return classifyRelease(context);
  if (phaseSpec.kind === 'triage') {
    const recommended = String(taskResult.recommended_next_action ?? '').trim().toUpperCase();
    return { outcome: 'TRIAGE_TARGET', reason: 'GRAPH_TRIAGE_TARGET', targetPhase: state.requestedTargetPhase ?? recommended };
  }
  if (['DEVELOPMENT', 'DEVELOPER_REWORK'].includes(phaseSpec.task_type)) {
    if (!taskResult.output_commit) return { outcome: 'HOLD', reason: 'GRAPH_CANDIDATE_COMMIT_REQUIRED' };
    if (taskResult.output_commit !== state.control.current_candidate_commit) {
      return { outcome: 'SET_CANDIDATE', reason: 'GRAPH_CANDIDATE_COMMIT_FOUND', candidateCommit: taskResult.output_commit };
    }
  }
  return { outcome: 'COMPLETED', reason: `GRAPH_${phaseSpec.task_type}_COMPLETED` };
}

// Layer 3: map an outcome to a business-policy action. This layer can select
// a target, but it cannot decide whether that target is legal.
export function policyLayer({ kind, phaseSpec, machine, control }, facts) {
  const transition = (targetPhase, reason, payload = {}) => decision('TRANSITION', 'PROGRESSED', reason, { targetPhase, payload });
  if (facts.outcome === 'DEMO_FAST_APPROVED') return transition(phaseSpec.demo_fast_next, facts.reason, { approval_decision_id: facts.decisionId });
  if (facts.outcome === 'STANDARD_FLOW') return transition(phaseSpec.standard_next, facts.reason);
  if (facts.outcome === 'GATE_PASS') return transition(phaseSpec.on_pass, facts.reason);
  if (facts.outcome === 'GATE_FAIL') return transition(phaseSpec.on_fail, facts.reason);
  if (kind !== 'final' && facts.outcome === 'RELEASE_GO') return transition(phaseSpec.on_go, facts.reason);
  if (kind !== 'final' && facts.outcome === 'RELEASE_NO_GO') return transition(phaseSpec.on_no_go, facts.reason);
  if (facts.outcome === 'NEEDS_REWORK') return phaseSpec.on_needs_rework
    ? transition(phaseSpec.on_needs_rework, facts.reason)
    : decision('HOLD', 'HOLD', 'GRAPH_REWORK_TARGET_REQUIRED');
  if (['FAILED', 'LOST'].includes(facts.outcome)) return phaseSpec.on_failed
    ? transition(phaseSpec.on_failed, facts.reason)
    : decision('HOLD', 'HOLD', facts.reason);
  if (facts.outcome === 'TRIAGE_TARGET') return transition(facts.targetPhase, facts.reason);
  if (facts.outcome === 'SET_CANDIDATE') {
    return decision('SET_CANDIDATE', 'PROGRESSED', facts.reason, { candidateCommit: facts.candidateCommit });
  }
  if (kind === 'final' && facts.outcome === 'RELEASE_GO') {
    return decision('COMPLETE', 'TERMINAL', facts.reason, { outcome: 'READY_FOR_OPERATIONS_HANDOFF' });
  }
  if (kind === 'final' && facts.outcome === 'RELEASE_NO_GO') {
    return decision('COMPLETE', 'TERMINAL', facts.reason, { outcome: 'RELEASE_NO_GO' });
  }
  if (facts.outcome === 'COMPLETED') return transition(phaseSpec.on_completed, facts.reason);
  if (facts.outcome === 'RELEASE_HOLD' || facts.outcome === 'HOLD') return decision('HOLD', 'HOLD', facts.reason);
  if (facts.outcome === 'WAITING_HUMAN') return decision('STOP', 'WAITING_HUMAN', facts.reason);
  if (facts.outcome === 'NEEDS_TASK') return decision('STOP', 'NEEDS_TASK', facts.reason);
  if (facts.outcome === 'RUNNING') return decision('STOP', 'RUNNING', facts.reason);
  return decision('HOLD', 'HOLD', `GRAPH_POLICY_UNHANDLED:${facts.outcome}`);
}

// Layer 4: validate the proposed action against the immutable state-machine
// graph before any command is built.
export function validatorLayer({ control, machine }, proposed) {
  if (proposed.kind === 'TRANSITION') {
    const allowed = machine.phase_transitions[control.phase] ?? [];
    if (!proposed.targetPhase || !allowed.includes(proposed.targetPhase)) {
      return decision('HOLD', 'HOLD', `GRAPH_ROUTE_ILLEGAL:${control.phase}->${proposed.targetPhase ?? ''}`);
    }
  }
  if (proposed.kind === 'SET_CANDIDATE' && (!proposed.candidateCommit || control.condition !== 'ACTIVE')) {
    return decision('HOLD', 'HOLD', 'GRAPH_CANDIDATE_ACTION_INVALID');
  }
  if (proposed.kind === 'COMPLETE') {
    if (control.phase !== 'FINAL_REPORT' || !machine.terminal_outcomes.includes(proposed.outcome)) {
      return decision('HOLD', 'HOLD', 'GRAPH_COMPLETE_ACTION_INVALID');
    }
  }
  return proposed;
}

// Layer 5: convert a validated decision into a Graph result and, where
// needed, a Control Kernel command. This function still does not write state.
export function commandLayer(proposed) {
  if (proposed.kind === 'TRANSITION') {
    return {
      route: 'apply', status: 'PROGRESSED', stopReason: null, action: 'ADVANCE_PHASE', nextPhase: proposed.targetPhase,
      command: { command_type: 'ADVANCE_PHASE', target_phase: proposed.targetPhase, reason: proposed.reason, payload: proposed.payload ?? {} },
    };
  }
  if (proposed.kind === 'SET_CANDIDATE') {
    return {
      route: 'apply', status: 'PROGRESSED', stopReason: null, action: 'SET_CANDIDATE', nextPhase: null,
      command: { command_type: 'SET_CANDIDATE', candidate_commit: proposed.candidateCommit, reason: proposed.reason },
    };
  }
  if (proposed.kind === 'HOLD') {
    return {
      route: 'apply', status: 'HOLD', stopReason: proposed.reason, action: 'HOLD', nextPhase: null,
      command: { command_type: 'HOLD', reason: proposed.reason, payload: { graph_stop_reason: proposed.reason } },
    };
  }
  if (proposed.kind === 'COMPLETE') {
    return {
      route: 'apply', status: 'TERMINAL', stopReason: proposed.outcome, action: 'COMPLETE', nextPhase: null,
      command: { command_type: 'COMPLETE', outcome: proposed.outcome, reason: proposed.reason },
    };
  }
  return { route: 'finish', status: proposed.status, stopReason: proposed.reason, action: null, nextPhase: null };
}

export function resolveDynamicRoute(context) {
  const guarded = guardLayer(context);
  if (guarded) return { facts: null, decision: guarded, result: commandLayer(guarded) };
  const facts = classifierLayer(context);
  const proposed = policyLayer(context, facts);
  const validated = validatorLayer(context, proposed);
  const result = commandLayer(validated);
  if (result.command) {
    result.command.payload = {
      ...(result.command.payload ?? {}),
      graph_route_kind: validated.kind,
      graph_route_reason: validated.reason,
      graph_route_facts: facts,
    };
  }
  return { facts, decision: validated, result };
}
