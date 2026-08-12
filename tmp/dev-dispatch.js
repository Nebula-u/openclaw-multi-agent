const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('crypto');
const db = new DatabaseSync('D:/MicroConnect/project/openclaw-multi-agent/runtime/control/control.db');
const now = new Date().toISOString();
const dispatchId = 'DSP-' + randomUUID();
const sessionId = randomUUID();
const idempotencyKey = 'WF-todo-app/TASK-todo-dev/RUN-DEV-001/developer-agent/1';

db.exec('BEGIN IMMEDIATE');
db.prepare(`INSERT INTO dispatches(dispatch_id, idempotency_key, workflow_id, task_id, run_id, agent_id, attempt, status, session_key, session_id, input_manifest_sha256, intent_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(dispatchId, idempotencyKey, 'WF-todo-app', 'TASK-todo-dev', 'RUN-DEV-001',
    'developer-agent', 1, 'RUNNING', 'agent:developer-agent:orchestrator:WF-todo-app:TASK-todo-dev:RUN-DEV-001',
    sessionId, '4a0911ca9d73d45285c7b1ca22e53b5056266f8f219b813286f17845271e24a6', JSON.stringify({dispatch_id: dispatchId}), now, now);
db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = ?').run('RUNNING', now, 'TASK-todo-dev', 'READY');
db.exec('COMMIT');
console.log('dispatch_id=' + dispatchId);
console.log('session_id=' + sessionId);
db.close();
