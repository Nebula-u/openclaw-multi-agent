import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createManagerRequestProcessor } from '../scripts/orchestrator/manager-request-queue.mjs';
import { deliveryArgs } from '../scripts/orchestrator/openclaw-runner.mjs';
import { assertManagerRequest } from '../scripts/orchestrator/request-validation.mjs';
import { compileRoutePlan, RoutePlanError } from '../scripts/orchestrator/route-policy.mjs';
import { atomicWriteJson } from '../scripts/runtime-core/atomic-store.mjs';
import { readForegroundServiceStatus, requestForegroundServiceStop, runForegroundService } from '../scripts/orchestrator/foreground-service.mjs';
import { createOrchestrator } from '../scripts/orchestrator/service.mjs';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';

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

test('部署路线必须通过 Release 的前置检查和部署两个受控步骤', () => {
  const plan = routePlan('WF-Deploy-001');
  plan.request_class = 'FEATURE';
  plan.risk_flags = ['external_side_effect', 'manual_acceptance', 'release_risk'];
  plan.deployment = { base_url: 'https://multiagentforge.cloud', project_id: 'todo-list' };
  plan.steps = [
    { step_id: 'release-preflight', kind: 'RELEASE', release_phase: 'PREFLIGHT', title: '部署前检查', rationale: '确定候选提交、回滚方案和项目 URL 路径。', human_approval_after: true, approval_reason: '确认候选提交和最终 URL 后才可部署。' },
    { step_id: 'release-deploy', kind: 'RELEASE', release_phase: 'DEPLOY', title: '受控部署与上线验证', rationale: '在确认后部署并验证线上服务。', human_approval_after: false, approval_reason: null },
  ];
  plan.skipped_stages = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'CODE_REVIEW'].map((kind) => ({ kind, reason: 'Not required for this release-only deployment test.' }));

  const compiled = compileRoutePlan(ROOT, plan);

  assert.equal(compiled.deployment.base_url, 'https://multiagentforge.cloud');
  assert.deepEqual(compiled.steps.map((step) => step.release_phase), ['PREFLIGHT', 'DEPLOY']);
});

test('部署路线拒绝跳过 Release 前置检查或部署确认', () => {
  const plan = routePlan('WF-Deploy-002');
  plan.request_class = 'FEATURE';
  plan.risk_flags = ['external_side_effect', 'manual_acceptance', 'release_risk'];
  plan.deployment = { base_url: 'https://multiagentforge.cloud', project_id: 'todo-list' };
  plan.steps = [
    { step_id: 'release-deploy', kind: 'RELEASE', release_phase: 'DEPLOY', title: '直接部署', rationale: 'Incorrectly skips the preflight gate.', human_approval_after: false, approval_reason: null },
  ];
  plan.skipped_stages = ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'CODE_REVIEW'].map((kind) => ({ kind, reason: 'Not required for this deployment validation test.' }));

  assert.throws(() => compileRoutePlan(ROOT, plan), (error) => error instanceof RoutePlanError && error.code === 'DEPLOYMENT_RELEASE_ROUTE_INVALID');
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

test('Manager request queue preserves request identity when route validation rejects a request', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'orchestrator-manager-rejected-'));
  const calls = [];
  const orchestrator = {
    projectRoot: ROOT,
    async createRun(request) { calls.push(request); return { runId: 'RUN-unexpected', routeHash: 'a'.repeat(64) }; },
    async reviseRun() { throw new Error('not used'); },
    async decide() { throw new Error('not used'); },
    async tickAll() { return []; },
  };
  const queue = createManagerRequestProcessor({ orchestrator, projectRoot: ROOT, managerWorkspace: workspace });
  const request = {
    schema_version: 1, request_id: 'REQ-rejected-route', request_type: 'CREATE', workflow_id: 'WF-rejected-route', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_path_abs: ROOT, original_request: 'Build a demo', route_plan: routePlan('WF-rejected-route'),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Run the confirmed route.' },
  };
  request.route_plan.display_title = 'This title is definitely too long';
  atomicWriteJson(join(queue.requests, 'rejected-route.json'), request);

  const receipt = await queue.processFile('rejected-route.json');

  assert.equal(receipt.status, 'REJECTED');
  assert.equal(receipt.request_id, request.request_id);
  assert.equal(receipt.request_type, request.request_type);
  assert.equal(receipt.workflow_id, request.workflow_id);
  assert.equal(receipt.error.code, 'ROUTE_PLAN_SCHEMA_INVALID');
  assert.equal(calls.length, 0);
});

