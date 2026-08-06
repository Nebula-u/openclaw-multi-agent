import { createServer } from 'node:http';
import { URL } from 'node:url';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { createControlSnapshot } from '../scripts/control-core/read-model.mjs';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createSupervisionRepository } from '../scripts/control-core/supervision-repository.mjs';
import { createTaskRepository } from '../scripts/control-core/task-repository.mjs';
import { MonitorEventHub, encodeSse } from './event-hub.mjs';

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
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-headers': 'content-type,x-monitor-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS' };
}

function authorized(request, url, config) {
  const header = request.headers['x-monitor-token'];
  const query = url.searchParams.get('token');
  return Boolean(config.token) && (header === config.token || query === config.token);
}

function integerQuery(url, name, fallback) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function createMonitorServer(config, { database: providedDatabase = null, eventHub = null } = {}) {
  const database = providedDatabase ?? openControlDatabase(config.databasePath);
  createControlRepository(config.projectRoot, database);
  const tasks = createTaskRepository(config.projectRoot, database);
  const supervision = createSupervisionRepository(config.projectRoot, database);
  const hub = eventHub ?? new MonitorEventHub({ retention: config.sseRetention });
  let snapshot = createControlSnapshot(database);
  let fingerprint = JSON.stringify({ workflows: snapshot.workflows, supervision: snapshot.supervision });
  hub.publish('snapshot', snapshot, { source: 'CONTROL_DB' });

  const reconcile = () => {
    try {
      const next = createControlSnapshot(database);
      const nextFingerprint = JSON.stringify({ workflows: next.workflows, supervision: next.supervision });
      if (nextFingerprint !== fingerprint) {
        snapshot = next;
        fingerprint = nextFingerprint;
        hub.publish('snapshot', snapshot, { source: 'CONTROL_DB' });
      }
    } catch (error) {
      hub.publish('monitor-health', { status: 'DEGRADED', error: error.message }, { source: 'MONITOR' });
    }
  };
  const timer = setInterval(reconcile, config.reconcileIntervalMs);
  timer.unref?.();

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
        const value = createControlSnapshot(database, { workflowId: decodeURIComponent(workflowSnapshot[1]) });
        return sendJson(response, value.workflows.length ? 200 : 404, { ok: value.workflows.length > 0, snapshot: value }, cors);
      }
      const workflowEvents = path.match(/^\/api\/workflows\/([^/]+)\/events$/u);
      if (request.method === 'GET' && workflowEvents) {
        const repository = createControlRepository(config.projectRoot, database);
        const after = integerQuery(url, 'after', 0);
        const limit = Math.min(integerQuery(url, 'limit', 500), 5000);
        const events = repository.events(decodeURIComponent(workflowEvents[1])).filter((event) => event.seq > after).slice(0, limit);
        return sendJson(response, 200, { ok: true, events }, cors);
      }
      const workflowStream = path.match(/^\/api\/workflows\/([^/]+)\/stream$/u);
      if (request.method === 'GET' && workflowStream) {
        if (!authorized(request, url, config)) return sendJson(response, 401, { ok: false, error: 'TOKEN_REQUIRED' }, cors);
        const workflowId = decodeURIComponent(workflowStream[1]);
        const after = integerQuery(url, 'after', Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0);
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive', 'x-accel-buffering': 'no', ...cors });
        const initial = createControlSnapshot(database, { workflowId });
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
        return sendJson(response, task ? 200 : 404, task ? { ok: true, task } : { ok: false, error: 'TASK_NOT_FOUND' }, cors);
      }
      if (request.method === 'GET' && path === '/api/supervision') {
        return sendJson(response, 200, { ok: true, requests: supervision.list({ status: url.searchParams.get('status') }) }, cors);
      }
      if (request.method === 'POST' && path === '/api/supervision/request') {
        if (!authorized(request, url, config)) return sendJson(response, 401, { ok: false, error: 'TOKEN_REQUIRED' }, cors);
        const value = supervision.request(await readJsonBody(request, config.requestBodyLimit));
        reconcile();
        hub.publish('supervision', value, { source: 'LOCAL_API' });
        return sendJson(response, 201, value, cors);
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
      if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      if (!providedDatabase) database.close();
    },
  };
}

