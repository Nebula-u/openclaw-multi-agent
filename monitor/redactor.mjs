import { homedir } from 'node:os';

const SECRET_PATTERNS = [
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/gu, '[REDACTED_API_KEY]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*\b/giu, '$1[REDACTED_TOKEN]'],
  [/\b(?:api[_-]?key|token|secret|password|passwd|cookie)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED_SECRET]'],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]'],
];

const DROP_KEYS = new Set(['thinking', 'reasoning', 'chain_of_thought', 'system_prompt', 'prompt', 'credentials', 'authorization', 'cookie']);

function redactString(value, maxLength) {
  let output = value;
  const home = homedir();
  if (home) output = output.split(home).join('<USER_HOME>');
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  if (output.length > maxLength) output = `${output.slice(0, maxLength)}…[TRUNCATED ${output.length - maxLength} chars]`;
  return output;
}

export function redactValue(value, { maxStringLength = 4000, maxArrayLength = 100, depth = 0 } = {}) {
  if (depth > 12) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return redactString(value, maxStringLength);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, maxArrayLength).map((item) => redactValue(item, { maxStringLength, maxArrayLength, depth: depth + 1 }));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROP_KEYS.has(key.toLowerCase())) continue;
    output[key] = redactValue(item, { maxStringLength, maxArrayLength, depth: depth + 1 });
  }
  return output;
}