test('Manager request validation rejects invalid route metadata before orchestration', () => {
  const request = {
    schema_version: 1, request_id: 'REQ-002', request_type: 'CREATE', workflow_id: 'WF-Route-002', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_path_abs: ROOT, original_request: 'Review code', route_plan: routePlan('WF-Route-002'),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Please run this reviewed route.' },
  };
  request.route_plan.display_title = 'This title is definitely too long';
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

test('Manager uses gateway allowlist exec without a Docker sandbox', () => {
  const managerPackage = JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', 'manager-agent.json'), 'utf8'));
  assert.equal(managerPackage.sandbox_mode, 'off');
  assert.equal(managerPackage.sandbox_config, undefined);
  assert.equal(managerPackage.tools_config?.profile, 'minimal');
  assert.equal(managerPackage.tools_config?.alsoAllow?.includes('exec'), true);
  assert.deepEqual(managerPackage.tools_config?.exec, { host: 'gateway', security: 'allowlist', ask: 'off', strictInlineEval: true, timeoutSec: 120 });
  assert.equal(managerPackage.tools_config?.deny?.includes('apply_patch'), true);
  assert.equal(managerPackage.tools_config?.deny?.includes('browser'), true);
});

test('Manager workspace documents the current request queue protocol', () => {
  const managerRules = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'AGENTS.md'), 'utf8');
  const managerTools = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'TOOLS.md'), 'utf8');
  const managerTemplates = readFileSync(join(ROOT, 'agents', 'manager-agent', 'workspace', 'templates', 'README.md'), 'utf8');
  assert.equal(existsSync(join(ROOT, 'templates', 'manager-request.deploy.json')), true);
  assert.equal(existsSync(join(ROOT, 'templates', 'manager-request.change.json')), true);
  assert.equal(existsSync(join(ROOT, 'templates', 'manager-request.decision.json')), true);
  assert.match(managerRules, /session_status/u);
  assert.match(managerRules, /templates\/manager-request\.json/u);
  assert.match(managerRules, /templates\/manager-request\.deploy\.json/u);
  assert.match(managerRules, /\.orchestrator\/drafts/u);
  assert.match(managerRules, /orchestrator-validate-request/u);
  assert.match(managerRules, /orchestrator-submit-request/u);
  assert.match(managerRules, /orchestrator-status/u);
  assert.match(managerRules, /\.orchestrator\/receipts/u);
  assert.match(managerRules, /requirement-agent/u);
  assert.match(managerRules, /RETRY_SAME_AGENT/u);
  assert.match(managerRules, /用户明确确认/u);
  assert.match(managerRules, /不能自行重置重试次数/u);
  assert.doesNotMatch(managerTools, /\.agent-raw\/route-plan\.json\.raw/u);
  assert.match(managerTools, /orchestrator-validate-request/u);
  assert.match(managerTools, /orchestrator-submit-request/u);
  assert.match(managerTools, /orchestrator-approve/u);
  assert.match(managerTools, /orchestrator-control/u);
  assert.match(managerRules, /暂停/u);
  assert.match(managerTemplates, /manager-request\.change\.json/u);
  assert.match(managerTemplates, /manager-request\.decision\.json/u);
  assert.match(managerTemplates, /manager-request\.deploy\.json/u);
});

test('Manager deployment CREATE reference passes the authoritative deployment route policy', () => {
  const path = join(ROOT, 'templates', 'manager-request.deploy.json');
  assert.equal(existsSync(path), true);
  const request = JSON.parse(readFileSync(path, 'utf8'));
  request.request_id = 'REQ-manager-deploy-001';
  request.workflow_id = 'WF-manager-deploy-001';
  request.submitted_at = '2026-09-01T00:00:00.000Z';
  request.manager_session_id = 'manager-session';
  request.manager_session_key = 'agent:manager:source';
  request.project_ref = 'PRJ-manager-deploy-001';
  request.original_request = 'Build and deploy a persistent web demo.';
  request.route_plan.workflow_id = request.workflow_id;
  request.route_plan.summary = 'Build and deploy a persistent web demo.';
  request.route_plan.display_title = 'Web Deploy';
  request.route_plan.deployment.project_id = 'manager-deploy-001';
  request.user_authorized = { confirmed: true, actor: 'human:liuxu', message: 'Deploy the confirmed route.' };

  assert.doesNotThrow(() => assertManagerRequest(ROOT, request));
  assert.deepEqual(request.route_plan.risk_flags, ['external_side_effect', 'manual_acceptance', 'release_risk']);
  assert.deepEqual(
    request.route_plan.steps.filter((step) => step.kind === 'RELEASE').map((step) => [step.release_phase, step.human_approval_after]),
    [['PREFLIGHT', true], ['DEPLOY', false]],
  );
  assert.deepEqual(Object.keys(request.route_plan.deployment).sort(), ['base_url', 'project_id']);
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

test('foreground service keeps polling while an HR job is still running', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'orchestrator-foreground-hr-'));
  let ticks = 0; let waits = 0; let startHr;
  const orchestrator = { projectRoot, async tickAll() { ticks += 1; return []; } };
  const hr = { autoMode: 'task', runPending() { return new Promise((resolveRun) => { startHr = resolveRun; }); } };
  const completed = runForegroundService({
    projectRoot, orchestrator, hr, pollMs: 100, shutdownTimeoutMs: 1000,
    waitFor: async () => { waits += 1; if (waits === 2) requestForegroundServiceStop(projectRoot); },
  });
  const result = await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('foreground loop waited for HR')), 300)),
  ]);
  startHr?.([]);
  assert.equal(result.state, 'STOPPED');
  assert.equal(ticks, 2);
});

