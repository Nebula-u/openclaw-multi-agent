import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function safeId(value) {
  const id = String(value ?? 'default');
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(id)) throw Object.assign(new Error('conversation id is invalid'), { code: 'CONVERSATION_ID_INVALID' });
  return id;
}

export function createConversationStore({ runtimeRoot, directory = null } = {}) {
  const root = resolve(directory ?? join(runtimeRoot ?? process.cwd(), 'monitor', 'conversations'));
  mkdirSync(root, { recursive: true });
  function pathFor(id) { return join(root, `${safeId(id)}.jsonl`); }
  function append(id, value) {
    const record = { schema_version: 1, recorded_at: new Date().toISOString(), ...value };
    appendFileSync(pathFor(id), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
  function list(id, limit = 200) {
    const path = pathFor(id);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).slice(-Math.max(1, limit)).map((line) => JSON.parse(line));
  }
  return { root, append, list };
}
