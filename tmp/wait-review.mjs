import { readFileSync, existsSync } from 'node:fs';

const sessionFile = 'C:/Users/liuxu/.openclaw/agents/review-agent/sessions/ea6d80ea-cef8-4e03-80d8-8db34457629c.jsonl';
const rawResult = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/artifacts/WF-todo-app/TASK-todo-review/RUN-REV-001/.agent-raw/result.json.raw';

let waited = 0;
const maxWait = 420;

while (waited < maxWait) {
  await new Promise(r => setTimeout(r, 20000));
  waited += 20;

  if (existsSync(rawResult)) {
    console.log(`[${waited}s] result.json.raw FOUND! Review completed.`);
    process.exit(0);
  }

  try {
    const content = readFileSync(sessionFile, 'utf8');
    const lines = content.trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    console.log(`[${waited}s] lines=${lines.length} role=${last.message?.role || '?'} @ ${last.timestamp}`);
  } catch (e) {
    console.log(`[${waited}s] Error: ${e.message}`);
  }
}
console.log('Timeout');
process.exit(1);
