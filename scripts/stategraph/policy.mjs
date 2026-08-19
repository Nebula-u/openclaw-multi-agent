import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256 } from './events.mjs';

const ORDER = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'CODE_REVIEW', 'TEST', 'RELEASE'];

function displayTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value.replaceAll(/[\r\n\t]/gu, ' ').replaceAll(/\s+/gu, ' ').trim();
  return title ? Array.from(title).slice(0, 10).join('') : null;
}

export class RoutePlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoutePlanError';
    this.code = code;
    this.details = details;
  }
}

export function loadStateGraphPolicy(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'stategraph-policy.json'), 'utf8'));
  const manager = policy.manager;
  if (!manager || typeof manager !== 'object') fail('STATEGRAPH_POLICY_MANAGER_MISSING', 'stategraph policy manager limits are required');
  for (const field of ['context_window_tokens', 'max_output_tokens', 'soft_budget_percent', 'prompt_max_chars']) {
    if (!Number.isSafeInteger(manager[field]) || manager[field] <= 0) {
      fail('STATEGRAPH_POLICY_MANAGER_LIMIT_INVALID', `manager.${field} must be a positive safe integer`, { field, value: manager[field] });
    }
  }
  if (manager.max_output_tokens > manager.context_window_tokens) {
    fail('STATEGRAPH_POLICY_OUTPUT_EXCEEDS_CONTEXT', 'manager max output must not exceed the context window');
  }
  if (manager.soft_budget_percent > 100) {
    fail('STATEGRAPH_POLICY_SOFT_BUDGET_INVALID', 'manager soft budget percent must be between 1 and 100');
  }
  const softBudgetTokens = Math.floor(manager.context_window_tokens * manager.soft_budget_percent / 100);
  if (softBudgetTokens + manager.max_output_tokens > manager.context_window_tokens) {
    fail('STATEGRAPH_POLICY_BUDGET_OVERFLOW', 'manager soft input budget plus max output exceeds the context window', {
      soft_budget_tokens: softBudgetTokens,
      max_output_tokens: manager.max_output_tokens,
      context_window_tokens: manager.context_window_tokens,
    });
  }

  const positiveInteger = (field, code) => {
    if (!Number.isSafeInteger(policy[field]) || policy[field] <= 0) {
      fail(code, `${field} must be a positive safe integer`, { field, value: policy[field] });
    }
  };
  positiveInteger('lease_seconds', 'STATEGRAPH_POLICY_LEASE_INVALID');
  positiveInteger('heartbeat_interval_seconds', 'STATEGRAPH_POLICY_HEARTBEAT_INVALID');
  if (policy.recursion_limit !== undefined && (!Number.isSafeInteger(policy.recursion_limit) || policy.recursion_limit < 20)) {
    fail('STATEGRAPH_POLICY_RECURSION_LIMIT_INVALID', 'recursion_limit must be a safe integer of at least 20');
  }
  if (policy.lease_seconds <= policy.heartbeat_interval_seconds * 2) {
    fail('POLICY_LEASE_TOO_SHORT', 'lease_seconds must be greater than heartbeat_interval_seconds * 2', {
      lease_seconds: policy.lease_seconds,
      heartbeat_interval_seconds: policy.heartbeat_interval_seconds,
    });
  }
  const parallelism = policy.parallelism;
  if (!parallelism || typeof parallelism !== 'object' || Array.isArray(parallelism)
    || typeof parallelism.enabled !== 'boolean'
    || !Number.isSafeInteger(parallelism.max_parallel)
    || parallelism.max_parallel <= 0
    || parallelism.max_parallel > 8) {
    fail('STATEGRAPH_POLICY_PARALLELISM_INVALID', 'parallelism.enabled and parallelism.max_parallel must be valid', {
      parallelism,
    });
  }
  return policy;
}

function schemaValidator(projectRoot) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'route-plan.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function fail(code, message, details) {
  throw new RoutePlanError(code, message, details);
}

