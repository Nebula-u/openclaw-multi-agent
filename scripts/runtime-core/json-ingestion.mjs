import { createHash } from 'node:crypto';

export class JsonIngestionError extends SyntaxError {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'JsonIngestionError';
    this.diagnostic = diagnostic;
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function parseJsonl(text) {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new JsonIngestionError('JSONL response is empty.', 'EMPTY_RESPONSE');
  return lines.map((line) => JSON.parse(line));
}

function completeJsonValueEnd(text, start) {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return -1;
  const stack = [opening === '{' ? '}' : ']'];
  let quoted = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.at(-1) !== character) return -1;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

function extractUniqueJsonValue(text) {
  const candidates = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '{' && text[index] !== '[') continue;
    const end = completeJsonValueEnd(text, index);
    if (end < 0) continue;
    const candidate = text.slice(index, end);
    try {
      JSON.parse(candidate);
      candidates.push(candidate);
      index = end - 1;
    } catch {
      // A bracket sequence can occur inside explanatory text; it is not a repair candidate.
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw new JsonIngestionError('Response contains more than one complete JSON value; refusing to guess.', 'AMBIGUOUS_JSON_VALUES');
  throw new JsonIngestionError('Response does not contain one complete JSON object or array.', 'JSON_PARSE_ERROR');
}

function unwrapSingleFence(text) {
  const fences = [...text.matchAll(/```(?:json|jsonl)?[ \t]*\r?\n([\s\S]*?)\r?\n```/giu)];
  if (fences.length !== 1) return null;
  return fences[0][1];
}

function extractUniqueJsonlBlock(text) {
  const lines = text.split(/\r?\n/u);
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
      current.push(line);
    } catch {
      if (current.length > 0) blocks.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  if (blocks.length === 1) return blocks[0];
  if (blocks.length > 1) throw new JsonIngestionError('Response contains more than one JSONL block; refusing to guess.', 'AMBIGUOUS_JSON_VALUES');
  throw new JsonIngestionError('Response does not contain a complete JSONL block.', 'JSON_PARSE_ERROR');
}

function repairSyntaxValue(text) {
  let output = '';
  let quote = null;
  let escaped = false;
  let changedQuotes = false;
  let changedComments = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote === '"') {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (escaped) {
        output += character === '"' ? '\\"' : character;
        escaped = false;
      } else if (character === '\\') {
        output += character;
        escaped = true;
      } else if (character === "'") {
        output += '"';
        quote = null;
      } else {
        output += character === '"' ? '\\"' : character;
      }
      changedQuotes = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character === "'" ? '"' : character;
      if (character === "'") changedQuotes = true;
      continue;
    }
    if (character === '/' && next === '/') {
      changedComments = true;
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      changedComments = true;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  if (quote !== null) return null;
  let changedKeys = false;
  output = output.replace(/([{,]\s*)([A-Za-z_$][\w$-]*)(\s*:)/gu, (_match, prefix, key, suffix) => {
    changedKeys = true;
    return `${prefix}"${key}"${suffix}`;
  });
  const withoutTrailingCommas = output.replace(/,\s*([}\]])/gu, '$1');
  const changedTrailingCommas = withoutTrailingCommas !== output;
  output = withoutTrailingCommas;
  const withCommas = output
    .replace(/([0-9}\]])\s+(?=(?:"[^"\n]*"|[A-Za-z_$][\w$-]*)\s*:)/gu, '$1, ')
    .replace(/\}\s*(?=\{)/gu, '},')
    .replace(/\]\s*(?=\[)/gu, '],');
  const changedCommas = withCommas !== output;
  output = withCommas;
  const stack = [];
  let inString = false;
  escaped = false;
  for (const character of output) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.at(-1) !== character) return null;
      stack.pop();
    }
  }
  if (inString) return null;
  const changedBrackets = stack.length > 0;
  output += stack.reverse().join('');
  const transformations = [];
  if (changedQuotes) transformations.push('NORMALIZE_SINGLE_QUOTES');
  if (changedKeys) transformations.push('QUOTE_UNQUOTED_KEYS');
  if (changedComments) transformations.push('REMOVE_JSON_COMMENTS');
  if (changedTrailingCommas) transformations.push('REMOVE_TRAILING_COMMAS');
  if (changedCommas) transformations.push('ADD_MISSING_COMMAS');
  if (changedBrackets) transformations.push('ADD_MISSING_CLOSING_BRACKETS');
  return { text: output, transformations };
}

function repairSyntax(text, jsonl) {
  if (!jsonl) return repairSyntaxValue(text);
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const repaired = lines.map((line) => repairSyntaxValue(line));
  if (repaired.some((item) => item === null)) return null;
  return { text: repaired.map((item) => item.text).join('\n'), transformations: [...new Set(repaired.flatMap((item) => item.transformations))] };
}

function normalizeText(raw, jsonl) {
  const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const transformations = raw === withoutBom ? [] : ['STRIP_UTF8_BOM'];
  const fenced = unwrapSingleFence(withoutBom);
  if (fenced !== null) {
    transformations.push('UNWRAP_SINGLE_JSON_FENCE');
    const repaired = repairSyntax(fenced.trim(), jsonl);
    if (repaired) return { text: repaired.text, transformations: transformations.concat(repaired.transformations) };
    return { text: fenced.trim(), transformations };
  }
  const trimmed = withoutBom.trim();
  try {
    if (jsonl) parseJsonl(trimmed);
    else JSON.parse(trimmed);
    return { text: trimmed, transformations };
  } catch (error) {
    const repaired = repairSyntax(trimmed, jsonl);
    if (repaired) {
      try {
        if (jsonl) parseJsonl(repaired.text);
        else JSON.parse(repaired.text);
        return { text: repaired.text, transformations: transformations.concat(repaired.transformations) };
      } catch { /* continue with wrapper extraction */ }
    }
    const parseMessage = error instanceof Error ? error.message : String(error);
    let text;
    try {
      text = jsonl ? extractUniqueJsonlBlock(withoutBom) : extractUniqueJsonValue(withoutBom);
    } catch (extractionError) {
      if (/unexpected end|unterminated|string literal|end of json input/iu.test(parseMessage)) {
        throw new JsonIngestionError(parseMessage, 'OUTPUT_TRUNCATED');
      }
      throw extractionError;
    }
    const extractedRepair = repairSyntax(text, jsonl);
    if (extractedRepair) return { text: extractedRepair.text, transformations: transformations.concat(jsonl ? 'EXTRACT_UNIQUE_JSONL_FROM_WRAPPER' : 'EXTRACT_UNIQUE_JSON_FROM_WRAPPER', extractedRepair.transformations) };
    transformations.push(jsonl ? 'EXTRACT_UNIQUE_JSONL_FROM_WRAPPER' : 'EXTRACT_UNIQUE_JSON_FROM_WRAPPER');
    return { text, transformations };
  }
}

export function ingestJsonText(rawText, { jsonl = false } = {}) {
  const raw = String(rawText ?? '');
  const rawSha256 = sha256(raw);
  try {
    const normalized = normalizeText(raw, jsonl);
    const value = jsonl ? parseJsonl(normalized.text) : JSON.parse(normalized.text);
    return {
      raw_sha256: rawSha256,
      cleaned_sha256: sha256(normalized.text),
      transformations: normalized.transformations,
      text: normalized.text,
      value,
    };
  } catch (error) {
    if (error instanceof JsonIngestionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const truncated = /unexpected end|unterminated|string literal|end of json input/iu.test(message);
    throw new JsonIngestionError(message, truncated ? 'OUTPUT_TRUNCATED' : 'JSON_PARSE_ERROR');
  }
}
