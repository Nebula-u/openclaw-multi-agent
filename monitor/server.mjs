import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { createStateGraphRuntime } from '../scripts/stategraph/runtime.mjs';
import { MonitorEventHub, encodeSse } from './event-hub.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from './telemetry-repository.mjs';
import { createSessionTailer } from './session-tailer.mjs';
import { createSessionCatalog } from './session-catalog.mjs';
import { createArtifactWatcher } from './artifact-watcher.mjs';
import { createHealthClassifier } from './health-classifier.mjs';
import { authorityPaths } from '../scripts/stategraph/authority.mjs';
import { createWorkflowContinuation } from './workflow-continuation.mjs';

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

function sendAsset(response, asset, headers = {}) {
  response.writeHead(200, {
    'content-type': asset.contentType,
    'content-length': asset.body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  response.end(asset.body);
}

function sendError(response, status, code, message, headers = {}) {
  return sendJson(response, status, { ok: false, error: code, message }, headers);
}

function originHeaders(request, config) {
  const origin = request.headers.origin;
  const monitorOrigin = `http://${config.host}:${config.port}`;
  if (!origin || (!config.allowedOrigins.includes(origin) && origin !== monitorOrigin)) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': `content-type, ${config.controlTokenHeader ?? 'x-stategraph-control'}`,
  };
}

function readJsonBody(request, limit) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(Object.assign(new Error('request body exceeds configured limit'), { code: 'REQUEST_BODY_TOO_LARGE', statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { rejectBody(Object.assign(new Error('request body must be valid JSON'), { code: 'REQUEST_BODY_INVALID', statusCode: 400, cause: error })); }
    });
    request.on('error', rejectBody);
  });
}

function capabilityValue(path) {
  return readFileSync(path, 'utf8').trim();
}

function isAllowedOrigin(origin, config) {
  return !origin || config.allowedOrigins.includes(origin) || origin === `http://${config.host}:${config.port}`;
}

