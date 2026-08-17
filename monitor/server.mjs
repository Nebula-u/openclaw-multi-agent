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

function originHeaders(request, config) {
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,OPTIONS' };
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

function publicTask(task, telemetry) {
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
  };
}

function publicWorkflow(state, telemetry) {
  return {
    protocol_version: 'stategraph-checkpoint-v1',
    workflow_id: state.workflowId,
    revision: state.revision,
    phase: state.phase,
    condition: state.condition,
    outcome: state.outcome,
    status_reason: state.statusReason,
    title: state.routePlan?.summary ?? String(state.request?.text ?? state.workflowId).slice(0, 160),
    route_hash: state.routePlan?.route_hash ?? null,
    route_status: state.routePlan?.status ?? null,
    approval_plan: state.approvalPlan ?? [],
    pending_approval: state.pendingApproval,
    current_step_index: state.currentStepIndex,
    steps: state.steps ?? [],
    manager_reports: (state.managerReports ?? []).slice(-10),
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    tasks: (state.tasks ?? []).map((task) => publicTask(task, telemetry)),
    history_tasks: [],
  };
}

export function createMonitorServer(config, { stateRuntime: providedRuntime = null, telemetryDatabase: providedTelemetryDatabase = null, eventHub = null } = {}) {
  const stateRuntime = providedRuntime ?? createStateGraphRuntime({ projectRoot: config.projectRoot, databasePath: config.databasePath });
  const telemetryDatabase = providedTelemetryDatabase ?? openTelemetryDatabase(config.monitorDatabasePath ?? ':memory:');
  const telemetry = createTelemetryRepository(config.projectRoot, telemetryDatabase);
  telemetry.prune({ maxEvents: config.telemetryMaxEvents, activityRetentionDays: config.activityRetentionDays });
  const hub = eventHub ?? new MonitorEventHub({ retention: config.sseRetention });
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
  let snapshot = { schema_version: 1, source: 'LANGGRAPH_CHECKPOINTS', generated_at: new Date().toISOString(), workflows: [] };
  let fingerprint = '';
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
  const continuation = createWorkflowContinuation({ runtime: stateRuntime, publish,
    enabled: config.workflowContinuationEnabled ?? true, maxTurns: config.workflowContinuationMaxTurns ?? 8 });

  async function refresh() {
    if (refreshRunning) return snapshot;
    refreshRunning = true;
    try {
      authoritativeStates = await stateRuntime.list();
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
        generated_at: new Date().toISOString(),
        workflows: authoritativeStates.map((state) => publicWorkflow(state, telemetry)),
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
      await continuation.scan();
      await refresh();
    } catch (error) {
      hub.publish('monitor-health', { status: 'DEGRADED', error: error.message, code: error.code ?? 'MONITOR_CYCLE_FAILED' }, { source: 'MONITOR' });
    } finally { cycleRunning = false; }
  }

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
      if (origin && !config.allowedOrigins.includes(origin)) return sendJson(response, 403, { ok: false, error: 'ORIGIN_NOT_ALLOWED' });
      if (request.method === 'OPTIONS') { response.writeHead(204, cors); return response.end(); }
      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      const path = url.pathname;
      if (request.method === 'GET' && uiAssets.has(path)) return sendAsset(response, uiAssets.get(path), cors);
      if (request.method === 'GET' && path === '/api/client-config') {
        return sendJson(response, 200, { ok: true, api_url: `http://${config.host}:${config.port}`, local_only: true, read_only: true, source: 'LANGGRAPH_CHECKPOINTS' }, cors);
      }
      if (request.method === 'GET' && path === '/api/health') {
        const audit = await stateRuntime.audit();
        return sendJson(response, 200, { ok: audit.ok, status: audit.ok ? 'HEALTHY' : 'DEGRADED', api_reachable: true,
          sequence: hub.sequence, audit, generated_at: new Date().toISOString() }, cors);
      }
      if (request.method === 'GET' && path === '/api/workflows') {
        await refresh();
        return sendJson(response, 200, { ok: true, workflows: snapshot.workflows, generated_at: snapshot.generated_at, source: snapshot.source }, cors);
      }
      if (request.method === 'GET' && path === '/api/supervisor') {
        return sendJson(response, 200, { ok: true, ...continuation.status(), generated_at: new Date().toISOString() }, cors);
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
    hub,
    telemetry,
    config,
    snapshot: () => snapshot,
    refresh,
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
      if (!providedRuntime) stateRuntime.close();
      if (!providedTelemetryDatabase) telemetryDatabase.close();
    },
  };
}
