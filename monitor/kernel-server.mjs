import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL } from 'node:url';
import { createKernel } from '../scripts/control-kernel/kernel.mjs';
import { openKernelDatabase, resolveKernelConfig } from '../scripts/control-kernel/database.mjs';
import { createWorkflowRepository } from '../scripts/control-kernel/workflow-repository.mjs';
import { createGitWorktreeManager } from '../scripts/orchestrator/git-worktree.mjs';
import { createSnapshotService } from '../scripts/orchestrator/snapshot-service.mjs';
import { MonitorEventHub, encodeSse } from './event-hub.mjs';
import { openTelemetryDatabase, createTelemetryRepository } from './telemetry-repository.mjs';
import { createSessionTailer } from './session-tailer.mjs';
import { createSessionCatalog } from './session-catalog.mjs';
import { createHealthClassifier } from './health-classifier.mjs';
import { redactValue } from './redactor.mjs';

function isLoopback(address = '') { return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
function sendJson(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }); response.end(body);
}
function sendAsset(response, asset, headers = {}) { response.writeHead(200, { 'content-type': asset.contentType, 'content-length': asset.body.length, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...headers }); response.end(asset.body); }
function origins(server, config) { const address = server.address(); const port = typeof address === 'object' && address ? address.port : config.port; return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]); }
function allowedOrigin(origin, config, server) { return !origin || config.allowedOrigins.includes(origin) || origins(server, config).has(origin); }
function cors(request, config, server) { const origin = request.headers.origin; return origin && allowedOrigin(origin, config, server) ? { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': 'content-type' } : {}; }
function integerQuery(url, name, fallback) { const value = url.searchParams.get(name); if (value === null) return fallback; const parsed = Number.parseInt(value, 10); return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback; }
function publicTask(task, execution, telemetry) {
  return { task_id: task.taskId, run_id: task.runId, task_type: task.kind, step_id: task.stepId, title: task.title, status: task.state,
    attempt: task.attempt, max_attempts: task.maxAttempts, assigned_agent: task.agentId, session_id: execution?.sessionId ?? null,
    updated_at: task.updatedAt, last_error: task.lastError ?? null, execution: execution ?? null, health: telemetry.health(task.taskId),
    artifact_root_abs: task.payload?.artifact_root_abs ?? null, published_output_path_abs: task.payload?.published_output_path_abs ?? null };
}
function publicRun(run, tasks, telemetry, pendingApproval = null) {
  return { protocol_version: 'orchestrator-sqlite-v1', workflow_id: run.workflowId, run_id: run.runId, state: run.state, outcome: run.outcome,
    status_reason: run.statusReason, title: run.routePlan?.display_title ?? run.routePlan?.summary ?? run.workflowId, route_hash: run.routeHash,
    route_plan: run.routePlan, current_step_index: run.currentStepIndex, manager_session_id: run.managerSessionId,
    manager_delivery: run.managerDelivery, created_at: run.createdAt, updated_at: run.updatedAt, completed_at: run.completedAt,
    tasks: tasks.map((task) => publicTask(task, task.execution, telemetry)), pending_approval: pendingApproval };
}

export function createKernelMonitorServer(config, { database: providedDatabase = null, kernel: providedKernel = null, repository: providedRepository = null, snapshots: providedSnapshots = null, telemetryDatabase: providedTelemetryDatabase = null, eventHub: providedHub = null } = {}) {
  config = {
    projectRoot: process.cwd(), runtimeRoot: process.cwd(), sessionRoot: process.cwd(), host: '127.0.0.1', port: 0,
    allowedOrigins: ['null'], reconcileIntervalMs: 2000, sseRetention: 2000,
    telemetryMaxEvents: 100000, activityRetentionDays: 30, heartbeatStaleSeconds: 180, possiblyStalledSeconds: 300,
    startingTimeoutSeconds: 120, toolRunningGraceSeconds: 900, ...config,
  };
  const kernelConfig = resolveKernelConfig({ projectRoot: config.projectRoot, databasePath: config.databasePath ?? undefined });
  const ownedDatabase = !providedDatabase && !providedKernel;
  const database = providedDatabase ?? providedKernel?.database ?? (providedKernel ? null : openKernelDatabase({ ...kernelConfig, readonly: true, initialize: false }));
  const kernel = providedKernel ?? createKernel({ database, workerId: `${kernelConfig.workerId}-monitor`, leaseSeconds: kernelConfig.leaseSeconds });
  const repository = providedRepository ?? createWorkflowRepository({ database });
  const snapshotService = providedSnapshots ?? createSnapshotService({ repository, worktrees: createGitWorktreeManager({ projectRoot: config.projectRoot }) });
  const telemetryDatabase = providedTelemetryDatabase ?? openTelemetryDatabase(config.monitorDatabasePath ?? ':memory:');
  const telemetry = createTelemetryRepository(config.projectRoot, telemetryDatabase);
  const hub = providedHub ?? new MonitorEventHub({ retention: config.sseRetention });
  const catalog = createSessionCatalog({ sessionRoot: config.sessionRoot ?? config.projectRoot, projectRoot: config.projectRoot });
  let snapshot = { schema_version: 1, source: 'SQLITE_CONTROL_KERNEL', kernel_reachable: false, generated_at: new Date().toISOString(), workflows: [], snapshots: [], hr_alerts: [], hr_jobs: [], notifications: [] };
  let refreshRunning = false; let fingerprint = '';
  const uiRoot = join(config.projectRoot, 'monitor', 'ui');
  const assets = new Map([['/', { contentType: 'text/html; charset=utf-8', body: readFileSync(join(uiRoot, 'index.html')) }], ['/index.html', { contentType: 'text/html; charset=utf-8', body: readFileSync(join(uiRoot, 'index.html')) }], ['/styles.css', { contentType: 'text/css; charset=utf-8', body: readFileSync(join(uiRoot, 'styles.css')) }], ['/app.js', { contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(uiRoot, 'app.js')) }], ['/config.js', { contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(uiRoot, 'config.js')) }]]);
  const health = createHealthClassifier({ telemetry, publish: (type, payload, meta) => hub.publish(type, payload, meta), thresholds: { heartbeatStaleSeconds: config.heartbeatStaleSeconds, possiblyStalledSeconds: config.possiblyStalledSeconds, startingTimeoutSeconds: config.startingTimeoutSeconds, toolRunningGraceSeconds: config.toolRunningGraceSeconds } });
  let runsCache = { runs: [], tasks: [], hrJobs: [] };
  async function readHrJobs(limit = 200) { return repository.listHrJobs({ limit }); }
  async function readNotifications(limit = 200) { return repository.listNotifications({ statuses: ['PENDING', 'FAILED', 'SENT', 'DELIVERED'], limit }); }
  async function readSnapshots(limit = 500) { return repository.listSnapshots ? repository.listSnapshots({ limit }) : []; }
  function discoveredSessions() {
    const values = [];
    for (const agent of catalog.agents()) {
      for (const session of catalog.sessions(agent.agent_id) ?? []) {
        const task = runsCache.tasks.find((item) => item.execution?.sessionId === session.session_id && item.agentId === agent.agent_id) ?? null;
        const managerRun = runsCache.runs.find((item) => item.managerSessionId === session.session_id && agent.agent_id === 'manager-agent') ?? null;
        const hrJob = runsCache.hrJobs.find((item) => item.hrSessionId === session.session_id && agent.agent_id === 'hr-agent') ?? null;
        const runId = task?.runId ?? managerRun?.runId ?? hrJob?.runId ?? null;
        const run = runId ? runsCache.runs.find((item) => item.runId === runId) : null;
        values.push({ agent_id: agent.agent_id, session_id: session.session_id, session_key: session.session_key ?? null,
          workflow_id: run?.workflowId ?? 'UNBOUND', task_id: task?.taskId ?? hrJob?.taskId ?? null, run_id: runId,
          dispatch_id: task?.execution?.executionId ?? null, updated_at: session.updated_at ?? null, binding: run ? 'KERNEL_WORKFLOW' : 'UNBOUND_SESSION' });
      }
    }
    return values;
  }
  function hrOutputs(jobs) {
    return jobs.filter((job) => job.hrSessionId).map((job) => ({
      job_id: job.jobId,
      task_id: job.taskId,
      kind: job.kind,
      session_id: job.hrSessionId,
      messages: (catalog.messages('hr-agent', job.hrSessionId)?.messages ?? [])
        .filter((message) => message.role === 'assistant')
        .map((message) => ({ text: message.text, timestamp: message.timestamp })),
    }));
  }
  const sessionTailer = createSessionTailer({ sessionSource: discoveredSessions, telemetry, sessionRoot: config.sessionRoot ?? config.projectRoot,
    publish: (type, event, meta) => hub.publish(type, event, meta) });
  async function refresh() {
    if (refreshRunning) return snapshot; refreshRunning = true;
    try {
      const [runs, tasks, executions, hrJobs, notifications, gitSnapshots] = await Promise.all([kernel.listRuns({ limit: 200 }), kernel.listTasks({ limit: 2000 }), kernel.listExecutions({ limit: 2000 }), readHrJobs(), readNotifications(), readSnapshots()]);
      const enrichedTasks = tasks.map((task) => ({ ...task, workflowId: runs.find((run) => run.runId === task.runId)?.workflowId ?? null, execution: executions.find((item) => item.taskId === task.taskId) ?? null }));
      runsCache = { runs, tasks: enrichedTasks, hrJobs };
      const approvals = repository.listApprovals ? await Promise.all(runs.map((run) => repository.listApprovals({ runId: run.runId, status: 'PENDING' }))) : runs.map(() => []);
      const workflowValues = runs.map((run, index) => publicRun(run, enrichedTasks.filter((task) => task.runId === run.runId), telemetry, approvals[index][0] ?? null));
      const healthInput = { workflows: workflowValues }; health.scan(healthInput); sessionTailer.scan();
      const alerts = hrJobs.filter((job) => Array.isArray(job.input?.matches) && job.input.matches.length).map((job) => redactValue({ job_id: job.jobId, run_id: job.runId, task_id: job.taskId, matches: job.input.matches }));
      const next = { schema_version: 1, source: 'SQLITE_CONTROL_KERNEL', kernel_reachable: true, generated_at: new Date().toISOString(), workflows: workflowValues, snapshots: gitSnapshots, hr_alerts: alerts, hr_jobs: hrJobs, hr_outputs: hrOutputs(hrJobs), notifications, global_sessions: discoveredSessions().filter((item) => item.binding === 'UNBOUND_SESSION') };
      const value = JSON.stringify(next); snapshot = next; if (value !== fingerprint) { fingerprint = value; hub.publish('snapshot', snapshot, { source: 'SQLITE_CONTROL_KERNEL' }); } return snapshot;
    } catch (error) { snapshot = { ...snapshot, kernel_reachable: false, degraded: true, degradation: { code: error.code ?? 'KERNEL_UNAVAILABLE', message: error.message }, generated_at: new Date().toISOString() }; hub.publish('monitor-health', snapshot.degradation, { source: 'KERNEL' }); return snapshot; }
    finally { refreshRunning = false; }
  }
  const timer = setInterval(() => { void refresh(); }, config.reconcileIntervalMs); timer.unref?.();
  const server = createServer(async (request, response) => {
    const headers = cors(request, config, server);
    try {
      if (!isLoopback(request.socket.remoteAddress)) return sendJson(response, 403, { ok: false, error: 'LOOPBACK_ONLY' }, headers);
      if (!allowedOrigin(request.headers.origin, config, server)) return sendJson(response, 403, { ok: false, error: 'ORIGIN_NOT_ALLOWED' });
      if (request.method === 'OPTIONS') { response.writeHead(204, headers); return response.end(); }
      const url = new URL(request.url, `http://${config.host}:${config.port}`); const path = url.pathname;
      if (request.method === 'GET' && assets.has(path)) return sendAsset(response, assets.get(path), headers);
      if (request.method === 'GET' && path === '/api/client-config') return sendJson(response, 200, { ok: true, api_url: `http://${config.host}:${config.port}`, local_only: true, interactive_controls: false, mode: 'READ_ONLY', source: snapshot.source }, headers);
      if (request.method === 'GET' && path === '/api/health') return sendJson(response, 200, { ok: snapshot.kernel_reachable, status: snapshot.kernel_reachable ? 'HEALTHY' : 'DEGRADED', api_reachable: true, kernel_reachable: snapshot.kernel_reachable, sequence: hub.sequence, generated_at: snapshot.generated_at, degradation: snapshot.degradation ?? null }, headers);
      if (request.method === 'GET' && path === '/api/workflows') { await refresh(); return sendJson(response, 200, { ok: true, ...snapshot }, headers); }
      if (request.method === 'GET' && path === '/api/supervisor') return sendJson(response, 200, { ok: true, enabled: false, mode: 'READ_ONLY', continuation: { enabled: false }, generated_at: new Date().toISOString() }, headers);
      if (request.method === 'GET' && path === '/api/agents') return sendJson(response, 200, { ok: true, agents: catalog.agents(), generated_at: new Date().toISOString() }, headers);
      const agentSessions = path.match(/^\/api\/agents\/([^/]+)\/sessions$/u); if (request.method === 'GET' && agentSessions) { const agentId = decodeURIComponent(agentSessions[1]); const sessions = catalog.sessions(agentId); return sendJson(response, sessions ? 200 : 404, sessions ? { ok: true, agent_id: agentId, sessions } : { ok: false, error: 'AGENT_NOT_FOUND' }, headers); }
      const sessionMessages = path.match(/^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/messages$/u); if (request.method === 'GET' && sessionMessages) { const agentId = decodeURIComponent(sessionMessages[1]); const sessionId = decodeURIComponent(sessionMessages[2]); const value = catalog.messages(agentId, sessionId); const messages = value?.messages ?? []; const limit = Math.min(integerQuery(url, 'limit', 500), 500); return sendJson(response, value ? 200 : 404, value ? { ok: true, ...value, messages: messages.slice(-limit), truncated: messages.length > limit } : { ok: false, error: 'SESSION_NOT_FOUND' }, headers); }
      if (request.method === 'GET' && path === '/api/hr/alerts') return sendJson(response, 200, { ok: true, alerts: snapshot.hr_alerts }, headers);
      if (request.method === 'GET' && path === '/api/hr/jobs') return sendJson(response, 200, { ok: true, jobs: snapshot.hr_jobs }, headers);
      if (request.method === 'GET' && path === '/api/hr/outputs') return sendJson(response, 200, { ok: true, outputs: snapshot.hr_outputs ?? [] }, headers);
      if (request.method === 'GET' && path === '/api/notifications') return sendJson(response, 200, { ok: true, notifications: snapshot.notifications }, headers);
      if (request.method === 'GET' && path === '/api/snapshots') { await refresh(); return sendJson(response, 200, { ok: true, snapshots: snapshot.snapshots }, headers); }
      const gitSnapshotDiff = path.match(/^\/api\/snapshots\/([^/]+)\/diff$/u); if (request.method === 'GET' && gitSnapshotDiff) { const value = await snapshotService.diff(decodeURIComponent(gitSnapshotDiff[1])); return sendJson(response, 200, { ok: true, ...value }, headers); }
      const gitSnapshot = path.match(/^\/api\/snapshots\/([^/]+)$/u); if (request.method === 'GET' && gitSnapshot) { await refresh(); const value = snapshot.snapshots.find((item) => item.snapshotId === decodeURIComponent(gitSnapshot[1])); return sendJson(response, value ? 200 : 404, value ? { ok: true, snapshot: value } : { ok: false, error: 'SNAPSHOT_NOT_FOUND' }, headers); }
      const workflowSnapshot = path.match(/^\/api\/workflows\/([^/]+)\/snapshot$/u); if (request.method === 'GET' && workflowSnapshot) { await refresh(); const workflow = snapshot.workflows.find((item) => item.workflow_id === decodeURIComponent(workflowSnapshot[1])); return sendJson(response, workflow ? 200 : 404, workflow ? { ok: true, snapshot: { ...snapshot, workflows: [workflow] } } : { ok: false, error: 'WORKFLOW_NOT_FOUND' }, headers); }
      const taskActivity = path.match(/^\/api\/tasks\/([^/]+)\/activity$/u); if (request.method === 'GET' && taskActivity) { const dialogue = telemetry.events({ limit: 500 }).filter((event) => event.task_id === decodeURIComponent(taskActivity[1]) && event.event_type === 'session.assistant_output').map((event) => ({ agent_id: event.payload.agent_id, summary: event.payload.summary, timestamp: event.timestamp })); return sendJson(response, 200, { ok: true, dialogue }, headers); }
      if (request.method === 'GET' && path === '/api/workflows/stream') { const after = integerQuery(url, 'after', Number.parseInt(request.headers['last-event-id'] ?? '0', 10) || 0); response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...headers }); await refresh(); response.write(encodeSse({ sequence: hub.sequence, type: 'snapshot', timestamp: new Date().toISOString(), payload: snapshot, meta: { initial: true, source: snapshot.source } })); for (const event of hub.after(after)) response.write(encodeSse(event)); const unsubscribe = hub.subscribe((event) => response.write(encodeSse(event))); const keepalive = setInterval(() => response.write(': keepalive\n\n'), 15000); keepalive.unref?.(); request.on('close', () => { clearInterval(keepalive); unsubscribe(); }); return; }
      if (request.method === 'POST') { return sendJson(response, 403, { ok: false, error: 'MONITOR_READ_ONLY' }, headers); }
      return sendJson(response, 404, { ok: false, error: 'NOT_FOUND' }, headers);
    } catch (error) { return sendJson(response, error.statusCode ?? 400, { ok: false, error: error.code ?? 'MONITOR_REQUEST_FAILED', message: error.message }, headers); }
  });
  return { server, kernel, repository, telemetry, hub, snapshot: () => snapshot, refresh, sessionCatalog: catalog, async start() { await refresh(); await new Promise((resolveStart, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolveStart(); }); }); return server.address(); }, async close() { clearInterval(timer); if (server.listening) await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); if (ownedDatabase) database.close(); if (!providedTelemetryDatabase) telemetryDatabase.close(); } };
}