function integerQuery(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function publicDispatch(task, dispatch, index, count) {
  const latest = index === count - 1;
  return {
    dispatch_id: dispatch.dispatch_id,
    status: latest ? task.status : dispatch.status,
    attempt: task.attempt,
    cycle: dispatch.cycle,
    agent_id: task.agent_id,
    session_id: task.session_id,
    created_at: dispatch.created_at,
    updated_at: task.updated_at,
  };
}

function publicTask(task, telemetry, run = null) {
  const kernelTask = run?.tasks?.find((item) => item.taskId === task.task_id) ?? null;
  return {
    task_id: task.task_id,
    run_id: task.run_id,
    task_type: task.kind,
    title: task.title,
    status: task.status,
    attempt: task.attempt,
    max_attempts: task.max_attempts,
    json_regenerations: task.json_regenerations,
    max_json_regenerations: task.max_json_regenerations,
    assigned_agent: task.agent_id,
    session_id: task.session_id,
    updated_at: task.updated_at,
    health: telemetry.health(task.task_id),
    last_error: task.last_error ?? null,
    local_gate: task.local_gate ? { overall: task.local_gate.overall, overall_reason: task.local_gate.overall_reason } : null,
    dispatches: (task.dispatches ?? []).map((dispatch, index, values) => publicDispatch(task, dispatch, index, values.length)),
    execution: run?.executions?.[task.task_id] ?? null,
    artifacts: run?.artifacts?.[task.task_id] ?? [],
    task_group_id: task.task_group_id ?? kernelTask?.taskGroupId ?? task.task_id,
    parallel_slot: task.parallel_slot ?? kernelTask?.parallelSlot ?? 0,
  };
}

function publicWorkflow(state, telemetry, run = null) {
  const kernelRun = run ?? state.__kernelRun ?? null;
  return {
    protocol_version: 'stategraph-checkpoint-v1',
    workflow_id: state.workflowId,
    revision: state.revision,
    phase: state.phase,
    condition: state.condition,
    outcome: state.outcome,
    status_reason: state.statusReason,
    title: state.workflowTitle ?? state.routePlan?.summary ?? String(state.request?.text ?? state.workflowId).slice(0, 160),
    route_hash: state.routePlan?.route_hash ?? null,
    route_status: state.routePlan?.status ?? null,
    approval_plan: state.approvalPlan ?? [],
    pending_approval: state.pendingApproval,
    current_step_index: state.currentStepIndex,
    steps: state.steps ?? [],
    manager_reports: (state.managerReports ?? []).slice(-10),
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    tasks: (state.tasks ?? []).map((task) => publicTask(task, telemetry, run)),
    history_tasks: [],
    kernel_run_id: kernelRun?.runId ?? null,
    kernel_state: kernelRun?.state ?? null,
    kernel_degraded: Boolean(kernelRun?.kernelDegraded),
    run_id: kernelRun?.run_id ?? kernelRun?.runId ?? null,
    langgraph_thread_id: kernelRun?.langgraph_thread_id ?? kernelRun?.workflowId ?? null,
  };
}

export function createMonitorServer(config, { stateRuntime: providedRuntime = null, kernel: providedKernel = undefined,
  telemetryDatabase: providedTelemetryDatabase = null, eventHub = null } = {}) {
  let interactiveControlsEnabled = config.interactiveControlsEnabled === true;
  let runtimeCapability = null;
  let humanCapability = null;
  if (interactiveControlsEnabled) {
    try {
      const paths = authorityPaths(config.projectRoot);
      runtimeCapability = capabilityValue(paths.runtime);
      humanCapability = capabilityValue(paths.human);
    } catch (error) {
      interactiveControlsEnabled = false;
    }
  }
  const stateRuntime = providedRuntime ?? createStateGraphRuntime({
    projectRoot: config.projectRoot,
    databasePath: config.databasePath,
    runtimeCapability,
    humanCapability,
  });
  const telemetryDatabase = providedTelemetryDatabase ?? openTelemetryDatabase(config.monitorDatabasePath ?? ':memory:');
  const kernel = providedKernel === undefined ? (stateRuntime.kernel ?? null) : providedKernel;
  const telemetry = createTelemetryRepository(config.projectRoot, telemetryDatabase);
  telemetry.prune({ maxEvents: config.telemetryMaxEvents, activityRetentionDays: config.activityRetentionDays });
  const hub = eventHub ?? new MonitorEventHub({ retention: config.sseRetention });
  if (config.interactiveControlsEnabled === true && !interactiveControlsEnabled) {
    hub.publish('monitor-health', {
      status: 'DEGRADED',
      code: 'STATEGRAPH_CAPABILITY_NOT_INITIALIZED',
      message: '交互控制已请求但 capability 不存在，请先运行 workflow init。',
    }, { source: 'MONITOR_AUTHORITY' });
  }
  const uiRoot = join(config.projectRoot, 'monitor', 'ui');
  const uiAssets = new Map([
    ['/', { contentType: 'text/html; charset=utf-8', body: readFileSync(join(uiRoot, 'index.html')) }],
    ['/index.html', { contentType: 'text/html; charset=utf-8', body: readFileSync(join(uiRoot, 'index.html')) }],
    ['/styles.css', { contentType: 'text/css; charset=utf-8', body: readFileSync(join(uiRoot, 'styles.css')) }],
    ['/app.js', { contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(uiRoot, 'app.js')) }],
    ['/config.js', { contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(uiRoot, 'config.js')) }],
  ]);
  const publish = (type, payload, meta) => hub.publish(type, payload, meta);
  let authoritativeStates = [];
  let snapshot = { schema_version: 1, source: 'LANGGRAPH_CHECKPOINTS', kernel_reachable: kernel ? false : null,
    generated_at: new Date().toISOString(), workflows: [] };
  let fingerprint = '';
  let degradation = null;
  let kernelCycleDegradation = null;
  let refreshRunning = false;

  const taskSource = () => authoritativeStates.flatMap((state) => state.tasks ?? []);
  const sessionTailer = createSessionTailer({ taskSource, telemetry, sessionRoot: config.sessionRoot ?? config.projectRoot, publish });
  const sessionCatalog = createSessionCatalog({ sessionRoot: config.sessionRoot ?? config.projectRoot, projectRoot: config.projectRoot });
  const artifactWatcher = createArtifactWatcher({ taskSource, telemetry, publish });
  const healthClassifier = createHealthClassifier({ telemetry, publish, thresholds: {
    heartbeatStaleSeconds: config.heartbeatStaleSeconds,
    possiblyStalledSeconds: config.possiblyStalledSeconds,
    startingTimeoutSeconds: config.startingTimeoutSeconds,
    toolRunningGraceSeconds: config.toolRunningGraceSeconds,
  } });
  async function refresh() {
    if (refreshRunning) return snapshot;
    refreshRunning = true;
    try {
      try {
        authoritativeStates = await stateRuntime.list();
      } catch (error) {
        degradation = { code: error.code ?? 'STATE_SOURCE_UNAVAILABLE', message: error.message };
        // 保留上一次快照，Monitor 仍可响应只读请求。
        return snapshot;
      }
      const kernelRuns = new Map();
      let kernelReachable = kernel ? false : null;
      let kernelReadDegradation = null;
      if (kernel) {
        try {
          for (const run of await kernel.projectRuns({ limit: 200 })) {
            kernelRuns.set(run.langgraph_thread_id ?? run.workflowId, run);
          }
          kernelReachable = true;
        } catch (error) {
          kernelReadDegradation = { code: error.code ?? 'KERNEL_UNAVAILABLE', message: error.message };
          hub.publish('monitor-health', { status: 'DEGRADED', error: error.message,
            code: error.code ?? 'KERNEL_UNAVAILABLE' }, { source: 'KERNEL_UNREACHABLE' });
        }
      }
      const checkpointDegradation = authoritativeStates.some((state) => state.__kernelRun?.kernelDegraded)
        ? { code: 'KERNEL_UNAVAILABLE', message: 'Kernel不可达，当前使用Checkpoint只读投影' }
        : null;
      degradation = kernelReadDegradation ?? kernelCycleDegradation ?? checkpointDegradation;
      const healthInput = { workflows: authoritativeStates.map((state) => ({
        workflow_id: state.workflowId,
        tasks: (state.tasks ?? []).map((task) => ({ ...task, assigned_agent: task.agent_id })),
      })) };
      healthClassifier.scan(healthInput);
      sessionTailer.scan();
      artifactWatcher.scan();
      const next = {
        schema_version: 1,
        source: 'LANGGRAPH_CHECKPOINTS',
        kernel_reachable: kernelReachable,
        generated_at: new Date().toISOString(),
        degraded: Boolean(degradation),
        degradation,
        workflows: authoritativeStates.map((state) => publicWorkflow(state, telemetry, kernelRuns.get(state.workflowId) ?? null)),
      };
      const nextFingerprint = JSON.stringify(next.workflows);
      snapshot = next;
      if (nextFingerprint !== fingerprint) {
        fingerprint = nextFingerprint;
        hub.publish('snapshot', snapshot, { source: 'LANGGRAPH_CHECKPOINTS' });
      }
      return snapshot;
    } finally { refreshRunning = false; }
  }

  let cycleRunning = false;
  async function reconcileCycle() {
    if (cycleRunning) return;
    cycleRunning = true;
    try {
      if (kernel?.lease?.reapExpiredLeases) {
        try {
          await kernel.lease.reapExpiredLeases();
          kernelCycleDegradation = null;
        } catch (error) {
          kernelCycleDegradation = { code: error.code ?? 'KERNEL_REAP_UNAVAILABLE', message: error.message };
          hub.publish('monitor-health', { status: 'DEGRADED', error: error.message,
            code: error.code ?? 'KERNEL_REAP_UNAVAILABLE' }, { source: 'KERNEL_REAPER' });
        }
      }
      if (config.workflowContinuationEnabled) {
        await continuation.scan();
      }
      await refresh();
    } catch (error) {
      hub.publish('monitor-health', { status: 'DEGRADED', error: error.message, code: error.code ?? 'MONITOR_CYCLE_FAILED' }, { source: 'MONITOR' });
    } finally { cycleRunning = false; }
  }

  const continuation = createWorkflowContinuation({
    runtime: stateRuntime,
    publish,
    enabled: config.workflowContinuationEnabled === true,
    maxTurns: config.workflowContinuationMaxTurns,
  });

  const timer = setInterval(() => { void reconcileCycle(); }, config.reconcileIntervalMs);
  timer.unref?.();
  const maintenanceTimer = setInterval(() => {
    try { telemetry.prune({ maxEvents: config.telemetryMaxEvents, activityRetentionDays: config.activityRetentionDays }); }
    catch (error) { hub.publish('monitor-health', { status: 'DEGRADED', error: error.message }, { source: 'TELEMETRY_MAINTENANCE' }); }
  }, config.maintenanceIntervalMs);
  maintenanceTimer.unref?.();

  const server = createServer(async (request, response) => {
    const cors = originHeaders(request, config);
    try {
      if (!isLoopback(request.socket.remoteAddress)) return sendJson(response, 403, { ok: false, error: 'LOOPBACK_ONLY' }, cors);
      const origin = request.headers.origin;
      if (!isAllowedOrigin(origin, config)) return sendJson(response, 403, { ok: false, error: 'ORIGIN_NOT_ALLOWED' });
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end(); }
      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      const path = url.pathname;
      const writeRequest = request.method === 'POST';
      if (writeRequest) {
        if (!interactiveControlsEnabled) return sendJson(response, 403, { ok: false, error: 'INTERACTIVE_CONTROLS_DISABLED' }, cors);
        const monitorOrigin = `http://${config.host}:${config.port}`;
        const requestOrigin = request.headers.origin;
        if (requestOrigin && requestOrigin !== monitorOrigin) return sendJson(response, 403, { ok: false, error: 'WRITE_ORIGIN_NOT_ALLOWED' }, cors);
        if (!request.headers[(config.controlTokenHeader ?? 'x-stategraph-control').toLowerCase()]) {
          return sendJson(response, 403, { ok: false, error: 'CONTROL_HEADER_REQUIRED' }, cors);
        }
        if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          return sendJson(response, 415, { ok: false, error: 'JSON_CONTENT_TYPE_REQUIRED' }, cors);
        }
      }
      if (request.method === 'GET' && uiAssets.has(path)) return sendAsset(response, uiAssets.get(path), cors);
      if (request.method === 'GET' && path === '/api/client-config') {
        return sendJson(response, 200, {
          ok: true,
          api_url: `http://${config.host}:${config.port}`,
          local_only: true,
          interactive_controls: interactiveControlsEnabled,
          mode: interactiveControlsEnabled ? 'INTERACTIVE' : 'READ_ONLY',
          control_token_header: config.controlTokenHeader ?? 'x-stategraph-control',
          source: 'LANGGRAPH_CHECKPOINTS',
        }, cors);
      }
      if (request.method === 'GET' && path === '/api/health') {
        let audit;
        try { audit = await stateRuntime.audit(); }
        catch (error) { audit = { ok: false, database: 'LANGGRAPH_CHECKPOINTS', error: { code: error.code ?? 'AUDIT_UNAVAILABLE', message: error.message } }; }
        const healthy = audit.ok && !degradation;
        return sendJson(response, 200, { ok: healthy, status: healthy ? 'HEALTHY' : 'DEGRADED', api_reachable: true,
          kernel_reachable: snapshot.kernel_reachable, sequence: hub.sequence, audit,
          degraded: Boolean(degradation), degradation, generated_at: new Date().toISOString() }, cors);
      }
      if (request.method === 'GET' && path === '/api/workflows') {
        await refresh();
        return sendJson(response, 200, { ok: true, workflows: snapshot.workflows, generated_at: snapshot.generated_at,
          source: snapshot.source, kernel_reachable: snapshot.kernel_reachable }, cors);
      }
      if (request.method === 'GET' && path === '/api/supervisor') {
        return sendJson(response, 200, { ok: true, enabled: interactiveControlsEnabled, mode: interactiveControlsEnabled ? 'INTERACTIVE' : 'READ_ONLY', continuation: continuation.status(), generated_at: new Date().toISOString() }, cors);
      }
      if (request.method === 'POST' && path === '/api/workflows') {
        const body = await readJsonBody(request, config.requestBodyLimit);
        if (typeof body.text !== 'string' || !body.text.trim()) return sendJson(response, 400, { ok: false, error: 'WORKFLOW_TEXT_REQUIRED' }, cors);
        const workflowId = body.workflow_id ?? `WF-monitor-${Date.now().toString(36)}`;
        const requestValue = {
          text: body.text.trim(),
          project_path_abs: body.project_path_abs ?? config.projectRoot,
          source: 'MONITOR_GUI',
          submitted_by: 'monitor-gui',
          submitted_at: new Date().toISOString(),
          user_confirmation: { confirmed: true, actor: body.actor ?? 'human:monitor-gui', message: 'Monitor GUI 提交' },
        };
        const result = body.route_plan
          ? await stateRuntime.bootstrapConfirmed({ workflowId, request: requestValue, routePlan: body.route_plan })
          : await stateRuntime.bootstrap({ workflowId, request: requestValue });
        await refresh();
        return sendJson(response, 202, { ok: true, workflow_id: workflowId, result }, cors);
      }
      const workflowRun = path.match(/^\/api\/workflows\/([^/]+)\/(run|advance)$/u);
      if (request.method === 'POST' && workflowRun) {
        const workflowId = decodeURIComponent(workflowRun[1]);
        const result = workflowRun[2] === 'advance'
          ? (await continuation.scan()).find((item) => item.workflow_id === workflowId)?.result ?? await stateRuntime.run(workflowId)
          : await stateRuntime.run(workflowId);
        await refresh();
        return sendJson(response, 200, { ok: true, workflow_id: workflowId, result }, cors);
      }
      const workflowDecision = path.match(/^\/api\/workflows\/([^/]+)\/(approve|revise|abort)$/u);
      if (request.method === 'POST' && workflowDecision) {
        const workflowId = decodeURIComponent(workflowDecision[1]);
        const body = await readJsonBody(request, config.requestBodyLimit);
        let result;
        if (workflowDecision[2] === 'revise') {
          if (!body.route_plan) return sendJson(response, 400, { ok: false, error: 'ROUTE_PLAN_REQUIRED' }, cors);
          result = await stateRuntime.revise(workflowId, { request_id: body.request_id ?? `REQ-monitor-${Date.now().toString(36)}`, route_plan: body.route_plan, user_requested: true, requested_by: body.actor ?? 'human:monitor-gui', submitted_by: 'monitor-gui', user_request: body.notes ?? 'Monitor GUI 修改路线' });
        } else {
          result = await stateRuntime.approve(workflowId, { decision_id: body.decision_id, choice: workflowDecision[2] === 'abort' ? 'ABORT' : body.choice, decided_by: body.actor ?? 'human:monitor-gui', notes: body.notes ?? '', decided_at: new Date().toISOString() });
        }
        await refresh();
        return sendJson(response, 200, { ok: true, workflow_id: workflowId, result }, cors);
      }
      const workflowAudit = path.match(/^\/api\/workflows\/([^/]+)\/audit$/u);
      if (request.method === 'GET' && workflowAudit) {
        return sendJson(response, 200, await stateRuntime.audit(decodeURIComponent(workflowAudit[1])), cors);
      }
      if (request.method === 'GET' && path === '/api/agents') {
        return sendJson(response, 200, { ok: true, agents: sessionCatalog.agents(), generated_at: new Date().toISOString() }, cors);
      }
      const agentSessions = path.match(/^\/api\/agents\/([^/]+)\/sessions$/u);
      if (request.method === 'GET' && agentSessions) {
        const agentId = decodeURIComponent(agentSessions[1]);
        const sessions = sessionCatalog.sessions(agentId);
        return sendJson(response, sessions ? 200 : 404, sessions ? { ok: true, agent_id: agentId, sessions } : { ok: false, error: 'AGENT_NOT_FOUND' }, cors);
      }
      const sessionMessages = path.match(/^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/u);
      if (request.method === 'GET' && sessionMessages) {
        const agentId = decodeURIComponent(sessionMessages[1]);
        const sessionId = decodeURIComponent(sessionMessages[2]);
        const value = sessionCatalog.messages(agentId, sessionId);
        const session = sessionCatalog.sessions(agentId)?.find((item) => item.session_id === sessionId) ?? null;
        const limit = Math.min(integerQuery(url, 'limit', 500), 500);
        const messages = value?.messages ?? [];
        return sendJson(response, value ? 200 : 404, value ? { ok: true, ...value, session, truncated: messages.length > limit, messages: messages.slice(-limit) } : { ok: false, error: 'SESSION_NOT_FOUND' }, cors);
      }
      const workflowSnapshot = path.match(/^\/api\/workflows\/([^/]+)\/snapshot$/u);
      if (request.method === 'GET' && workflowSnapshot) {
        await refresh();
        const workflowId = decodeURIComponent(workflowSnapshot[1]);
        const workflow = snapshot.workflows.find((item) => item.workflow_id === workflowId);
        return sendJson(response, workflow ? 200 : 404, workflow ? { ok: true, snapshot: { ...snapshot, workflows: [workflow] } } : { ok: false, error: 'WORKFLOW_NOT_FOUND' }, cors);
      }
      if (request.method === 'GET' && path === '/api/workflows/stream') {
        const after = integerQuery(url, 'after', Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
        await refresh();
        response.write(encodeSse({ sequence: hub.sequence, type: 'snapshot', timestamp: new Date().toISOString(), payload: snapshot, meta: { initial: true, source: 'LANGGRAPH_CHECKPOINTS' } }));
        for (const event of hub.after(after)) response.write(encodeSse(event));
        const unsubscribe = hub.subscribe((event) => response.write(encodeSse(event)));
        const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
        keepalive.unref?.();
        request.on('close', () => { clearInterval(keepalive); unsubscribe(); });
        return;
      }
      const workflowStream = path.match(/^\/api\/workflows\/([^/]+)\/stream$/u);
      if (request.method === 'GET' && workflowStream) {
        const workflowId = decodeURIComponent(workflowStream[1]);
        const after = integerQuery(url, 'after', Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
        await refresh();
        response.write(encodeSse({ sequence: hub.sequence, type: 'snapshot', timestamp: new Date().toISOString(), payload: { ...snapshot, workflows: snapshot.workflows.filter((item) => item.workflow_id === workflowId) }, meta: { initial: true, source: 'LANGGRAPH_CHECKPOINTS' } }));
        for (const event of hub.after(after)) response.write(encodeSse(event));
        const unsubscribe = hub.subscribe((event) => response.write(encodeSse(event)));
        const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
        keepalive.unref?.();
        request.on('close', () => { clearInterval(keepalive); unsubscribe(); });
        return;
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/u);
      if (request.method === 'GET' && taskMatch) {
        await refresh();
        const taskId = decodeURIComponent(taskMatch[1]);
        const task = snapshot.workflows.flatMap((workflow) => workflow.tasks).find((item) => item.task_id === taskId);
        return sendJson(response, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'TASK_NOT_FOUND' }, cors);
      }
      const taskActivity = path.match(/^\/api\/tasks\/([^/]+)\/activity$/u);
      if (request.method === 'GET' && taskActivity) {
        const taskId = decodeURIComponent(taskActivity[1]);
        const dialogue = telemetry.events({ limit: 500 }).filter((event) => event.task_id === taskId && event.event_type === 'session.assistant_output')
          .map((event) => ({ agent_id: event.payload.agent_id, summary: event.payload.summary, timestamp: event.timestamp }));
        return sendJson(response, 200, { ok: true, dialogue }, cors);
      }
      const taskHealth = path.match(/^\/api\/tasks\/([^/]+)\/health$/u);
      if (request.method === 'GET' && taskHealth) {
        const health = telemetry.health(decodeURIComponent(taskHealth[1]));
        return sendJson(response, health ? 200 : 404, health ? { ok: true, health } : { ok: false, error: 'HEALTH_NOT_FOUND' }, cors);
      }
      return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }, cors);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, { ok: false, error: error.code ?? 'MONITOR_REQUEST_FAILED', message: error.message, details: error.details ?? null }, cors);
    }
  });

  return {
    server,
    stateRuntime,
    kernel,
    hub,
    telemetry,
    config,
    snapshot: () => snapshot,
    refresh,
    reconcileCycle,
    async start() {
      await refresh();
      await new Promise((resolveStart, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolveStart(); });
      });
      return server.address();
    },
    async close() {
      clearInterval(timer);
      clearInterval(maintenanceTimer);
      if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      if (!providedRuntime) await stateRuntime.close();
      if (!providedTelemetryDatabase) telemetryDatabase.close();
    },
  };
}
