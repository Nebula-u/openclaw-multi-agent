import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STATIC_TARGET_FIELDS = [
  'standard_next', 'demo_fast_next', 'on_completed', 'on_needs_rework',
  'on_failed', 'on_pass', 'on_fail', 'on_go', 'on_no_go',
];

export function loadWorkflowGraphPolicy(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'workflow-graph-v1.json'), 'utf8'));
  const machine = JSON.parse(readFileSync(join(projectRoot, 'config', 'control-state-machine-v2.json'), 'utf8'));
  if (policy.state_machine_version !== machine.schema_version) {
    throw Object.assign(new Error('workflow graph policy targets a different state-machine version'), { code: 'GRAPH_POLICY_VERSION_MISMATCH' });
  }
  for (const phase of machine.phases) {
    const spec = policy.phases[phase];
    if (!spec) throw Object.assign(new Error(`workflow graph policy is missing phase ${phase}`), { code: 'GRAPH_POLICY_PHASE_MISSING' });
    const allowed = machine.phase_transitions[phase] ?? [];
    for (const field of STATIC_TARGET_FIELDS) {
      if (spec[field] && !allowed.includes(spec[field])) {
        throw Object.assign(new Error(`${phase}.${field} targets illegal phase ${spec[field]}`), { code: 'GRAPH_POLICY_TRANSITION_INVALID' });
      }
    }
  }
  return { policy, machine };
}
