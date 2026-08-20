export const CONTRACT_SCENARIOS = {
  'acceptance-criteria.schema.json': ['requirement-agent', false],
  'agent-package.schema.json': ['manager-agent', false],
  'approval-assessment.schema.json': ['manager-agent', false],
  'approval-request.schema.json': ['manager-agent', false],
  'approval-response.schema.json': ['manager-agent', false],
  'command-record.schema.json': ['developer-agent', true],
  'component-build-result.schema.json': ['manager-agent', false],
  'component-request.schema.json': ['manager-agent', false],
  'context-manifest.schema.json': ['architect-agent', false],
  'evidence.schema.json': ['test-agent', true],
  'gate-result.schema.json': ['manager-agent', false],
  'json-validation-error.schema.json': ['test-agent', false],
  'release-decision.schema.json': ['release-agent', false],
  'result.schema.json': ['developer-agent', false],
  'review-findings.schema.json': ['review-agent', false],
  'route-plan.schema.json': ['manager-agent', false],
  'skill-package.schema.json': ['manager-agent', false],
  'task-run.schema.json': ['manager-agent', false],
  'task.schema.json': ['manager-agent', false],
};

// These contracts are produced by deterministic host code and are never
// delegated to an LLM as an Agent communication exercise.
export const INTERNAL_CONTRACTS = new Set([
  'agent-activity.schema.json',
  'agent-checkpoint.schema.json',
  'monitor-event.schema.json',
  // Monitor ChatProvider is intentionally not an Agent executor. Its drafts are
  // validated at the HTTP boundary and require a separate human confirmation.
  'intent-draft.schema.json',
  // Manager requests are assembled by trusted control-plane code after the
  // human-confirmation check; they are never emitted directly by an Agent.
  'manager-request.schema.json',
  // Control Kernel 事实表投影：由 scripts/control-kernel/repository.mjs 直接
  // 从 PostgreSQL 行映射产出，不经过任何 Agent。
  'kernel-run.schema.json',
  'kernel-execution.schema.json',
  'kernel-artifact.schema.json',
]);

export function getContractScenario(schemaFile) {
  const scenario = CONTRACT_SCENARIOS[schemaFile];
  if (!scenario) throw new Error(`No Agent scenario is defined for ${schemaFile}.`);
  return { schemaFile, agentId: scenario[0], jsonl: scenario[1] };
}
