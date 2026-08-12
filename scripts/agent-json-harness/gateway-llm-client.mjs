import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MAX_AGENT_TIMEOUT_MS, validateAgentTimeoutMs } from './timeout-policy.mjs';

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function defaultPackageRoots({ platform, env }) {
  const roots = [];
  if (env.OPENCLAW_PACKAGE_ROOT) roots.push(env.OPENCLAW_PACKAGE_ROOT);
  if (platform === 'win32' && env.APPDATA) roots.push(join(env.APPDATA, 'npm', 'node_modules'));
  if (env.npm_config_prefix) {
    roots.push(join(env.npm_config_prefix, 'lib', 'node_modules'));
    roots.push(join(env.npm_config_prefix, 'node_modules'));
  }
  for (const [command, args] of [['pnpm', ['root', '-g']], ['npm', ['root', '-g']]]) {
    const root = commandOutput(command, args);
    if (root) roots.push(root);
  }
  return [...new Set(roots)];
}

export function resolveInstalledOpenClawRoot({ platform = process.platform, env = process.env, roots } = {}) {
  const candidates = roots ?? defaultPackageRoots({ platform, env });
  const checked = [];
  for (const candidate of candidates) {
    for (const root of [candidate, join(candidate, 'openclaw')]) {
      checked.push(root);
      if (existsSync(join(root, 'dist'))) return root;
    }
  }
  throw new Error(`OpenClaw package not found. Checked: ${checked.join(', ') || '<no package roots discovered>'}`);
}

async function loadGatewayChatClient() {
  const dist = join(resolveInstalledOpenClawRoot(), 'dist');
  const moduleName = readdirSync(dist).find((name) => /^gateway-chat-.*\.js$/u.test(name));
  if (!moduleName) throw new Error('OpenClaw Gateway chat client module was not found.');
  const module = await import(pathToFileURL(join(dist, moduleName)).href);
  if (!module.GatewayChatClient) throw new Error('OpenClaw Gateway chat client export was not found.');
  return module.GatewayChatClient;
}

function hasToolCall(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.function_call || message.tool_call || message.tool_calls || message.custom_tool_call || message.web_search_call) return true;
  return Array.isArray(message.content) && message.content.some((part) => /^(function_call|tool_call|tool_use|custom_tool_call|web_search_call)$/u.test(part?.type ?? ''));
}

export function textFromMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.role !== 'assistant') return null;
  if (typeof message.content === 'string') return message.content;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    const text = message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
    return text.length > 0 || !hasToolCall(message) ? text : null;
  }
  if (hasToolCall(message)) return null;
  return null;
}

function assistantReplies(history) {
  const messages = Array.isArray(history?.messages) ? history.messages : Array.isArray(history) ? history : [];
  return messages.map(textFromMessage).filter((text) => text !== null);
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(operation, milliseconds, label) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms.`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function connectGatewayLlmClient({ connectTimeoutMs = 30000 } = {}) {
  connectTimeoutMs = validateAgentTimeoutMs(connectTimeoutMs, 'Gateway connection timeout');
  const GatewayChatClient = await loadGatewayChatClient();
  let client = null;
  let reconnecting = null;

  async function establish() {
    // Newer Gateway clients can wait indefinitely inside connect().  Bound
    // both connection phases so a harness always reaches its final report.
    const next = await withTimeout(GatewayChatClient.connect({}), connectTimeoutMs, 'Gateway connection');
    next.start();
    await withTimeout(next.waitForReady(), connectTimeoutMs, 'Gateway connection');
    client = next;
  }

  async function reconnect() {
    if (!reconnecting) {
      reconnecting = (async () => {
        client?.stop();
        client = null;
        await establish();
      })().finally(() => { reconnecting = null; });
    }
    await reconnecting;
  }

  function isDisconnected(error) {
    return /gateway not connected|socket.*closed|websocket.*closed|connection.*closed/iu.test(error.message);
  }

  async function request(operation, timeoutMs, label) {
    try {
      return await withTimeout(operation(client), timeoutMs, label);
    } catch (error) {
      if (!isDisconnected(error)) throw error;
      await reconnect();
      return await withTimeout(operation(client), timeoutMs, label);
    }
  }

  await establish();
  return {
    async send({ agentId, sessionKey, prompt, expectedReplyCount = 1, timeoutMs = MAX_AGENT_TIMEOUT_MS }) {
      timeoutMs = validateAgentTimeoutMs(timeoutMs);
      try {
        await request(
          (active) => active.sendChat({ agentId, sessionKey, message: prompt, deliver: false, thinking: 'off', timeoutMs }),
          timeoutMs,
          'Gateway chat.send',
        );
      } catch (error) {
        // Cleanup must never extend the caller's failed-request budget.  In
        // particular, a disconnected Gateway used to make `request()` try a
        // full reconnect here, leaving contract runs stuck after a timeout.
        // An abort is best-effort; use the current connection only and cap it.
        await withTimeout(
          Promise.resolve(client?.abortChat({ agentId, sessionKey })),
          5000,
          'Gateway chat.abort',
        ).catch(() => {});
        throw error;
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const history = await request((active) => active.loadHistory({ agentId, sessionKey, limit: 100 }), 15000, 'Gateway chat.history');
        const replies = assistantReplies(history);
        if (replies.length >= expectedReplyCount) return replies.at(-1);
        await sleep(400);
      }
      throw new Error(`Gateway did not return an assistant reply within ${timeoutMs}ms.`);
    },
    close() {
      client?.stop();
    },
    reconnect,
  };
}
