const MAX_REPAIR_RETRIES = 2;

function compactErrors(errors) {
  return JSON.stringify(errors.map((error) => ({
    path: error.path ?? '$', schema_keyword: error.schema_keyword ?? null,
    message: error.message ?? 'validation failed', params: error.params ?? {},
  })));
}

function base({ retryNumber, kind, errors }) {
  return [
    `JSON_REWRITE_REQUEST kind=${kind} retry=${retryNumber}/${MAX_REPAIR_RETRIES}.`,
    '不要调用工具、不要重新执行任务、不要改变已有业务事实、证据、命令结果或审批决定。',
    '只返回一个完整的 JSON 对象（JSONL 时每行一个完整 JSON 对象）；不得输出 Markdown、代码围栏、解释或前后缀。',
    '你的回复必须包含 json 内容，且必须严格符合本会话已提供的 JSON Schema。',
    `校验诊断：${compactErrors(errors)}`,
  ];
}

export { MAX_REPAIR_RETRIES };

export function classifyLlmFailure({ response, validation, ingestionError }) {
  if (typeof response === 'string' && response.trim().length === 0) return 'EMPTY_RESPONSE';
  if (ingestionError?.diagnostic === 'OUTPUT_TRUNCATED') return 'OUTPUT_TRUNCATED';
  if (ingestionError) return ingestionError.diagnostic ?? 'JSON_PARSE_ERROR';
  const keywords = (validation?.errors ?? []).map((error) => error.schema_keyword);
  if (keywords.includes('enum')) return 'ENUM_VIOLATION';
  if (keywords.includes('type')) return 'TYPE_VIOLATION';
  return 'SCHEMA_DRIFT';
}

export function buildJsonRepairPrompt({ classification, errors = [], retryNumber }) {
  if (classification === 'EMPTY_RESPONSE') {
    return base({ retryNumber, kind: classification, errors }).concat(
      '上一轮 content 为空。请基于当前会话中的 schema 和需求补回完整 JSON；不要只回复确认文本。',
    ).join('\n');
  }
  if (classification === 'OUTPUT_TRUNCATED') {
    return base({ retryNumber, kind: classification, errors }).concat(
      '上一轮 JSON 在结束前截断。请从头输出一个更精简但完整、闭合的 JSON；不要续写片段，确保不超过输出预算。',
    ).join('\n');
  }
  if (classification === 'ENUM_VIOLATION' || classification === 'TYPE_VIOLATION') {
    return base({ retryNumber, kind: classification, errors }).concat(
      '指定字段的类型或 enum 值不合法。仅修正诊断指向的字段，使其使用 Schema 中允许的类型和枚举值；其它事实保持不变。',
    ).join('\n');
  }
  return base({ retryNumber, kind: classification, errors }).concat(
    '上一轮出现 schema drift（字段缺失、额外字段、const/pattern/required 等约束不一致）。请按 Schema 重建完整 JSON，不要猜测未提供的业务事实。',
  ).join('\n');
}
