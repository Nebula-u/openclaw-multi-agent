import { createHash } from 'node:crypto';

export function ingestJsonText(rawText) {
  const raw = String(rawText);
  const rawSha256 = createHash('sha256').update(raw, 'utf8').digest('hex');
  const withoutBom = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const fence = withoutBom.match(/^\s*```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/iu);
  const normalized = fence ? fence[1] : withoutBom;
  return {
    raw_sha256: rawSha256,
    transformations: [
      ...(raw !== withoutBom ? ['STRIP_UTF8_BOM'] : []),
      ...(fence ? ['UNWRAP_SINGLE_JSON_FENCE'] : []),
    ],
    text: normalized,
    value: JSON.parse(normalized),
  };
}
