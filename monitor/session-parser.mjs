import { redactValue } from './redactor.mjs';

function textBlocks(content) {
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = String(block.type ?? '').toLowerCase();
    if (type.includes('thinking') || type.includes('reasoning')) continue;
    if ((type === 'text' || type === 'output_text' || type === 'input_text') && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.filter((value) => value.trim());
}

function toolBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => {
    const type = String(block?.type ?? '').toLowerCase();
    return type === 'tool_use' || type === 'toolcall' || type === 'tool_call';
  }).map((block) => ({ name: block.name ?? block.toolName ?? 'unknown-tool', id: block.id ?? block.toolCallId ?? null }));
}

export function parseSessionRecord(line) {
  let record;
  try { record = JSON.parse(line); } catch { return []; }
  if (record.type !== 'message' || !record.message) return [];
  const message = record.message;
  const timestamp = message.timestamp ?? record.timestamp ?? new Date().toISOString();
  const role = String(message.role ?? '').toLowerCase();
  const output = [];
  if (role === 'assistant') {
    for (const text of textBlocks(message.content)) {
      output.push({ kind: 'OUTPUT_SUMMARY', event_type: 'session.assistant_output', timestamp,
        payload: redactValue({ role, summary: text }), confidence: 'MEDIUM' });
    }
    for (const tool of toolBlocks(message.content)) {
      output.push({ kind: 'TOOL_STARTED', event_type: 'session.tool_started', timestamp,
        payload: redactValue({ role, tool }), confidence: 'MEDIUM' });
    }
  } else if (role === 'tool' || message.toolName) {
    output.push({ kind: 'TOOL_FINISHED', event_type: 'session.tool_finished', timestamp,
      payload: redactValue({ role: 'tool', tool: { name: message.toolName ?? 'unknown-tool', id: message.toolCallId ?? null },
        is_error: Boolean(message.isError), summary: textBlocks(message.content).join('\n') || String(message.content ?? '') }), confidence: 'MEDIUM' });
  }
  return output;
}