test('Manager notification delivery receives the foreground shutdown signal', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  const controller = new AbortController();
  let receivedSignal = null;
  const orchestrator = createOrchestrator({
    projectRoot: ROOT,
    database,
    signal: controller.signal,
    notificationRunner: async ({ signal }) => {
      receivedSignal = signal;
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const run = await orchestrator.repository.createRun({
    workflowId: 'WF-notification-shutdown-signal',
    request: {},
    targetProjectRootAbs: ROOT,
    baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session',
    managerSessionKey: 'manager-key',
    routePlan: { route_hash: 'a'.repeat(64), display_title: 'Notifications', summary: 'Notifications', steps: [] },
  });
  await orchestrator.repository.queueNotification({ runId: run.runId, type: 'TASK_PREPARATION_FAILED', payload: {} });

  await orchestrator.deliverNotifications();

  assert.equal(receivedSignal, controller.signal);
  await orchestrator.close();
});

test('Manager request queue uses the Orchestrator runtime root by default', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'orchestrator-manager-runtime-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const queue = createManagerRequestProcessor({ orchestrator: { projectRoot: ROOT, runtimeRoot, async tickAll() { return []; } }, projectRoot: ROOT });
  assert.equal(queue.root, join(runtimeRoot, 'agents', 'manager-agent', 'workspace', '.orchestrator'));
});

test('Manager CREATE request accepts a logical managed project reference', () => {
  const request = {
    schema_version: 1, request_id: 'REQ-003', request_type: 'CREATE', workflow_id: 'WF-Route-003', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', project_ref: 'PRJ-managed-001', original_request: 'Build a new project', route_plan: routePlan('WF-Route-003'),
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Run the confirmed route.' },
  };
  assert.doesNotThrow(() => assertManagerRequest(ROOT, request));
});

test('Orchestrator binds a logical managed project reference to the request workflow', async (t) => {
  const database = openKernelDatabase({ databasePath: ':memory:' });
  t.after(() => database.close());
  let resolvedWorkflow = null;
  const orchestrator = createOrchestrator({
    projectRoot: ROOT,
    database,
    projectControl: { resolveProject(projectRef, workflowId) {
      assert.equal(projectRef, 'PRJ-managed-002'); resolvedWorkflow = workflowId;
      throw Object.assign(new Error('project belongs to another workflow'), { code: 'MANAGER_PROJECT_WORKFLOW_MISMATCH' });
    } },
    worktrees: { inspectTarget() { throw new Error('must not inspect a mismatched project'); } },
  });
  const workflowId = 'WF-Route-004';
  await assert.rejects(orchestrator.createRun({
    workflow_id: workflowId, project_ref: 'PRJ-managed-002', original_request: 'Build safely', route_plan: routePlan(workflowId),
    manager_session_id: 'manager-session', manager_session_key: 'agent:manager:source', user_authorized: { confirmed: true },
  }), (error) => error.code === 'MANAGER_PROJECT_WORKFLOW_MISMATCH');
  assert.equal(resolvedWorkflow, workflowId);
  await orchestrator.close();
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

  const stop = requestForegroundServiceStop(projectRoot, {
    clock: () => new Date('2026-08-22T00:00:20.000Z'), isProcessAlive: () => true,
  });
  assert.equal(stop.requested, true);
  assert.equal(stop.instance_id, 'instance-live');
  assert.equal(existsSync(join(projectRoot, 'runtime', 'orchestrator', 'service', 'foreground.stop.json')), true);
});
