import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

export function sha256(value) {
  const hash = createHash('sha256');
  if (typeof value === 'string') hash.update(value, 'utf8');
  else if (ArrayBuffer.isView(value)) hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  else hash.update(canonicalJson(value), 'utf8');
  return hash.digest('hex');
}
