import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { redactValue } from './redactor.mjs';

function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value); }
function json(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function directories(path) { try { return readdirSync(path, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name); } catch { return []; } }
function sessionFiles(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.jsonl') && safeId(basename(item.name, '.jsonl')))
      .map((item) => ({ session_id: basename(item.name, '.jsonl'), session_file: join(path, item.name), updated_at: new Date(statSync(join(path, item.name)).mtimeMs).toISOString() }));
  } catch { return []; }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text).join('\n');
}

export function createSessionCatalog({ sessionRoot, projectRoot }) {
  const root = resolve(sessionRoot);
  function packageAgents() {
    const directory = join(resolve(projectRoot), 'agents', 'packages', 'builtin');
    try {
      return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => json(join(directory, name), null)?.id).filter(safeId);
    } catch { return []; }
  }
  function agentIds() { return [...new Set([...packageAgents(), ...directories(root).filter(safeId)])].sort(); }
  function sessions(agentId) {
    if (!safeId(agentId) || !agentIds().includes(agentId)) return null;
    const directory = join(root, agentId, 'sessions');
    const index = json(join(directory, 'sessions.json'), {});
    const indexed = Object.entries(index).map(([sessionKey, value]) => ({
      session_id: value.sessionId ?? (basename(value.sessionFile ?? '', '.jsonl') || null),
      session_key: sessionKey,
      status: value.status ?? 'unknown',
      model: value.model ?? null,
      total_tokens: value.totalTokens ?? null,
      started_at: value.sessionStartedAt ? new Date(value.sessionStartedAt).toISOString() : null,
      updated_at: value.updatedAt ? new Date(value.updatedAt).toISOString() : null,
      ended_at: value.endedAt ? new Date(value.endedAt).toISOString() : null,
    })).filter((item) => safeId(item.session_id));
    const known = new Set(indexed.map((item) => item.session_id));
    for (const file of sessionFiles(directory)) if (!known.has(file.session_id)) indexed.push({ ...file, session_key: null, status: 'unindexed', model: null, total_tokens: null, started_at: null, ended_at: null });
    return indexed.sort((left, right) => Date.parse(right.updated_at ?? 0) - Date.parse(left.updated_at ?? 0));
  }
  function messages(agentId, sessionId) {
    const list = sessions(agentId);
    if (!list || !safeId(sessionId) || !list.some((item) => item.session_id === sessionId)) return null;
    const path = join(root, agentId, 'sessions', `${sessionId}.jsonl`);
    if (!existsSync(path)) return { agent_id: agentId, session_id: sessionId, messages: [] };
    const values = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== 'message' || !['user', 'assistant'].includes(record.message?.role)) continue;
      const text = textContent(record.message.content);
      if (!text) continue;
      values.push({ role: record.message.role, text: redactValue(text), timestamp: record.timestamp ?? null });
    }
    return { agent_id: agentId, session_id: sessionId, messages: values };
  }
  return {
    agents() {
      return agentIds().map((agentId) => {
        const values = sessions(agentId) ?? [];
        return { agent_id: agentId, status: values[0]?.status ?? 'inactive', session_count: values.length, latest_session_at: values[0]?.updated_at ?? null };
      });
    },
    sessions,
    messages,
  };
}
