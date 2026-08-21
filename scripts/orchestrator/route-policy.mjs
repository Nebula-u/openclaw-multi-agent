import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson, sha256Text } from '../runtime-core/atomic-store.mjs';

export const ROUTE_ORDER = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'CODE_REVIEW', 'RELEASE'];
export const TASK_AGENT_BY_KIND = Object.freeze({
  REQUIREMENTS: 'requirement-agent',
  ARCHITECTURE: 'architect-agent',
  DESIGN: 'architect-agent',
  DEVELOPMENT: 'developer-agent',
  CODE_REVIEW: 'review-agent',
  TEST: 'test-agent',
  RELEASE: 'release-agent',
});
export const GATE_CHECKS_BY_KIND = Object.freeze({
  REQUIREMENTS: ['scope', 'boundaries', 'acceptance_criteria'],
  ARCHITECTURE: ['constraints', 'data_flow', 'risks'],
  DESIGN: ['interaction_states', 'accessibility', 'responsive_layout'],
  DEVELOPMENT: ['implementation', 'build', 'static_checks'],
  CODE_REVIEW: ['commit_binding', 'findings', 'regression_risk'],
  TEST: ['test_execution', 'regression', 'failure_evidence'],
  RELEASE: ['candidate_binding', 'rollback', 'release_readiness'],
});

export class RoutePlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoutePlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) { throw new RoutePlanError(code, message, details); }

function validator(projectRoot) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'route-plan.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertRules(plan) {
  const ids = new Set();
  const included = new Set();
  let previous = -1;
  for (const step of plan.steps) {
    if (ids.has(step.step_id)) fail('ROUTE_PLAN_STEP_DUPLICATED', `duplicate step_id: ${step.step_id}`);
    ids.add(step.step_id);
    const order = ROUTE_ORDER.indexOf(step.kind);
    if (order < previous) fail('ROUTE_PLAN_ORDER_INVALID', `${step.kind} appears after a later lifecycle stage`);
    previous = order;
    if (!TASK_AGENT_BY_KIND[step.kind]) fail('ROUTE_PLAN_AGENT_MAPPING_MISSING', `no fixed Agent mapping for ${step.kind}`);
    if (step.split_hint?.max_parallel > 1) fail('ROUTE_PLAN_PARALLEL_FORBIDDEN', 'the Orchestrator executes one route step at a time');
    included.add(step.kind);
  }
  const skipped = new Set(plan.skipped_stages.map((item) => item.kind));
  for (const kind of ROUTE_ORDER) {
    if (!included.has(kind) && !skipped.has(kind)) fail('ROUTE_PLAN_SKIP_REASON_MISSING', `${kind} is omitted without a reason`);
    if (included.has(kind) && skipped.has(kind)) fail('ROUTE_PLAN_STAGE_BOTH_INCLUDED_AND_SKIPPED', `${kind} is both included and skipped`);
  }
  if (plan.request_class === 'TEST_ONLY' && (!included.has('TEST') || included.has('DEVELOPMENT') || included.has('ARCHITECTURE'))) {
    fail('ROUTE_PLAN_TEST_ONLY_SCOPE', 'TEST_ONLY must contain TEST and cannot include DEVELOPMENT or ARCHITECTURE');
  }
  if (included.has('DEVELOPMENT') && !included.has('TEST')) fail('ROUTE_PLAN_TEST_REQUIRED', 'DEVELOPMENT requires TEST in the same route');
  const elevated = plan.risk_flags.some((flag) => ['security_boundary', 'destructive_operation', 'external_side_effect', 'manual_acceptance', 'release_risk'].includes(flag));
  if (elevated && !plan.steps.some((step) => step.human_approval_after)) fail('ROUTE_PLAN_RISK_APPROVAL_REQUIRED', 'elevated risk requires a human approval point');
}

export function compileRoutePlan(projectRootInput, value) {
  const projectRoot = resolve(projectRootInput);
  const validate = validator(projectRoot);
  if (!validate(value)) fail('ROUTE_PLAN_SCHEMA_INVALID', 'manager route plan failed JSON Schema validation', { errors: structuredClone(validate.errors ?? []) });
  assertRules(value);
  const body = {
    schema_version: value.schema_version,
    workflow_id: value.workflow_id,
    request_class: value.request_class,
    summary: value.summary,
    display_title: value.display_title,
    risk_flags: [...value.risk_flags],
    skipped_stages: value.skipped_stages.map((item) => ({ ...item })),
    steps: value.steps.map((step, index) => ({
      ...step,
      index,
      agent_id: TASK_AGENT_BY_KIND[step.kind],
      execution_mode: 'SERIAL',
    })),
  };
  return { ...body, route_hash: sha256Text(canonicalJson(body)), frozen_at: new Date().toISOString() };
}
