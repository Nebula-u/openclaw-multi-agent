import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { redactValue } from './redactor.mjs';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const ACTIVE = new Set(['running', 'active', 'starting', 'pending']);

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function textOf(content) {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? '').toLowerCase();
    if (['text', 'input_text', 'output_text'].includes(type) && typeof block.text === 'string' && block.text.trim()) parts.push(block.text);
  }
  return parts.length ? parts.join('\n\n') : null;
}

function sessionStatus(value) {
  if (value.status) return String(value.status).toLowerCase();
  if (value.abortedLastRun) return 'aborted';
  if (value.endedAt) return 'done';
  return 'inactive';
}

function packageAgentIds(projectRoot) {
  const roots = [join(projectRoot, 'agents', 'packages', 'builtin'), join(projectRoot, 'agents', 'packages', 'generated', 'agents')];
  const ids = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        const value = readJson(join(root, entry.name), {});
        if (AGENT_ID.test(value.id ?? '')) ids.add(value.id);
      } else if (entry.isDirectory()) {
        const value = readJson(join(root, entry.name, 'agent.json'), {});
        if (AGENT_ID.test(value.id ?? '')) ids.add(value.id);
      }
    }
  }
  return ids;
}

function indexedSessions(agentId, directory) {
  const sessionsDirectory = join(directory, 'sessions');
  const index = readJson(join(sessionsDirectory, 'sessions.json'), {});
  const byId = new Map();
  if (index && typeof index === 'object' && !Array.isArray(index)) {
    for (const [sessionKey, raw] of Object.entries(index)) {
      if (!raw || typeof raw !== 'object') continue;
      const sessionId = String(raw.sessionId ?? basename(raw.sessionFile ?? '', '.jsonl'));
      if (!SESSION_ID.test(sessionId)) continue;
      byId.set(sessionId, { agent_id: agentId, session_id: sessionId, session_key: sessionKey, status: sessionStatus(raw),
        started_at: iso(raw.sessionStartedAt ?? raw.startedAt), updated_at: iso(raw.updatedAt ?? raw.lastInteractionAt), ended_at: iso(raw.endedAt),
        model: raw.model ?? null, model_provider: raw.modelProvider ?? null, input_tokens: Number.isFinite(raw.inputTokens) ? raw.inputTokens : null,
        output_tokens: Number.isFinite(raw.outputTokens) ? raw.outputTokens : null, total_tokens: Number.isFinite(raw.totalTokens) ? raw.totalTokens : null,
        runtime_ms: Number.isFinite(raw.runtimeMs) ? raw.runtimeMs : null, aborted: Boolean(raw.abortedLastRun) });
    }
  }
  if (existsSync(sessionsDirectory)) {
    for (const entry of readdirSync(sessionsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = basename(entry.name, '.jsonl');
      if (!SESSION_ID.test(sessionId) || byId.has(sessionId)) continue;
      const stats = statSync(join(sessionsDirectory, entry.name));
      byId.set(sessionId, { agent_id: agentId, session_id: sessionId, session_key: null, status: 'inactive', started_at: iso(stats.birthtime),
        updated_at: iso(stats.mtime), ended_at: null, model: null, model_provider: null, input_tokens: null, output_tokens: null,
        total_tokens: null, runtime_ms: null, aborted: false });
    }
  }
  return [...byId.values()].sort((a, b) => String(b.updated_at ?? b.started_at ?? '').localeCompare(String(a.updated_at ?? a.started_at ?? '')));
}

export function createSessionCatalog({ sessionRoot, projectRoot }) {
  const root = resolve(sessionRoot);
  function agentIds() {
    const ids = packageAgentIds(projectRoot);
    if (existsSync(root)) for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && AGENT_ID.test(entry.name)) ids.add(entry.name);
    return [...ids].sort();
  }
  function sessions(agentId) {
    if (!agentIds().includes(agentId)) return null;
    return indexedSessions(agentId, join(root, agentId));
  }
  return {
    agents() {
      return agentIds().map((agentId) => {
        const values = sessions(agentId) ?? [];
        const active = values.filter((item) => ACTIVE.has(item.status)).length;
        return { agent_id: agentId, status: active ? 'running' : (values[0]?.status ?? 'inactive'), session_count: values.length,
          active_session_count: active, latest_session_at: values[0]?.updated_at ?? values[0]?.started_at ?? null };
      });
    },
    sessions,
    messages(agentId, sessionId, { limit = 500 } = {}) {
      const values = sessions(agentId);
      const session = values?.find((item) => item.session_id === sessionId);
      if (!session) return null;
      const path = join(root, agentId, 'sessions', `${sessionId}.jsonl`);
      if (!existsSync(path)) return { session, messages: [], truncated: false };
      const messages = [];
      for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/u).entries()) {
        if (!line.trim()) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.type !== 'message' || !record.message) continue;
        const role = String(record.message.role ?? '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') continue;
        const text = textOf(record.message.content);
        if (!text) continue;
        messages.push(redactValue({ message_id: String(record.id ?? `${sessionId}:${index + 1}`), role, text,
          timestamp: iso(record.message.timestamp ?? record.timestamp) }, { maxStringLength: 16000, maxArrayLength: 500 }));
      }
      const bounded = Math.min(Math.max(Number(limit) || 500, 1), 500);
      return { session, messages: messages.slice(-bounded), truncated: messages.length > bounded, total_messages: messages.length };
    },
  };
}
