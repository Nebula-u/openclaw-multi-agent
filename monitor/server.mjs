import { createServer } from 'node:http';
import { URL } from 'node:url';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { createControlSnapshot } from '../scripts/control-core/read-model.mjs';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { MonitorEventHub, encodeSse } from './event-hub.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from './telemetry-repository.mjs';
import { createSessionTailer } from './session-tailer.mjs';
import { createArtifactWatcher } from './artifact-watcher.mjs';
import { createHealthClassifier } from './health-classifier.mjs';

function isLoopback(address = '') {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(body);
}

async function readJsonBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

export function createMonitorServer(config, { database: providedDatabase = null, telemetryDatabase: providedTelemetryDatabase = null, eventHub = null } = {}) {
  const database = providedDatabase ?? openControlDatabase(config.databasePath);
  createControlRepository(config.projectRoot, database);
  const tasks = createTaskRepository(config.projectRoot, database);
  const telemetryDatabase = providedTelemetryDatabase ?? openTelemetryDatabase(config.monitorDatabasePath ?? ':memory:');
  const telemetry = createTelemetryRepository(config.projectRoot, telemetryDatabase);
  telemetry.prune({ maxEvents: config.telemetryMaxEvents, activityRetentionDays: config.activityRetentionDays });
  const hub = eventHub ?? new MonitorEventHub({ retention: config.sseRetention });
  const publish = (type, payload, meta) => hub.publish(type, payload, meta);
  const sessionTailer = createSessionTailer({ controlDatabase: database, telemetry,
    sessionRoot: config.sessionRoot ?? config.projectRoot, publish });
  const artifactWatcher = createArtifactWatcher({ controlDatabase: database, telemetry, publish });
  const healthClassifier = createHealthClassifier({ telemetry, publish, thresholds: {
    heartbeatStaleSeconds: config.heartbeatStaleSeconds, possiblyStalledSeconds: config.possiblyStalledSeconds,
    startingTimeoutSeconds: config.startingTimeoutSeconds, toolRunningGraceSeconds: config.toolRunningGraceSeconds,
  } });
  const attachHealth = (value) => {
    for (const workflow of value.workflows) for (const task of workflow.tasks ?? []) task.health = telemetry.health(task.task_id);
    return value;
  };
  const publicTask = (task) => ({
    task_id: task.task_id, run_id: task.run_id, task_type: task.task_type, title: task.title, status: task.status,
    attempt: task.attempt, max_attempts: task.max_attempts, assigned_agent: task.assigned_agent, updated_at: task.updated_at,
    health: task.health ?? null,
    dispatches: (task.dispatches ?? []).map((dispatch) => ({ dispatch_id: dispatch.dispatch_id, status: dispatch.status,
      attempt: dispatch.attempt, agent_id: dispatch.agent_id, created_at: dispatch.created_at, updated_at: dispatch.updated_at })),
  });
  const publicSnapshot = (value) => ({
    schema_version: value.schema_version, generated_at: value.generated_at, workflow_id: value.workflow_id,
    workflows: value.workflows.map((workflow) => ({
      protocol_version: workflow.protocol_version, workflow_id: workflow.workflow_id, revision: workflow.revision,
      phase: workflow.phase, condition: workflow.condition, outcome: workflow.outcome, status_reason: workflow.status_reason ?? null,
      created_at: workflow.created_at, updated_at: workflow.updated_at, tasks: (workflow.tasks ?? []).map(publicTask),
    })),
  });
  let internalSnapshot = createControlSnapshot(database);
  healthClassifier.scan(internalSnapshot);
  internalSnapshot = attachHealth(internalSnapshot);
  let snapshot = publicSnapshot(internalSnapshot);
  let fingerprint = JSON.stringify(snapshot.workflows);
  hub.publish('snapshot', snapshot, { source: 'CONTROL_DB' });

  const reconcile = () => {
    try {
      sessionTailer.scan();
      artifactWatcher.scan();
      const next = createControlSnapshot(database);
      healthClassifier.scan(next);
      attachHealth(next);
      const nextPublicSnapshot = publicSnapshot(next);
      const nextFingerprint = JSON.stringify(nextPublicSnapshot.workflows);
      if (nextFingerprint !== fingerprint) {
        internalSnapshot = next;
        snapshot = nextPublicSnapshot;
        fingerprint = nextFingerprint;
        hub.publish('snapshot', snapshot, { source: 'CONTROL_DB' });
      }
    } catch (error) {
      hub.publish('monitor-health', { status: 'DEGRADED', error: error.message }, { source: 'MONITOR' });
    }
  };
  const timer = setInterval(reconcile, config.reconcileIntervalMs);
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
      if (request.method === 'OPTIONS') {
        response.writeHead(204, cors);
        return response.end();
      }
      const url = new URL(request.url, `http://${config.host}:${config.port}`);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/api/client-config') {
        return sendJson(response, 200, { ok: true, api_url: `http://${config.host}:${config.port}`, local_only: true, read_only: true }, cors);
      }
      if (request.method === 'GET' && path === '/api/health') {
        const audit = auditControlDatabase(database);
        return sendJson(response, audit.ok ? 200 : 503, { ok: audit.ok, status: audit.ok ? 'HEALTHY' : 'DEGRADED',
          sequence: hub.sequence, audit, generated_at: new Date().toISOString() }, cors);
      }
      if (request.method === 'GET' && path === '/api/workflows') {
        return sendJson(response, 200, { ok: true, workflows: snapshot.workflows, generated_at: snapshot.generated_at }, cors);
      }
      const workflowSnapshot = path.match(/^\/api\/workflows\/([^/]+)\/snapshot$/u);
      if (request.method === 'GET' && workflowSnapshot) {
        const value = publicSnapshot(attachHealth(createControlSnapshot(database, { workflowId: decodeURIComponent(workflowSnapshot[1]) })));
        return sendJson(response, value.workflows.length ? 200 : 404, { ok: value.workflows.length > 0, snapshot: value }, cors);
      }
      const workflowStream = path.match(/^\/api\/workflows\/([^/]+)\/stream$/u);
      if (request.method === 'GET' && workflowStream) {
        const workflowId = decodeURIComponent(workflowStream[1]);
        const after = integerQuery(url, 'after', Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
        const initial = publicSnapshot(attachHealth(createControlSnapshot(database, { workflowId })));
        response.write(encodeSse({ sequence: hub.sequence, type: 'snapshot', timestamp: new Date().toISOString(), payload: initial, meta: { initial: true } }));
        for (const event of hub.after(after)) response.write(encodeSse(event));
        const unsubscribe = hub.subscribe((event) => response.write(encodeSse(event)));
        const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000);
        keepalive.unref?.();
        request.on('close', () => { clearInterval(keepalive); unsubscribe(); });
        return;
      }
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/u);
      if (request.method === 'GET' && taskMatch) {
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        return sendJson(response, task ? 200 : 404, task ? { ok: true, task: publicTask({ ...task, health: telemetry.health(task.task_id), dispatches: tasks.dispatches(task.task_id).map((item) => ({ ...item.intent, status: item.status, updated_at: item.receipt?.recorded_at ?? item.completion?.completed_at ?? item.intent.created_at })) }) } : { ok: false, error: 'TASK_NOT_FOUND' }, cors);
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
      const agentActivity = path.match(/^\/api\/agents\/([^/]+)\/activity$/u);
      if (request.method === 'GET' && agentActivity) {
        const agentId = decodeURIComponent(agentActivity[1]);
        const dialogue = telemetry.events({ limit: 500 }).filter((event) => event.payload.agent_id === agentId && event.event_type === 'session.assistant_output')
          .map((event) => ({ task_id: event.task_id, summary: event.payload.summary, timestamp: event.timestamp }));
        return sendJson(response, 200, { ok: true, dialogue }, cors);
      }
      return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }, cors);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, { ok: false, error: error.code ?? 'MONITOR_REQUEST_FAILED', message: error.message,
        details: error.details ?? null }, cors);
    }
  });

  return {
    server,
    database,
    hub,
    telemetry,
    config,
    snapshot: () => snapshot,
    async start() {
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
      if (!providedDatabase) database.close();
      if (!providedTelemetryDatabase) telemetryDatabase.close();
    },
  };
}
