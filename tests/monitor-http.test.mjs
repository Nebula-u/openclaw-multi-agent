import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { createMonitorServer } from '../monitor/server.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-monitor-http';

async function setup(overrides = {}) {
  const database = openControlDatabase(':memory:');
  const controls = createControlRepository(ROOT, database);
  controls.apply({
    schema_version: 1, command_id: `CMD-${randomUUID()}`, workflow_id: WORKFLOW_ID,
    expected_revision: 0, command_type: 'BOOTSTRAP', actor: 'manager-agent',
    occurred_at: '2026-08-06T10:00:00.000Z', reason: 'monitor HTTP test',
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: 'a'.repeat(64) },
  });
  const monitor = createMonitorServer({
    projectRoot: ROOT, databasePath: ':memory:', host: '127.0.0.1', port: 0, token: 'test-token',
    allowedOrigins: ['null'], reconcileIntervalMs: 20, sseRetention: 100, requestBodyLimit: 65536, ...overrides,
  }, { database });
  const address = await monitor.start();
  return { monitor, database, base: `http://127.0.0.1:${address.port}`, close: () => monitor.close() };
}

test('monitor HTTP exposes health, workflows and workflow snapshot', async () => {
  const value = await setup();
  try {
    const health = await fetch(`${value.base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'HEALTHY');
    const clientConfig = await (await fetch(`${value.base}/api/client-config`, { headers: { origin: 'null' } })).json();
    assert.equal(clientConfig.local_only, true);
    assert.equal(clientConfig.read_only, true);
    const workflows = await (await fetch(`${value.base}/api/workflows`)).json();
    assert.equal(workflows.workflows[0].workflow_id, WORKFLOW_ID);
    const snapshot = await (await fetch(`${value.base}/api/workflows/${WORKFLOW_ID}/snapshot`)).json();
    assert.equal(snapshot.snapshot.workflows[0].workflow_id, WORKFLOW_ID);
    const missing = await fetch(`${value.base}/api/workflows/WF-missing/snapshot`);
    assert.equal(missing.status, 404);
  } finally { await value.close(); }
});

test('monitor exposes persistent agent sessions and safe conversation messages', async () => {
  const sessionRoot = await mkdtemp(join(tmpdir(), 'monitor-http-sessions-'));
  mkdirSync(join(sessionRoot, 'architect-agent', 'sessions'), { recursive: true });
  writeFileSync(join(sessionRoot, 'architect-agent', 'sessions', 'sessions.json'), JSON.stringify({
    key: { sessionId: 'session-http', status: 'done', totalTokens: 99, updatedAt: Date.now() },
  }));
  writeFileSync(join(sessionRoot, 'architect-agent', 'sessions', 'session-http.jsonl'), JSON.stringify({
    type: 'message', timestamp: '2026-08-12T00:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '架构已经完成' }] },
  }));
  const value = await setup({ sessionRoot });
  try {
    const agents = await (await fetch(`${value.base}/api/agents`)).json();
    assert.ok(agents.agents.some((item) => item.agent_id === 'architect-agent'));
    const sessions = await (await fetch(`${value.base}/api/agents/architect-agent/sessions`)).json();
    assert.equal(sessions.sessions[0].total_tokens, 99);
    const messages = await (await fetch(`${value.base}/api/agents/architect-agent/sessions/session-http/messages`)).json();
    assert.equal(messages.messages[0].text, '架构已经完成');
    assert.equal((await fetch(`${value.base}/api/agents/architect-agent/sessions/missing/messages`)).status, 404);
  } finally { await value.close(); await rm(sessionRoot, { recursive: true, force: true }); }
});

test('monitor remains reachable while reporting a degraded control audit', async () => {
  const value = await setup();
  try {
    const state = JSON.parse(value.database.prepare('SELECT state_json FROM workflows WHERE workflow_id=?').get(WORKFLOW_ID).state_json);
    state.phase = 'TAMPERED';
    value.database.prepare("UPDATE workflows SET phase='TAMPERED', state_json=? WHERE workflow_id=?").run(JSON.stringify(state), WORKFLOW_ID);
    const health = await fetch(`${value.base}/api/health`);
    const body = await health.json();
    assert.equal(health.status, 200);
    assert.equal(body.api_reachable, true);
    assert.equal(body.ok, false);
    assert.equal(body.status, 'DEGRADED');
  } finally { await value.close(); }
});

test('monitor rejects unknown origins and exposes no public mutation endpoint', async () => {
  const value = await setup();
  try {
    const rejectedOrigin = await fetch(`${value.base}/api/workflows`, { headers: { origin: 'https://example.invalid' } });
    assert.equal(rejectedOrigin.status, 403);
    const body = {
      schema_version: 1, request_id: 'SUP-monitor-http', idempotency_key: `${WORKFLOW_ID}/NUDGE/window-1`,
      workflow_id: WORKFLOW_ID, request_type: 'NUDGE', source: 'LOCAL_USER', reason: 'Please report progress',
      evidence: { source: 'dashboard' }, requested_at: '2026-08-06T10:00:01.000Z',
    };
    const supervisionWrite = await fetch(`${value.base}/api/supervision/request`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: JSON.stringify(body),
    });
    assert.equal(supervisionWrite.status, 404);
    const activityWrite = await fetch(`${value.base}/api/activity`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: JSON.stringify({}),
    });
    assert.equal(activityWrite.status, 404);
  } finally { await value.close(); }
});

test('monitor exposes only user-safe dialogue sourced by local collectors', async () => {
  const value = await setup();
  try {
    value.monitor.telemetry.addEvent({
      schema_version: 1, event_id: 'MEVT-monitor-dialogue', workflow_id: WORKFLOW_ID, task_id: null, run_id: null, session_id: 'session-1',
      topic: 'agent.activity', event_type: 'session.assistant_output', producer: 'session-tailer', source: 'SESSION_TAILER',
      timestamp: '2026-08-06T10:00:02.000Z', payload: { agent_id: 'manager-agent', summary: 'Control state is healthy' },
      meta: { redacted: true, inferred: true, confidence: 'MEDIUM' },
    });
    const history = await (await fetch(`${value.base}/api/agents/manager-agent/activity`)).json();
    assert.equal(history.dialogue[0].summary, 'Control state is healthy');
  } finally { await value.close(); }
});
