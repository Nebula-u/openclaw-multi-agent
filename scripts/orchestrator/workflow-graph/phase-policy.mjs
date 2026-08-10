import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEPRECATED_TARGET_FIELDS = [
  'standard_next', 'demo_fast_next', 'on_completed', 'on_needs_rework',
  'on_failed', 'on_pass', 'on_fail', 'on_go', 'on_no_go',
];

const ROUTING_SELECTORS = new Set([
  'control_edge', 'gate_failure_target', 'requested_or_recommended_legal_target',
]);

export function loadWorkflowGraphPolicy(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'workflow-graph-v1.json'), 'utf8'));
  const machine = JSON.parse(readFileSync(join(projectRoot, 'config', 'control-state-machine-v2.json'), 'utf8'));
  if (policy.state_machine_version !== machine.schema_version) {
    throw Object.assign(new Error('workflow graph policy targets a different state-machine version'), { code: 'GRAPH_POLICY_VERSION_MISMATCH' });
  }
  for (const phase of machine.phases) {
    const edges = machine.phase_transitions[phase];
    if (!edges || Array.isArray(edges) || typeof edges !== 'object') {
      throw Object.assign(new Error(`Control Kernel phase ${phase} must define named legal edges`), { code: 'CONTROL_PHASE_EDGES_INVALID' });
    }
    for (const [edge, target] of Object.entries(edges)) {
      if (!machine.phases.includes(target)) {
        throw Object.assign(new Error(`Control Kernel edge ${phase}.${edge} targets unknown phase ${target}`), { code: 'CONTROL_PHASE_EDGE_TARGET_INVALID' });
      }
    }
  }
  for (const phase of machine.phases) {
    const spec = policy.phases[phase];
    if (!spec) throw Object.assign(new Error(`workflow graph policy is missing phase ${phase}`), { code: 'GRAPH_POLICY_PHASE_MISSING' });
    for (const field of DEPRECATED_TARGET_FIELDS) {
      if (spec[field] !== undefined) {
        throw Object.assign(new Error(`${phase}.${field} duplicates a Control Kernel transition target`), { code: 'GRAPH_POLICY_TARGET_DUPLICATED' });
      }
    }
    for (const [outcome, route] of Object.entries(spec.routing ?? {})) {
      if (!route || typeof route !== 'object' || Array.isArray(route) || !ROUTING_SELECTORS.has(route.select)) {
        throw Object.assign(new Error(`${phase}.routing.${outcome} has unsupported selector`), { code: 'GRAPH_POLICY_ROUTING_SELECTOR_INVALID' });
      }
      if (route.select === 'control_edge' && (!route.edge || !Object.hasOwn(machine.phase_transitions[phase], route.edge))) {
        throw Object.assign(new Error(`${phase}.routing.${outcome} references an unknown Control Kernel edge ${route.edge ?? ''}`), { code: 'GRAPH_POLICY_CONTROL_EDGE_MISSING' });
      }
      if (route.select !== 'control_edge' && route.edge !== undefined) {
        throw Object.assign(new Error(`${phase}.routing.${outcome} must not provide an edge for ${route.select}`), { code: 'GRAPH_POLICY_ROUTING_SELECTOR_INVALID' });
      }
    }
  }
  return { policy, machine };
}
