import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createManagerRequestProcessor } from '../scripts/orchestrator/manager-request-queue.mjs';
import { deliveryArgs } from '../scripts/orchestrator/openclaw-runner.mjs';
import { assertManagerRequest } from '../scripts/orchestrator/request-validation.mjs';
import { compileRoutePlan, RoutePlanError } from '../scripts/orchestrator/route-policy.mjs';
import { atomicWriteJson } from '../scripts/runtime-core/atomic-store.mjs';
import { readForegroundServiceStatus, requestForegroundServiceStop, runForegroundService } from '../scripts/orchestrator/foreground-service.mjs';

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

test('Manager is isolated and cannot use direct development tools', () => {
  const managerPackage = JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', 'manager-agent.json'), 'utf8'));
  assert.equal(managerPackage.sandbox_mode, 'all');
  assert.equal(managerPackage.sandbox_config?.mode, 'all');
  assert.equal(managerPackage.sandbox_config?.workspaceAccess, 'rw');
  assert.equal(managerPackage.sandbox_config?.docker?.readOnlyRoot, true);
  assert.equal(managerPackage.tools_config?.profile, 'minimal');
  assert.equal(managerPackage.tools_config?.deny?.includes('exec'), true);
  assert.equal(managerPackage.tools_config?.deny?.includes('apply_patch'), true);
  assert.equal(managerPackage.tools_config?.deny?.includes('browser'), true);
});

test('Manager workspace documents the current request queue protocol', () => {
  const managerRules = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'AGENTS.md'), 'utf8');
  const managerTools = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'TOOLS.md'), 'utf8');
  const managerTemplates = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'templates', 'README.md'), 'utf8');
  assert.equal(existsSync(join(ROOT, 'templates', 'manager-request.change.json')), true);
  assert.equal(existsSync(join(ROOT, 'templates', 'manager-request.decision.json')), true);
  assert.match(managerRules, /session_status/u);
  assert.match(managerRules, /templates\/manager-request\.json/u);
  assert.match(managerRules, /\.orchestrator\/receipts/u);
  assert.match(managerRules, /requirement-agent/u);
  assert.doesNotMatch(managerTools, /\.agent-raw\/route-plan\.json\.raw/u);
  assert.doesNotMatch(managerTools, /validate-request/u);
  assert.match(managerTemplates, /manager-request\.change\.json/u);
  assert.match(managerTemplates, /manager-request\.decision\.json/u);
});

test('Manager CREATE reference is accepted and routes requirements to requirement-agent', async () => {
  const createReference = JSON.parse(readFileSync(join(ROOT, 'templates', 'manager-request.json'), 'utf8'));
  const changeReference = JSON.parse(readFileSync(join(ROOT, 'templates', 'manager-request.change.json'), 'utf8'));
  assert.equal(typeof changeReference.route_plan, 'object');

  const request = structuredClone(createReference);
  request.request_id = 'REQ-manager-feature-001';
  request.workflow_id = 'WF-manager-feature-001';
  request.submitted_at = '2026-08-21T00:00:00.000Z';
  request.manager_session_id = 'manager-session';
  request.manager_session_key = 'agent:manager:source';
  request.project_path_abs = ROOT;
  request.original_request = 'Build a persistent web demo.';
  request.route_plan.workflow_id = request.workflow_id;
  request.route_plan.summary = 'Build a persistent web demo.';
  request.route_plan.display_title = 'Web Demo';
  request.user_authorized = { confirmed: true, actor: 'human:liuxu', message: 'Run the confirmed route.' };

  const calls = [];
  const orchestrator = {
    projectRoot: ROOT,
    async createRun(value) { calls.push(value); return { runId: 'RUN-manager-feature', routeHash: 'b'.repeat(64) }; },
    async reviseRun() { throw new Error('not used'); },
    async decide() { throw new Error('not used'); },
    async tickAll() { return []; },
  };
  const workspace = mkdtempSync(join(tmpdir(), 'orchestrator-manager-reference-'));
  const queue = createManagerRequestProcessor({ orchestrator, projectRoot: ROOT, managerWorkspace: workspace });
  atomicWriteJson(join(queue.requests, 'manager-feature.json'), request);
  const receipt = await queue.processFile('manager-feature.json');

  assert.equal(receipt.status, 'ACCEPTED');
  assert.equal(calls.length, 1);
  assert.equal(compileRoutePlan(ROOT, calls[0].route_plan).steps[0].agent_id, 'requirement-agent');
});

