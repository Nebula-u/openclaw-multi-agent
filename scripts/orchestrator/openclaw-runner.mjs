import { spawn } from 'node:child_process';
import { openClawSpawnSpec } from './process-utils.mjs';

export function runOpenClawAgent({ agentId, sessionId, messagePath, timeoutSeconds = 900, deliver = null }) {
  const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message-file', messagePath, '--thinking', 'off', '--timeout', String(timeoutSeconds), '--json'];
  if (deliver) {
    args.push('--deliver');
    if (deliver.reply_channel) args.push('--reply-channel', deliver.reply_channel);
    if (deliver.reply_to) args.push('--reply-to', deliver.reply_to);
  }
  const command = openClawSpawnSpec(args);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.file, command.args, { ...command.options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
    child.once('error', (error) => rejectRun(Object.assign(error, { stdout, stderr })));
    child.once('close', (exitCode, signal) => resolveRun({ exitCode: exitCode ?? -1, signal, stdout, stderr }));
  });
}
