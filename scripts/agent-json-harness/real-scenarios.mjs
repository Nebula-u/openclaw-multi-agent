// Real Agent JSON harness scenario planner.
//
// This module deliberately creates only natural-language requirements and
// invocation metadata. It never constructs, repairs, or mutates the JSON/JSONL
// artifact under test: that artifact is written by a registered OpenClaw Agent.

const VARIATIONS = [
  ['账户恢复', 'a locked account recovery flow', '华东客户支持'],
  ['库存预警', 'warehouse stock threshold alerts', '新加坡履约中心'],
  ['账单对账', 'monthly billing reconciliation', '欧洲财务团队'],
  ['权限迁移', 'role migration for a merged organization', '北美企业租户'],
  ['设备巡检', 'scheduled inspection of field devices', '苏州现场运维'],
  ['数据导入', 'partner CSV onboarding validation', '东京集成团队'],
  ['审计导出', 'export of access-review evidence', '伦敦合规小组'],
  ['通知偏好', 'customer notification preference updates', '移动端产品组'],
  ['退款审批', 'exceptional refund approval handling', '杭州支付运营'],
  ['工单分流', 'incident ticket routing by severity', '深圳服务台'],
  ['密钥轮换', 'staged service credential rotation', '平台安全团队'],
  ['报表订阅', 'weekly KPI report subscriptions', '巴黎数据分析组'],
  ['配送改期', 'rescheduling of last-mile delivery windows', '柏林物流团队'],
  ['风险标记', 'manual fraud-review labels', '墨西哥风控专员'],
  ['合同续约', 'enterprise contract renewal reminders', '上海销售运营'],
  ['内容审核', 'queue assignment for content moderation', '首尔信任与安全'],
  ['费用报销', 'employee expense exception review', '悉尼财务共享中心'],
  ['预约排班', 'clinic appointment capacity updates', '广州医疗运营'],
  ['知识库发布', 'publishing a revised support article', '阿姆斯特丹支持团队'],
  ['供应商准入', 'supplier onboarding risk assessment', '孟买采购团队'],
  ['学习路径', 'mandatory training assignment updates', '成都人力资源'],
  ['服务降级', 'customer communication for partial outage', '多伦多 SRE 团队'],
  ['数据保留', 'retention-policy exception recording', '法兰克福隐私团队'],
  ['营销同意', 'withdrawal of marketing consent', '台北增长团队'],
  ['身份核验', 'document-verification escalation', '迪拜客户运营'],
  ['价格变更', 'approved regional price adjustment', '里斯本商业团队'],
  ['质量抽检', 'random fulfillment quality inspection', '武汉仓储团队'],
  ['翻译更新', 'localized product-copy correction', '蒙特利尔本地化团队'],
  ['访问申请', 'temporary production-access request', '班加罗尔工程团队'],
  ['灾备演练', 'disaster-recovery exercise evidence', '圣保罗基础设施团队'],
];

const SCHEMA_SPECS = [
  ['acceptance-criteria.schema.json', 'requirement-agent', false],
  ['active-workflows.schema.json', 'manager-agent', false],
  ['agent-package.schema.json', 'dialogue-agent', false],
  ['approval-request.schema.json', 'manager-agent', false],
  ['approval-response.schema.json', 'dialogue-agent', false],
  ['command-record.schema.json', 'developer-agent', true],
  ['component-build-result.schema.json', 'dialogue-agent', false],
  ['component-request.schema.json', 'dialogue-agent', false],
  ['context-manifest.schema.json', 'architect-agent', false],
  ['evidence.schema.json', 'test-agent', true],
  ['gate-result.schema.json', 'manager-agent', false],
  ['json-validation-error.schema.json', 'test-agent', false],
  ['release-decision.schema.json', 'release-agent', false],
  ['result.schema.json', 'developer-agent', false],
  ['review-findings.schema.json', 'review-agent', false],
  ['skill-package.schema.json', 'dialogue-agent', false],
  ['task.schema.json', 'manager-agent', false],
  ['workflow-event.schema.json', 'manager-agent', false],
  ['workflow.schema.json', 'manager-agent', false],
];

function slug(value) {
  return value
    .replace(/\.schema\.json$/u, '')
    .replace(/[^a-z0-9]+/giu, '-')
    .replace(/^-|-$/gu, '');
}

function createCases(schemaFile) {
  const family = slug(schemaFile);
  return VARIATIONS.map(([label, subject, team], index) => ({
    id: `${family}-${String(index + 1).padStart(2, '0')}`,
    topic: `${label} / ${team}`,
    requirement: `Create the contract artifact for ${subject}. The request is owned by ${team}; make the content specific to this case and retain any limitation that cannot be established from the supplied context.`,
    language: index % 2 === 0 ? 'Chinese-first with concise English identifiers' : 'English-first with concise Chinese summary',
    variation: index + 1,
  }));
}

export const REAL_SCENARIOS = SCHEMA_SPECS.map(([schemaFile, agentId, jsonl]) => ({
  name: slug(schemaFile),
  schemaFile,
  agentId,
  jsonl,
  artifactFileName: `artifact.${jsonl ? 'jsonl' : 'json'}`,
  cases: createCases(schemaFile),
}));

export function buildRealCasePrompt(scenario, testCase, { artifactPath, schemaPath, contextPath }) {
  const format = scenario.jsonl ? 'JSONL (one complete JSON object per line)' : 'one JSON object';
  return [
    'You are executing a real OpenClaw contract-generation test.',
    `Write exactly one ${format} artifact to this absolute path: ${artifactPath}`,
    `The required contract schema is: ${schemaPath}`,
    `Read the test context at: ${contextPath}`,
    '',
    `Business requirement: ${testCase.requirement}`,
    `Language preference: ${testCase.language}.`,
    '',
    'Use the schema and context as the only source of truth. Do not copy any shipped template; create a fresh, case-specific artifact. Do not place markdown fences, explanations, or a second JSON document in the artifact file. Do not claim commands, evidence, commits, approvals, or other facts that are absent from the context. If a schema-valid conservative limitation field exists, use it for unknown facts.',
    'After writing the file, respond with a concise confirmation containing only the artifact path and whether it was written.',
    '',
  ].join('\n');
}

export function buildRetryPrompt({ artifactPath, schemaPath, errorLogPath, retryTemplate }) {
  return retryTemplate
    .replace('<ABS_JSON_OR_JSONL_PATH>', artifactPath)
    .replace('<ABS_SCHEMA_PATH>', schemaPath)
    .replace('<ABS_JSON_VALIDATION_ERRORS_JSONL>', errorLogPath)
    .replace('<RETRY_COUNT>', '1');
}
