import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('D:/MicroConnect/project/openclaw-multi-agent/runtime/control/control.db');
const now = new Date().toISOString();
const dispatchId = 'DSP-' + randomUUID();
const sessionId = randomUUID();

db.exec('BEGIN IMMEDIATE');
db.prepare(`INSERT INTO dispatches(dispatch_id, idempotency_key, workflow_id, task_id, run_id, agent_id, attempt, status, session_key, session_id, input_manifest_sha256, intent_json, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(dispatchId, 'WF-todo-app/TASK-todo-review/RUN-REV-001/review-agent/1', 'WF-todo-app', 'TASK-todo-review', 'RUN-REV-001',
    'review-agent', 1, 'RUNNING', 'agent:review-agent:orchestrator:WF-todo-app:TASK-todo-review:RUN-REV-001',
    sessionId, '5bcbd77179b0f1a28f263b8f16c1b4c19aa6e6995d717e2aee502664d64b8aac', JSON.stringify({dispatch_id: dispatchId}), now, now);
db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ? AND status = ?').run('RUNNING', now, 'TASK-todo-review', 'READY');
db.exec('COMMIT');
console.log('dispatch_id=' + dispatchId);
console.log('session_id=' + sessionId);
db.close();
