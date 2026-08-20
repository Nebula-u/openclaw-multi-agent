import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createManagerRequestProcessor } from '../scripts/orchestrator/manager-request-queue.mjs';
import { deliveryArgs } from '../scripts/orchestrator/openclaw-runner.mjs';
import { assertManagerRequest } from '../scripts/orchestrator/request-validation.mjs';
import { compileRoutePlan, RoutePlanError } from '../scripts/orchestrator/route-policy.mjs';
import { atomicWriteJson } from '../scripts/runtime-core/atomic-store.mjs';

const ROOT = resolve(process.cwd());

function routePlan(workflowId = 'WF-Route-001') {
  return {
    schema_version: 1, workflow_id: workflowId, request_class: 'ANALYSIS_ONLY', summary: 'Inspect the codebase.', display_title: 'Review', risk_flags: [],
    steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review the current implementation', rationale: 'The user requested a review.', human_approval_after: false, approval_reason: null }],
    skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required for this request.' })),
  };
}

test('Orchestrator freezes a serial route with fixed Agent assignment', () => {
  const plan = compileRoutePlan(ROOT, routePlan());
  assert.equal(plan.steps[0].agent_id, 'review-agent');
  assert.equal(plan.steps[0].execution_mode, 'SERIAL');
  assert.match(plan.route_hash, /^[a-f0-9]{64}$/u);
});

test('Orchestrator rejects routes that omit a skipped-stage reason', () => {
  const invalid = routePlan(); invalid.skipped_stages.pop();
  assert.throws(() => compileRoutePlan(ROOT, invalid), (error) => error instanceof RoutePlanError && error.code === 'ROUTE_PLAN_SKIP_REASON_MISSING');
});

test('Orchestrator accepts TEST before CODE_REVIEW in a lifecycle route', () => {
  const plan = routePlan('WF-Lifecycle-001');
  plan.steps = [
    { step_id: 'development', kind: 'DEVELOPMENT', title: 'Implement', rationale: 'Build the requested feature.', human_approval_after: false, approval_reason: null },
    { step_id: 'test', kind: 'TEST', title: 'Test', rationale: 'Verify the feature.', human_approval_after: false, approval_reason: null },
    { step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', rationale: 'Review the implementation.', human_approval_after: false, approval_reason: null },
  ];
  plan.skipped_stages = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required for this request.' }));
  assert.doesNotThrow(() => compileRoutePlan(ROOT, plan));
});

test('Manager request queue requires session-bound requests and records a receipt', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'orchestrator-manager-'));
  const calls = [];
  const orchestrator = {
    projectRoot: ROOT,
    async createRun(request) { calls.push(request); return { runId: 'RUN-test', routeHash: 'a'.repeat(64) }; },
    async reviseRun() { throw new Error('not used'); },
    async decide() { throw new Error('not used'); },
    async tickAll() { return []; },
  };
  const queue = createManagerRequestProcessor({ orchestrator, projectRoot: ROOT, managerWorkspace: workspace });
  const request = {
    schema_version: 1, request_id: 'REQ-001', request_type: 'CREATE', workflow_id: 'WF-Route-001', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_path_abs: ROOT, original_request: 'Review code', route_plan: routePlan(),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Please run this reviewed route.' },
  };
  const path = join(queue.requests, 'request.json'); atomicWriteJson(path, request);
  const receipt = await queue.processFile('request.json');
  assert.equal(receipt.status, 'ACCEPTED'); assert.equal(calls.length, 1);
  assert.equal(JSON.parse(readFileSync(join(queue.receipts, 'request.json.receipt.json'), 'utf8')).status, 'ACCEPTED');
  delete request.manager_session_id; atomicWriteJson(join(queue.requests, 'missing-session.json'), request);
  assert.equal((await queue.processFile('missing-session.json')).status, 'REJECTED');
});

test('Manager request validation rejects invalid route metadata before orchestration', () => {
  const request = {
    schema_version: 1, request_id: 'REQ-002', request_type: 'CREATE', workflow_id: 'WF-Route-002', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_path_abs: ROOT, original_request: 'Review code', route_plan: routePlan('WF-Route-002'),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Please run this reviewed route.' },
  };
  request.route_plan.display_title = 'This title is too long';
  assert.throws(() => assertManagerRequest(ROOT, request), (error) => error.code === 'ROUTE_PLAN_SCHEMA_INVALID');
  request.route_plan.display_title = 'Review';
  request.route_plan.risk_flags = ['local_persistence'];
  assert.throws(() => assertManagerRequest(ROOT, request), (error) => error.code === 'ROUTE_PLAN_SCHEMA_INVALID');
});

test('webchat delivery uses the originating session channel', () => {
  assert.deepEqual(deliveryArgs({ reply_channel: 'webchat', reply_to: 'agent:manager:source' }), []);
  assert.deepEqual(deliveryArgs({ reply_channel: 'slack', reply_to: '#ops' }), ['--deliver', '--reply-channel', 'slack', '--reply-to', '#ops']);
  assert.throws(() => deliveryArgs({ reply_channel: 'not-a-channel', reply_to: 'target' }), (error) => error.code === 'OPENCLAW_DELIVERY_CHANNEL_UNSUPPORTED');
});
