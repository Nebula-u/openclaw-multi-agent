// Scenario planning for direct LLM-response contract tests. No template payload
// is included in a prompt and no case asks an Agent to use its workspace.

const VARIATIONS = [
  ['账户恢复', '华东客户支持'], ['库存预警', '新加坡履约中心'], ['账单对账', '欧洲财务团队'],
  ['权限迁移', '北美企业租户'], ['设备巡检', '苏州现场运维'], ['数据导入', '东京集成团队'],
  ['审计导出', '伦敦合规小组'], ['通知偏好', '移动端产品组'], ['退款审批', '杭州支付运营'],
  ['工单分流', '深圳服务台'], ['密钥轮换', '平台安全团队'], ['报表订阅', '巴黎数据分析组'],
  ['配送改期', '柏林物流团队'], ['风险标记', '墨西哥风控专员'], ['合同续约', '上海销售运营'],
  ['内容审核', '首尔信任与安全'], ['费用报销', '悉尼财务共享中心'], ['预约排班', '广州医疗运营'],
  ['知识库发布', '阿姆斯特丹支持团队'], ['供应商准入', '孟买采购团队'], ['学习路径', '成都人力资源'],
  ['服务降级', '多伦多 SRE 团队'], ['数据保留', '法兰克福隐私团队'], ['营销同意', '台北增长团队'],
  ['身份核验', '迪拜客户运营'], ['价格变更', '里斯本商业团队'], ['质量抽检', '武汉仓储团队'],
  ['翻译更新', '蒙特利尔本地化团队'], ['访问申请', '班加罗尔工程团队'], ['灾备演练', '圣保罗基础设施团队'],
];

const SCHEMA_SPECS = [
  ['acceptance-criteria.schema.json', 'requirement-agent', false],
  ['active-workflows.schema.json', 'manager-agent', false],
  ['agent-package.schema.json', 'manager-agent', false],
  ['approval-assessment.schema.json', 'manager-agent', false],
  ['approval-request.schema.json', 'manager-agent', false],
  ['approval-response.schema.json', 'manager-agent', false],
  ['command-record.schema.json', 'developer-agent', true],
  ['component-build-result.schema.json', 'manager-agent', false],
  ['component-request.schema.json', 'manager-agent', false],
  ['context-manifest.schema.json', 'architect-agent', false],
  ['evidence.schema.json', 'test-agent', true],
  ['gate-result.schema.json', 'manager-agent', false],
  ['json-validation-error.schema.json', 'test-agent', false],
  ['release-decision.schema.json', 'release-agent', false],
  ['result.schema.json', 'developer-agent', false],
  ['review-findings.schema.json', 'review-agent', false],
  ['skill-package.schema.json', 'manager-agent', false],
  ['task.schema.json', 'manager-agent', false],
  ['workflow-event.schema.json', 'manager-agent', false],
  ['workflow.schema.json', 'manager-agent', false],
];

function slug(value) {
  return value.replace(/\.schema\.json$/u, '').replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '');
}

function createCases(schemaFile) {
  const family = slug(schemaFile);
  return VARIATIONS.slice(0, 5).map(([topic, owner], index) => ({
    id: `${family}-${String(index + 1).padStart(2, '0')}`,
    topic: `${topic} / ${owner}`,
    requirement: `为${owner}的${topic}流程生成一份契约数据。仅陈述可由该业务请求和 Schema 支撑的事实；不确定信息必须使用 Schema 允许的保守值。`,
    language: index % 2 === 0 ? '中文为主，保留必要英文标识符' : 'English identifiers with a concise Chinese business context',
    variation: index + 1,
  }));
}

export const LLM_SCENARIOS = SCHEMA_SPECS.map(([schemaFile, agentId, jsonl]) => ({
  name: slug(schemaFile), schemaFile, agentId, jsonl, cases: createCases(schemaFile),
}));

export function buildLlmCasePrompt(scenario, testCase, schemaText) {
  const format = scenario.jsonl ? 'JSONL，每一行是一个完整 JSON 对象' : '一个 JSON 对象';
  return [
    '这是一次仅评估 LLM 最终回复的 JSON 契约测试。不要调用任何工具，不要读取或写入文件。',
    `请仅回复 ${format}，不要使用 Markdown 代码块、解释、前后缀或额外文本。`,
    'JSON 输出形态示例（仅示意，不可照抄字段或值）：{"field":"value"}。实际字段、类型、必填项和枚举必须以下方 Schema 为准。',
    '',
    `业务需求：${testCase.requirement}`,
    `语言偏好：${testCase.language}。`,
    `测试用例：${testCase.id}（变体 ${testCase.variation}，主题：${testCase.topic}）。`,
    '',
    '以下是唯一有效的 JSON Schema。不得复制任何项目模板，不得虚构命令、证据、提交、审批或外部事实。',
    '```json',
    schemaText,
    '```',
  ].join('\n');
}

export function buildLlmRetryPrompt(errors) {
  const compactErrors = JSON.stringify(errors);
  return [
    '你上一次的最终回复未通过 JSON Schema 校验。不要调用工具，不要重做分析。',
    '仅根据下列错误重新回复一个完整、唯一且符合 Schema 的 JSON/JSONL 内容；不得使用 Markdown 或解释。',
    `校验错误：${compactErrors}`,
  ].join('\n');
}

export function buildEmptyLlmRetryPrompt(attempt) {
  return [
    '你上一轮最终回复为空，未返回任何可解析内容。不要调用工具，不要重新分析任务。',
    '请依据本会话中已有的业务需求与 JSON Schema，重新输出唯一、完整、合法的 JSON/JSONL 内容。',
    '输出必须包含 JSON 字样要求的对象内容；不得输出 Markdown、解释、前后缀或空字符串。',
    `这是针对空输出的第 ${attempt} 次重写（最多 3 次）。`,
  ].join('\n');
}
