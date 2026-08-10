import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifierLayer,
  commandLayer,
  guardLayer,
  policyLayer,
  resolveDynamicRoute,
  validatorLayer,
} from '../scripts/orchestrator/workflow-graph/dynamic-router.mjs';
import { loadWorkflowGraphPolicy } from '../scripts/orchestrator/workflow-graph/phase-policy.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//u, '').replaceAll('/', '\\');
const { policy, machine } = loadWorkflowGraphPolicy(ROOT);

function activeContext(phase, extra = {}) {
  const control = {
    workflow_id: 'WF-routing-unit',
    revision: 3,
    phase,
    condition: 'ACTIVE',
    outcome: null,
    current_candidate_commit: 'abc123',
  };
  return {
    kind: 'task',
    phaseSpec: policy.phases[phase],
    state: { workflowId: control.workflow_id, control, requestedTargetPhase: null },
    control,
    audit: { ok: true, errors: [] },
    machine,
    ...extra,
  };
}

test('five routing layers keep guard, classification, policy, validation and command construction separate', () => {
  const context = activeContext('CODE_REVIEW', {
    task: { task_id: 'TASK-review', status: 'COMPLETED' },
    taskResult: { result_status: 'COMPLETED' },
    review: {
      workflow_id: 'WF-routing-unit', task_id: 'TASK-review', reviewed_commit: 'abc123', verdict: 'REQUEST_CHANGES',
    },
  });

  assert.equal(guardLayer(context), null);
  const facts = classifierLayer(context);
  assert.equal(facts.outcome, 'NEEDS_REWORK');
  const proposed = policyLayer(context, facts);
  assert.equal(proposed.kind, 'TRANSITION');
  assert.equal(proposed.targetPhase, 'DEVELOPER_REWORK');
  const validated = validatorLayer(context, proposed);
  assert.equal(validated.kind, 'TRANSITION');
  const command = commandLayer(validated);
  assert.equal(command.action, 'ADVANCE_PHASE');
  assert.equal(command.command.target_phase, 'DEVELOPER_REWORK');

  const resolved = resolveDynamicRoute(context);
  assert.equal(resolved.result.command.payload.graph_route_kind, 'TRANSITION');
  assert.equal(resolved.result.command.payload.graph_route_facts.outcome, 'NEEDS_REWORK');
});

test('guard layer stops audit failure before route policy can create a mutation', () => {
  const context = activeContext('DEVELOPMENT', { audit: { ok: false, errors: [{ code: 'AUDIT_FAIL' }] } });
  const guarded = guardLayer(context);
  assert.deepEqual(guarded, { kind: 'STOP', status: 'HOLD', reason: 'CONTROL_AUDIT_FAILED' });
  assert.equal(commandLayer(guarded).route, 'finish');
});

test('validator layer converts a policy target outside the current legal edges into HOLD', () => {
  const context = activeContext('CODE_REVIEW');
  const invalid = validatorLayer(context, {
    kind: 'TRANSITION', status: 'PROGRESSED', reason: 'bad route', targetPhase: 'FINAL_REPORT',
  });
  assert.equal(invalid.kind, 'HOLD');
  assert.match(invalid.reason, /GRAPH_ROUTE_ILLEGAL/u);
  assert.equal(commandLayer(invalid).command.command_type, 'HOLD');
});

test('dynamic failure triage accepts only a legal requested target phase', () => {
  const context = activeContext('FAILURE_TRIAGE', {
    kind: 'triage',
    state: { workflowId: 'WF-routing-unit', control: { workflow_id: 'WF-routing-unit', revision: 3, phase: 'FAILURE_TRIAGE', condition: 'ACTIVE', current_candidate_commit: 'abc123' }, requestedTargetPhase: 'TESTING' },
    control: { workflow_id: 'WF-routing-unit', revision: 3, phase: 'FAILURE_TRIAGE', condition: 'ACTIVE', current_candidate_commit: 'abc123' },
    task: { task_id: 'TASK-triage', status: 'COMPLETED' },
    taskResult: { result_status: 'COMPLETED', recommended_next_action: 'ARCHITECTURE' },
  });
  const routed = resolveDynamicRoute(context);
  assert.equal(routed.decision.kind, 'TRANSITION');
  assert.equal(routed.decision.targetPhase, 'TESTING');
  assert.equal(routed.result.command.target_phase, 'TESTING');
});

test('FINAL_REPORT maps a validated NO_GO release decision to the terminal outcome', () => {
  const control = {
    workflow_id: 'WF-routing-unit', revision: 3, phase: 'FINAL_REPORT', condition: 'ACTIVE', current_candidate_commit: 'abc123',
  };
  const context = {
    kind: 'final', phaseSpec: policy.phases.FINAL_REPORT, state: { workflowId: control.workflow_id, control }, control,
    audit: { ok: true, errors: [] }, machine, releaseTaskId: 'TASK-release', releaseRunId: 'RUN-release',
    release: {
      workflow_id: 'WF-routing-unit', task_id: 'TASK-release', run_id: 'RUN-release', candidate_commit: 'abc123', verdict: 'NO_GO',
      checks: [{ name: 'test', status: 'FAIL', evidence_refs: ['EVD-1'] }],
    },
  };
  const routed = resolveDynamicRoute(context);
  assert.equal(routed.decision.kind, 'COMPLETE');
  assert.equal(routed.decision.outcome, 'RELEASE_NO_GO');
  assert.equal(routed.result.command.outcome, 'RELEASE_NO_GO');
});