function assertRouteRules(plan, policy) {
  const ids = new Set();
  let order = -1;
  for (const step of plan.steps) {
    if (ids.has(step.step_id)) fail('ROUTE_PLAN_STEP_DUPLICATED', `duplicate step_id: ${step.step_id}`);
    ids.add(step.step_id);
    const currentOrder = ORDER.indexOf(step.kind);
    if (currentOrder < order) fail('ROUTE_PLAN_ORDER_INVALID', `${step.kind} appears after a later lifecycle stage`);
    order = currentOrder;
    if (!policy.task_agents[step.kind]) fail('ROUTE_PLAN_AGENT_MAPPING_MISSING', `no fixed Agent mapping for ${step.kind}`);
    if (step.split_hint?.max_parallel > 1 && !['REQUIREMENTS', 'CODE_REVIEW', 'TEST'].includes(step.kind)) {
      fail('ROUTE_PLAN_PARALLEL_KIND_FORBIDDEN', `${step.kind} cannot be parallelized because it may mutate the candidate repository`);
    }
  }
  const kinds = new Set(plan.steps.map((step) => step.kind));
  const skipped = new Set(plan.skipped_stages.map((item) => item.kind));
  for (const kind of ORDER) {
    if (!kinds.has(kind) && !skipped.has(kind)) fail('ROUTE_PLAN_SKIP_REASON_MISSING', `${kind} is omitted without a code-reviewable reason`);
    if (kinds.has(kind) && skipped.has(kind)) fail('ROUTE_PLAN_STAGE_BOTH_INCLUDED_AND_SKIPPED', `${kind} is both included and skipped`);
  }
  if (!policy.route_rules.requirements_optional_classes.includes(plan.request_class) && !kinds.has('REQUIREMENTS')) {
    fail('ROUTE_PLAN_REQUIREMENTS_REQUIRED', `${plan.request_class} requires a REQUIREMENTS task`);
  }
  const requiresArchitecture = plan.risk_flags.some((flag) => policy.route_rules.architecture_risk_flags.includes(flag));
  if (requiresArchitecture && !kinds.has('ARCHITECTURE')) {
    fail('ROUTE_PLAN_ARCHITECTURE_REQUIRED', 'risk flags require an ARCHITECTURE task');
  }
  if (!policy.route_rules.development_free_classes.includes(plan.request_class) && !kinds.has('DEVELOPMENT')) {
    fail('ROUTE_PLAN_DEVELOPMENT_REQUIRED', `${plan.request_class} requires a DEVELOPMENT task`);
  }
  if (plan.request_class === 'TEST_ONLY' && (kinds.has('DEVELOPMENT') || kinds.has('ARCHITECTURE'))) {
    fail('ROUTE_PLAN_TEST_ONLY_SCOPE', 'TEST_ONLY must not route through DEVELOPMENT or ARCHITECTURE');
  }
  if (plan.request_class === 'TEST_ONLY' && !kinds.has('TEST')) fail('ROUTE_PLAN_TEST_REQUIRED', 'TEST_ONLY requires TEST');
  if (policy.route_rules.test_required_after_development && kinds.has('DEVELOPMENT') && !kinds.has('TEST')) {
    fail('ROUTE_PLAN_TEST_REQUIRED', 'DEVELOPMENT must be followed by TEST');
  }
  const elevated = plan.risk_flags.some((flag) => ['security_boundary', 'destructive_operation', 'external_side_effect', 'manual_acceptance', 'release_risk'].includes(flag));
  if (elevated && !plan.steps.some((step) => step.human_approval_after)) {
    fail('ROUTE_PLAN_RISK_APPROVAL_REQUIRED', 'elevated risk requires at least one post-task human approval');
  }
}

export function compileRoutePlan(projectRootInput, value, policyInput = null) {
  const projectRoot = resolve(projectRootInput);
  const policy = policyInput ?? loadStateGraphPolicy(projectRoot);
  const validate = schemaValidator(projectRoot);
  if (!validate(value)) fail('ROUTE_PLAN_SCHEMA_INVALID', 'manager route plan failed JSON Schema validation', { errors: structuredClone(validate.errors ?? []) });
  assertRouteRules(value, policy);
  const planBody = {
    schema_version: value.schema_version,
    workflow_id: value.workflow_id,
    request_class: value.request_class,
    summary: value.summary,
    display_title: displayTitle(value.display_title),
    risk_flags: [...value.risk_flags],
    skipped_stages: value.skipped_stages.map((item) => ({ ...item })),
    steps: value.steps.map((step, index) => ({
      ...step,
      index,
      agent_id: policy.task_agents[step.kind],
      status: 'PENDING',
      execution_round: 1,
    })),
  };
  const routeHash = sha256(canonicalJson(planBody));
  const approvalPlan = [
    {
      node_id: 'route-plan-confirmation',
      kind: 'ROUTE_PLAN_CONFIRMATION',
      after_step_id: null,
      reason: '确认本轮实际阶段、跳过原因和全部人工审批节点；确认后 Agent 无权修改',
      status: 'PENDING',
    },
    ...planBody.steps.filter((step) => step.human_approval_after).map((step) => ({
      node_id: `approval-after-${step.step_id}`,
      kind: 'STEP_CONFIRMATION',
      after_step_id: step.step_id,
      reason: step.approval_reason,
      status: 'PLANNED',
    })),
  ];
  return { ...planBody, status: 'PROPOSED', route_hash: routeHash, frozen_at: null, frozen_by: null, approval_plan: approvalPlan };
}

export function routePlanApprovalRequest(plan, occurredAt) {
  return {
    decision_id: `DEC-${plan.workflow_id}-ROUTE-${plan.route_hash.slice(0, 12)}`,
    kind: 'ROUTE_PLAN_CONFIRMATION',
    node_id: 'route-plan-confirmation',
    route_hash: plan.route_hash,
    title: '确认本轮动态执行与审批路线',
    question: '是否冻结 Manager 给出的阶段、跳过项和人工审批节点？',
    summary: plan.summary,
    steps: plan.steps.map(({ step_id, kind, title, agent_id, human_approval_after, approval_reason }) => ({
      step_id, kind, title, agent_id, human_approval_after, approval_reason,
    })),
    skipped_stages: plan.skipped_stages,
    options: [
      { id: 'APPROVE', label: '确认并冻结' },
      { id: 'REVISE', label: '按人工意见重新分析' },
      { id: 'ABORT', label: '终止本轮' },
    ],
    status: 'PENDING',
    requested_at: occurredAt,
  };
}

export function verifyFrozenRoute(plan) {
  if (!plan || plan.status !== 'FROZEN') return false;
  const { status: _status, frozen_at: _at, frozen_by: _by, approval_plan: _approvals, route_hash: recorded, ...body } = plan;
  return sha256(canonicalJson(body)) === recorded;
}
