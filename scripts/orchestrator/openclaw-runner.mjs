import { spawn } from 'node:child_process';
import { openClawSpawnSpec, terminateProcessTree } from './process-utils.mjs';

const EXPLICIT_DELIVERY_CHANNELS = new Set([
  'last', 'telegram', 'whatsapp', 'discord', 'irc', 'googlechat', 'slack', 'signal', 'imessage',
  'feishu', 'nostr', 'msteams', 'mattermost', 'nextcloud-talk', 'matrix', 'raft', 'line', 'zalo',
  'clickclack', 'zalouser', 'sms', 'synology-chat', 'tlon', 'qa-channel', 'qqbot', 'twitch',
]);

export function deliveryArgs(deliver) {
  if (!deliver) return [];
  const channel = String(deliver.reply_channel ?? '').trim();
  const replyTo = String(deliver.reply_to ?? '').trim();

  // webchat is represented by the native session. There is no OpenClaw
  // channel id to pass, so persist the turn to that session without --deliver.
  if (!channel || channel === 'webchat') return [];
  if (!EXPLICIT_DELIVERY_CHANNELS.has(channel)) {
    throw Object.assign(new Error(`unsupported OpenClaw delivery channel: ${channel}`), {
      code: 'OPENCLAW_DELIVERY_CHANNEL_UNSUPPORTED',
      details: { channel },
    });
  }
  const args = ['--deliver', '--reply-channel', channel];
  if (replyTo) args.push('--reply-to', replyTo);
  return args;
}

export function buildOpenClawAgentArgs({ agentId, sessionId, messagePath, timeoutSeconds = 900, deliver = null }) {
  const args = ['agent', '--agent', agentId, '--session-id', sessionId, '--message-file', messagePath, '--thinking', 'off', '--timeout', String(timeoutSeconds), '--json'];
  args.push(...deliveryArgs(deliver));
  return args;
}

export function runOpenClawAgent({ agentId, sessionId, messagePath, timeoutSeconds = 900, deliver = null, signal = null }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('OpenClaw Agent launch was cancelled before dispatch'), { code: 'ORCHESTRATOR_SHUTDOWN' }));
  const args = buildOpenClawAgentArgs({ agentId, sessionId, messagePath, timeoutSeconds, deliver });
  const command = openClawSpawnSpec(args);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command.file, command.args, { ...command.options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      const stopped = terminateProcessTree(child.pid);
      if (!stopped.ok) child.kill();
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
    signal?.addEventListener('abort', cancel, { once: true });
    child.once('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      rejectRun(Object.assign(error, { stdout, stderr }));
    });
    child.once('close', (exitCode, closeSignal) => {
      signal?.removeEventListener('abort', cancel);
      resolveRun({ exitCode: exitCode ?? -1, signal: closeSignal, stdout, stderr, cancelled });
    });
  });
}
