import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('D:/MicroConnect/project/openclaw-multi-agent/runtime/control/control.db');
const resultPath = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/artifacts/WF-todo-app/TASK-todo-dev/RUN-DEV-001/.agent-raw/result.json.raw';
const sha256 = createHash('sha256').update(readFileSync(resultPath)).digest('hex');
const now = new Date().toISOString();

const completion = JSON.stringify({
  schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: 'CMP-manual-dev-' + Date.now(),
  dispatch_id: 'DSP-4ca6ec25-046a-4d5c-ba98-4d4f4337f998',
  idempotency_key: 'WF-todo-app/TASK-todo-dev/RUN-DEV-001/developer-agent/1',
  workflow_id: 'WF-todo-app', task_id: 'TASK-todo-dev', run_id: 'RUN-DEV-001',
  agent_id: 'developer-agent', attempt: 1, status: 'SUCCEEDED',
  session_key: 'agent:developer-agent:orchestrator:WF-todo-app:TASK-todo-dev:RUN-DEV-001',
  session_id: 'dbaacb8a-69ac-4915-baa7-339853c5f598',
  result_path_abs: resultPath, result_sha256: sha256,
  error_code: null, error_message: null, completed_at: now,
});

db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE dispatches SET status = ?, completion_json = ?, updated_at = ? WHERE dispatch_id = ?')
  .run('SUCCEEDED', completion, now, 'DSP-4ca6ec25-046a-4d5c-ba98-4d4f4337f998');
db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
  .run('COMPLETED', now, 'TASK-todo-dev');
db.exec('COMMIT');
console.log('Development task COMPLETED');
db.close();
