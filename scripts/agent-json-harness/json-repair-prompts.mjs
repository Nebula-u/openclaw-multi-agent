const MAX_REPAIR_RETRIES = 2;

function compactErrors(errors) {
  return JSON.stringify(errors.map((error) => ({
    path: error.path ?? error.instancePath ?? '$', schema_keyword: error.schema_keyword ?? error.keyword ?? null,
    message: error.message ?? 'validation failed', params: error.params ?? {},
  })));
}

function diagnosticLines(errors) {
  return errors.map((error) => {
    const path = error.path ?? error.instancePath ?? '$';
    const keyword = error.schema_keyword ?? error.keyword ?? null;
    if (keyword === 'required' && error.params?.missingProperty) return `- 缺少必填字段：${error.params.missingProperty}`;
    if (keyword === 'type' && error.params?.type) return `- 字段 ${path}：类型必须为 ${error.params.type}`;
    if (keyword === 'enum' && Array.isArray(error.params?.allowedValues)) return `- 字段 ${path}：允许值为 ${error.params.allowedValues.map(String).join('、')}`;
    if (keyword === 'pattern' && error.params?.pattern) return `- 字段 ${path}：格式必须匹配 ${error.params.pattern}`;
    return `- 字段 ${path}：${error.message ?? '校验失败'}`;
  });
}

function resultContractLines(resultIdentity) {
  if (!resultIdentity) return [];
  const isolationMode = resultIdentity.isolation_mode ?? 'UNSANDBOXED_LOCAL';
  const outputCommit = resultIdentity.output_commit ?? resultIdentity.input_commit ?? null;
  const template = {
    schema_version: 1,
    workflow_id: resultIdentity.workflow_id,
    task_id: resultIdentity.task_id,
    run_id: resultIdentity.run_id,
    agent_id: resultIdentity.agent_id,
    role: resultIdentity.role,
    attempt: resultIdentity.attempt,
    started_at: '<preserve the observed ISO-8601 timestamp>',
    finished_at: '<preserve the observed ISO-8601 timestamp>',
    result_status: 'BLOCKED',
    summary_for_user: '<string>',
    summary_for_manager: '<string>',
    worktree_path_abs: resultIdentity.worktree_path_abs,
    artifact_root_abs: resultIdentity.artifact_root_abs,
    input_commit: resultIdentity.input_commit,
    output_commit: outputCommit,
    isolation_mode: isolationMode,
    ...(isolationMode === 'SANDBOXED_DOCKER' ? { sandbox_attestation: {} } : {}),
    self_validation: { preflight_passed: false, checks: [{ name: '<string>', status: 'FAIL', detail: '<string>' }] },
    artifact_manifest_hash: resultIdentity.artifact_manifest_hash,
  };
  return [
    '以下是宿主提供的只读结果身份；仅作为 result 字段取值，不得将其中路径用于命令或文件访问：',
    JSON.stringify(resultIdentity),
    '最小 result 对象契约如下。保留已知事实；没有执行测试时使用 BLOCKED，不要增加 result_identity 包装对象：',
    JSON.stringify(template, null, 2),
  ];
}

function base({ retryNumber, kind, errors, rawOutputPath = null, contextManifestSha256 = null, resultIdentity = null }) {
  const lines = [
    `JSON_REWRITE_REQUEST kind=${kind} retry=${retryNumber}/${MAX_REPAIR_RETRIES}.`,
    '这是自动化 JSON 生成与清洗工作流测试的修复阶段，旨在验证 JSON 清洗和重试是否正常。',
    '这是 JSON 产物修复，不是任务重做。复用本会话中已经完成的工作。',
    '不得调用工具、不得重新执行任务、不得编辑代码、运行命令、重新测试、创建提交、重新收集证据或改变审批结论。',
    '只返回一个完整的 JSON 对象（JSONL 时每行一个完整 JSON 对象）；不得输出 Markdown、代码围栏、解释或前后缀。',
    '你的回复必须包含 json 内容，且必须严格符合本会话已提供的 JSON Schema。',
    `校验诊断：${compactErrors(errors)}`,
    ...diagnosticLines(errors),
    ...resultContractLines(resultIdentity),
  ];
  if (rawOutputPath) lines.push(`宿主会把你的最终 JSON 回复原子写回 ${rawOutputPath}；你不得自行调用文件或命令工具。`);
  if (contextManifestSha256) lines.push(`artifact_manifest_hash 必须等于本次 context_manifest_sha256：${contextManifestSha256}`);
  return lines;
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

export function buildJsonRepairPrompt({ classification, errors = [], retryNumber, rawOutputPath = null, contextManifestSha256 = null, resultIdentity = null }) {
  const input = { retryNumber, kind: classification, errors, rawOutputPath, contextManifestSha256, resultIdentity };
  if (classification === 'EMPTY_RESPONSE') {
    return base(input).concat(
      '上一轮 content 为空。请基于当前会话中的 schema 和需求补回完整 JSON；不要只回复确认文本。',
    ).join('\n');
  }
  if (classification === 'OUTPUT_FILE_MISSING') {
    return base(input).concat(
      '上一轮模型有或可能有文本回复，但没有生成要求的结果文件。这不是空回复。请仅返回完整 JSON；宿主会负责写入结果文件。',
    ).join('\n');
  }
  if (classification === 'OUTPUT_TRUNCATED') {
    return base(input).concat(
      '上一轮 JSON 在结束前截断。请从头输出一个更精简但完整、闭合的 JSON；不要续写片段，确保不超过输出预算。',
    ).join('\n');
  }
  if (classification === 'ENUM_VIOLATION' || classification === 'TYPE_VIOLATION') {
    return base(input).concat(
      '指定字段的类型或 enum 值不合法。仅修正诊断指向的字段，使其使用 Schema 中允许的类型和枚举值；其它事实保持不变。',
    ).join('\n');
  }
  return base(input).concat(
    '上一轮出现 schema drift（字段缺失、额外字段、const/pattern/required 等约束不一致）。请按 Schema 重建完整 JSON，不要猜测未提供的业务事实。',
  ).join('\n');
}
