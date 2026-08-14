import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowIntakeServer } from '../scripts/stategraph/intake-server.mjs';

test('intake creates and advances a workflow without granting manager runtime authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stategraph-intake-'));
  const calls = [];
  const runtime = {
    async bootstrap(value) { calls.push(['bootstrap', value]); return { condition: 'ACTIVE' }; },
    async run(id) { calls.push(['run', id]); return { condition: 'ACTIVE', stop_reason: 'TASK_DISPATCHED' }; },
    async approve(id, command) { calls.push(['approve', id, command]); return { condition: 'WAITING_HUMAN' }; },
    async list() { return []; },
  };
  const intake = createWorkflowIntakeServer({ runtime, projectRoot: root, token: 'secret', port: 0, intervalMs: 60000, uuid: () => '11111111-1111-1111-1111-111111111111' });
  const address = await intake.start();
  try {
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/workflows`, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401);
    const created = await fetch(`http://127.0.0.1:${address.port}/api/workflows`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: '实现聊天室', project_path_abs: root }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).workflow_id, 'WF-11111111111111111111111111111111');
    assert.equal(calls[0][0], 'bootstrap');
    assert.equal(calls[1][0], 'run');
  } finally { await intake.close(); }
});
