import { readFileSync } from 'node:fs';

const sessionFile = 'C:/Users/liuxu/.openclaw/agents/developer-agent/sessions/dbaacb8a-69ac-4915-baa7-339853c5f598.jsonl';
const repoDir = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/worktrees/WF-todo-app/TASK-todo-dev/RUN-DEV-001/repo';
const artifactDir = 'D:/MicroConnect/project/openclaw-multi-agent/runtime/artifacts/WF-todo-app/TASK-todo-dev/RUN-DEV-001';

let lastLineCount = 0;
const maxWait = 300; // 300 seconds
let waited = 0;

while (waited < maxWait) {
  await new Promise(r => setTimeout(r, 15000));
  waited += 15;
  
  try {
    const content = readFileSync(sessionFile, 'utf8');
    const lines = content.trim().split('\n');
    const currentCount = lines.length;
    
    try {
      const last = JSON.parse(lines[lines.length - 1]);
      const role = last.message?.role || 'unknown';
      const timestamp = last.timestamp || 'unknown';
      
      if (lastLineCount === currentCount && role === 'assistant' && waited > 45) {
        // Check if response contains COMPLETED or NO_REPLY
        const text = last.message?.content?.find(c => c.type === 'text')?.text || '';
        if (text.includes('COMPLETED') || text.includes('completion')) {
          console.log('LIKELY COMPLETED at', timestamp);
          process.exit(0);
        }
        // Not completed and no new messages - agent is probably done
        if (waited > 120) {
          console.log('No activity for extended period - assuming completed or stuck');
          process.exit(2);
        }
      }
      
      console.log(`[${waited}s] Lines: ${currentCount} | Last: ${role} @ ${timestamp}`);
      lastLineCount = currentCount;
    } catch (e) {
      console.log(`[${waited}s] Error reading last line: ${e.message}`);
    }
    
    // Check if agent wrote result
    try {
      const resultRaw = readFileSync(artifactDir + '/.agent-raw/result.json.raw', 'utf8');
      console.log('FOUND result.json.raw! Agent completed writing results.');
      process.exit(0);
    } catch (e) {
      // not written yet
    }
  } catch (e) {
    console.log(`[${waited}s] Session file read error: ${e.message}`);
  }
}
console.log('Timeout reached');
process.exit(1);
