import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactValue } from '../../monitor/redactor.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DEFAULT_LIMITS = Object.freeze({ thinkingChars: 12000, finalChars: 8000, patchChars: 40000 });

function inside(root, path) { const value = relative(resolve(root), resolve(path)); return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)); }
function bounded(text, limit) {
  const source = String(text ?? '');
  const safe = redactValue(source, { maxStringLength: Number.MAX_SAFE_INTEGER });
  const retained = safe.slice(0, limit);
  return { text: retained, truncated: safe.length > limit, original_chars: source.length, retained_chars: retained.length };
}
function blockText(block) {
  for (const key of ['thinking', 'reasoning', 'text', 'content']) if (typeof block?.[key] === 'string') return block[key];
  return '';
}
function contentBlocks(content) { return Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : []; }

export function buildSessionDossier({ sessionRoot, agentId, sessionId, snapshot = null, patch = '', limits = {} }) {
  if (!SAFE_ID.test(agentId ?? '') || !SAFE_ID.test(sessionId ?? '')) throw Object.assign(new Error('unsafe Agent or Session id'), { code: 'HR_SESSION_ID_UNSAFE' });
  const root = realpathSync.native(resolve(sessionRoot));
  const path = resolve(join(root, agentId, 'sessions', `${sessionId}.jsonl`));
  if (!inside(root, path)) throw Object.assign(new Error('Session path escapes configured root'), { code: 'HR_SESSION_PATH_ESCAPE' });
  if (!existsSync(path)) throw Object.assign(new Error(`Session transcript is missing: ${sessionId}`), { code: 'HR_SESSION_MISSING' });
  const canonicalPath = realpathSync.native(path);
  if (!inside(root, canonicalPath)) throw Object.assign(new Error('Session path escapes configured root'), { code: 'HR_SESSION_PATH_ESCAPE' });
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error('Session transcript must be a regular file'), { code: 'HR_SESSION_UNSAFE' });
  const selectedLimits = { ...DEFAULT_LIMITS, ...limits }; const thinking = []; let final = null; let thinkingRemaining = selectedLimits.thinkingChars;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue; let record; try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'message' || record.message?.role !== 'assistant') continue;
    const visible = [];
    for (const block of contentBlocks(record.message.content)) {
      const type = String(block?.type ?? '').toLowerCase();
      const text = blockText(block); if (!text) continue;
      if ((type.includes('thinking') || type.includes('reasoning')) && thinkingRemaining > 0) {
        const value = bounded(text, thinkingRemaining); thinkingRemaining -= value.retained_chars;
        thinking.push({ kind: 'THINKING', timestamp: record.timestamp ?? record.message.timestamp ?? null, ...value });
      }
      else if (type === 'text' || type === 'output_text') visible.push(text);
    }
    if (visible.length) final = { kind: 'FINAL_OUTPUT', timestamp: record.timestamp ?? record.message.timestamp ?? null,
      ...bounded(visible.join('\n'), selectedLimits.finalChars) };
  }
  const messages = [...thinking, ...(final ? [final] : [])];
  const patchValue = bounded(patch, selectedLimits.patchChars);
  return {
    schema_version: 1, agent_id: agentId, session_id: sessionId,
    messages,
    git: snapshot ? { snapshot_id: snapshot.snapshotId, input_commit: snapshot.inputCommit,
      output_commit: snapshot.outputCommit, snapshot_kind: snapshot.snapshotKind ?? null,
      change_summary: snapshot.changeSummary ?? {}, patch: patchValue.text, patch_truncated: patchValue.truncated,
      patch_original_chars: patchValue.original_chars, patch_retained_chars: patchValue.retained_chars } : null,
    selection: { included: ['assistant thinking/reasoning', 'last assistant output', 'verified Git changes'],
      excluded: ['user messages', 'system prompt', 'tool arguments', 'tool output', 'intermediate visible replies'],
      reasoning_budget_chars: selectedLimits.thinkingChars, reasoning_retained_chars: selectedLimits.thinkingChars - thinkingRemaining },
  };
}

export { DEFAULT_LIMITS };