test('foreground service polls automatically and exits cleanly after a stop request', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orchestrator-foreground-'));
  let ticks = 0; let hrRuns = 0; let waits = 0;
  const orchestrator = { projectRoot, async tickAll() { ticks += 1; return []; } };
  const hr = { autoMode: 'off', async runPending() { hrRuns += 1; return []; } };
  const result = await runForegroundService({
    projectRoot,
    orchestrator,
    hr,
    pollMs: 100,
    shutdownTimeoutMs: 1000,
    waitFor: async () => {
      waits += 1;
      if (waits === 1) requestForegroundServiceStop(projectRoot);
    },
  });
  assert.equal(result.state, 'STOPPED');
  assert.equal(ticks, 1);
  assert.equal(hrRuns, 0);
  assert.equal(readForegroundServiceStatus(projectRoot).state, 'STOPPED');
  assert.throws(() => requestForegroundServiceStop(mkdtempSync(join(tmpdir(), 'orchestrator-not-running-'))), (error) => error.code === 'ORCHESTRATOR_NOT_RUNNING');
});

test('Manager CREATE request accepts a logical managed project reference', () => {
  const request = {
    schema_version: 1, request_id: 'REQ-003', request_type: 'CREATE', workflow_id: 'WF-Route-003', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_ref: 'PRJ-managed-001', original_request: 'Build a new project', route_plan: routePlan('WF-Route-003'),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Run the confirmed route.' },
  };
  assert.doesNotThrow(() => assertManagerRequest(ROOT, request));
});

test('foreground status projects a missing active process as stale and refuses stop', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orchestrator-stale-process-'));
  const statusPath = join(projectRoot, 'runtime', 'orchestrator', 'service', 'foreground.status.json');
  atomicWriteJson(statusPath, {
    schema_version: 1,
    service: 'foreground-orchestrator',
    instance_id: 'instance-dead',
    pid: 999999,
    state: 'RUNNING',
    started_at: '2026-08-22T00:00:00.000Z',
    heartbeat_at: '2026-08-22T00:00:10.000Z',
    stop_requested_at: null,
    cycles: 10,
    last_error: null,
    poll_ms: 1000,
  });
  const options = { clock: () => new Date('2026-08-22T00:00:11.000Z'), isProcessAlive: () => false };

  const status = readForegroundServiceStatus(projectRoot, options);
  assert.equal(status.state, 'STALE');
  assert.equal(status.recorded_state, 'RUNNING');
  assert.equal(status.stale_reason, 'PROCESS_NOT_FOUND');
  assert.throws(() => requestForegroundServiceStop(projectRoot, options), (error) => error.code === 'ORCHESTRATOR_NOT_RUNNING');
});

test('foreground status keeps a live fresh process active but expires an old heartbeat', () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orchestrator-stale-heartbeat-'));
  const statusPath = join(projectRoot, 'runtime', 'orchestrator', 'service', 'foreground.status.json');
  atomicWriteJson(statusPath, {
    schema_version: 1,
    service: 'foreground-orchestrator',
    instance_id: 'instance-live',
    pid: process.pid,
    state: 'RUNNING',
    started_at: '2026-08-22T00:00:00.000Z',
    heartbeat_at: '2026-08-22T00:00:10.000Z',
    stop_requested_at: null,
    cycles: 10,
    last_error: null,
    poll_ms: 1000,
  });
  const live = readForegroundServiceStatus(projectRoot, {
    clock: () => new Date('2026-08-22T00:00:11.000Z'), isProcessAlive: () => true,
  });
  assert.equal(live.state, 'RUNNING');

  const stale = readForegroundServiceStatus(projectRoot, {
    clock: () => new Date('2026-08-22T00:00:20.000Z'), isProcessAlive: () => true,
  });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.stale_reason, 'HEARTBEAT_EXPIRED');
});
