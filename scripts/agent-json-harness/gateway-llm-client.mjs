import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function installedOpenClawRoot() {
  if (process.platform !== 'win32' || !process.env.APPDATA) {
    throw new Error('This harness requires the locally installed OpenClaw Gateway client.');
  }
  const root = join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw');
  if (!existsSync(root)) throw new Error(`OpenClaw package not found: ${root}`);
  return root;
}

async function loadGatewayChatClient() {
  const dist = join(installedOpenClawRoot(), 'dist');
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
  const GatewayChatClient = await loadGatewayChatClient();
  let client = null;
  let reconnecting = null;

  async function establish() {
    const next = await GatewayChatClient.connect({});
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
    async send({ agentId, sessionKey, prompt, expectedReplyCount = 1, timeoutMs = 600000 }) {
      try {
        await request(
          (active) => active.sendChat({ agentId, sessionKey, message: prompt, deliver: false, thinking: 'off', timeoutMs }),
          timeoutMs,
          'Gateway chat.send',
        );
      } catch (error) {
        await request((active) => active.abortChat({ agentId, sessionKey }), 5000, 'Gateway chat.abort').catch(() => {});
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
