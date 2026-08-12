import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('D:/MicroConnect/project/openclaw-multi-agent/runtime/control/control.db');
const resultPath = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/artifacts/WF-todo-app/TASK-todo-review/RUN-REV-001/.agent-raw/result.json.raw';
const sha256 = createHash('sha256').update(readFileSync(resultPath)).digest('hex');
const now = new Date().toISOString();

const completion = JSON.stringify({
  schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: 'CMP-manual-review-' + Date.now(),
  dispatch_id: 'DSP-dd98b6f3-ecce-4326-9dad-df97907f3d71',
  idempotency_key: 'WF-todo-app/TASK-todo-review/RUN-REV-001/review-agent/1',
  workflow_id: 'WF-todo-app', task_id: 'TASK-todo-review', run_id: 'RUN-REV-001',
  agent_id: 'review-agent', attempt: 1, status: 'SUCCEEDED',
  session_key: 'agent:review-agent:orchestrator:WF-todo-app:TASK-todo-review:RUN-REV-001',
  session_id: 'ea6d80ea-cef8-4e03-80d8-8db34457629c',
  result_path_abs: resultPath, result_sha256: sha256,
  error_code: null, error_message: null, completed_at: now,
});

db.exec('BEGIN IMMEDIATE');
db.prepare('UPDATE dispatches SET status = ?, completion_json = ?, updated_at = ? WHERE dispatch_id = ?')
  .run('SUCCEEDED', completion, now, 'DSP-dd98b6f3-ecce-4326-9dad-df97907f3d71');
db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
  .run('COMPLETED', now, 'TASK-todo-review');
db.exec('COMMIT');
console.log('Review task COMPLETED');
db.close();
