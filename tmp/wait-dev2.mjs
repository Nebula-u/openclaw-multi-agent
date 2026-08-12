import { readFileSync, existsSync } from 'node:fs';

const sessionFile = 'C:/Users/liuxu/.openclaw/agents/developer-agent/sessions/dbaacb8a-69ac-4915-baa7-339853c5f598.jsonl';
const rawResult = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/artifacts/WF-todo-app/TASK-todo-dev/RUN-DEV-001/.agent-raw/result.json.raw';
const nodeModules = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/worktrees/WF-todo-app/TASK-todo-dev/RUN-DEV-001/repo/node_modules';

let waited = 0;
const maxWait = 420;

while (waited < maxWait) {
  await new Promise(r => setTimeout(r, 20000));
  waited += 20;
  
  if (existsSync(rawResult)) {
    console.log(`[${waited}s] result.json.raw FOUND! Agent completed.`);
    process.exit(0);
  }
  
  if (existsSync(nodeModules)) {
    console.log(`[${waited}s] node_modules exists, npm install completed. Waiting for agent to write results...`);
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
