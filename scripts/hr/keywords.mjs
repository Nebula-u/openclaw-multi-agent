export const DEFAULT_HR_KEYWORDS = Object.freeze([
  '可能', '我觉得', '猜测', '不确定', 'maybe', 'perhaps', 'i think', 'guess', 'uncertain',
]);

export function inspectAssistantText(text, keywords = DEFAULT_HR_KEYWORDS) {
  const source = String(text ?? '');
  const matches = [];
  for (const keyword of keywords) {
    const value = String(keyword).trim(); if (!value) continue;
    const index = source.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
    if (index < 0) continue;
    matches.push({ keyword: value, index, context: source.slice(Math.max(0, index - 120), Math.min(source.length, index + value.length + 180)) });
  }
  return matches;
}
