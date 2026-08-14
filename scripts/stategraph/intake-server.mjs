import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function sameSecret(expected, supplied) {
  const left = Buffer.from(String(expected ?? '').trim());
  const right = Buffer.from(String(supplied ?? '').trim());
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

async function body(request, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error('request body too large'), { statusCode: 413, code: 'BODY_TOO_LARGE' }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }); }
}

function workflowId(uuid = randomUUID) { return `WF-${uuid().replaceAll('-', '')}`; }
function authorized(request, token) { return sameSecret(token, String(request.headers.authorization ?? '').replace(/^Bearer\s+/iu, '')); }

export function createWorkflowIntakeServer({ runtime, projectRoot, token, host = '127.0.0.1', port = 4320, intervalMs = 2000, maxTurns = 8, requestBodyLimit = 65536, uuid = randomUUID } = {}) {
  if (!runtime || !projectRoot || !token) throw new Error('runtime, projectRoot and intake token are required');
  let timer = null; let advancing = false;
  async function advance(workflowId) {
    let last = null;
    for (let turn = 0; turn < maxTurns; turn += 1) {
      last = await runtime.run(workflowId);
      if (['WAITING_HUMAN', 'TERMINAL', 'HOLD'].includes(last.condition) || ['TASK_RUNNING', 'TASK_DISPATCHED', 'JSON_REPAIR_READY'].includes(last.stop_reason)) break;
    }
    return last;
  }
  async function scan() {
    if (advancing) return; advancing = true;
    try { for (const state of await runtime.list()) if (state.condition === 'ACTIVE') await advance(state.workflowId); }
    finally { advancing = false; }
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, `http://${request.headers.host ?? host}`).pathname;
      if (request.method === 'GET' && pathname === '/health') return json(response, 200, { ok: true, service: 'stategraph-intake', writable: true });
      if (!authorized(request, token)) return json(response, 401, { ok: false, error: 'UNAUTHORIZED' });
      if (request.method === 'POST' && pathname === '/api/workflows') {
        const value = await body(request, requestBodyLimit);
        if (typeof value.text !== 'string' || !value.text.trim()) return json(response, 400, { ok: false, error: 'REQUEST_TEXT_REQUIRED' });
        if (typeof value.project_path_abs !== 'string' || !isAbsolute(value.project_path_abs) || !existsSync(resolve(value.project_path_abs))) return json(response, 400, { ok: false, error: 'PROJECT_PATH_INVALID' });
        const id = workflowId(uuid);
        const created = await runtime.bootstrap({ workflowId: id, request: { text: value.text.trim(), project_path_abs: resolve(value.project_path_abs), source: 'WEBCHAT_INTAKE', submitted_at: new Date().toISOString() } });
        const progressed = created.condition === 'ACTIVE' ? await advance(id) : created;
        return json(response, 201, { ok: true, workflow_id: id, workflow: progressed });
      }
      const approval = pathname.match(/^\/api\/workflows\/(WF-[A-Za-z0-9-]+)\/approve$/u);
      if (request.method === 'POST' && approval) {
        const value = await body(request, requestBodyLimit);
        if (typeof value.decision_id !== 'string' || typeof value.choice !== 'string' || !/^human:[A-Za-z0-9._-]+$/u.test(value.decided_by ?? '')) return json(response, 400, { ok: false, error: 'APPROVAL_COMMAND_INVALID' });
        const approved = await runtime.approve(approval[1], { decision_id: value.decision_id, choice: value.choice, decided_by: value.decided_by, notes: typeof value.notes === 'string' ? value.notes : '', decided_at: new Date().toISOString() });
        const progressed = approved.condition === 'ACTIVE' ? await advance(approval[1]) : approved;
        return json(response, 200, { ok: true, workflow_id: approval[1], workflow: progressed });
      }
      return json(response, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) { return json(response, error.statusCode ?? 500, { ok: false, error: error.code ?? 'INTAKE_ERROR', message: error.message }); }
  });
  return { server, scan, async start() { await new Promise((ok, fail) => server.listen(port, host, (error) => error ? fail(error) : ok())); timer = setInterval(() => void scan(), intervalMs); timer.unref?.(); return server.address(); }, async close() { clearInterval(timer); if (server.listening) await new Promise((ok, fail) => server.close((error) => error ? fail(error) : ok())); } };
}
