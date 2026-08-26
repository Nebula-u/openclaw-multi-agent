// Fixed real-Agent JSON generation scenarios. The prompts send the schema, but
// never a project template or a prebuilt JSON payload.

import { CONTRACT_SCENARIOS } from '../agent-llm-contract-tests/contract-scenarios.mjs';

export const REPETITIONS_PER_CASE = 10;

const CASE_DEFINITIONS = {
  'acceptance-criteria.schema.json': [
    ['账户恢复验收标准', '为账户恢复流程生成最小、可验证的验收标准；只使用 Schema 可支持的保守事实。'],
    ['库存预警验收标准', '为库存预警流程生成验收标准；覆盖未验证状态，不得声称已经完成外部操作。'],
    ['数据迁移回滚验收标准', '为数据迁移回滚流程生成多项验收标准；每项给出可执行的验证方式。'],
  ],
  'agent-package.schema.json': [
    ['只读审查 Agent 包', '生成一个最小只读审查 Agent 的 package 契约数据，能力和权限必须保守。'],
    ['开发 Agent 工具配置', '生成一个开发 Agent package，包含合法的工具、sandbox 与模型配置分支。'],
    ['可委派生成 Agent 包', '生成一个带委派、装配与生命周期信息的 Agent package，不虚构已安装组件。'],
  ],
  'approval-assessment.schema.json': [
    ['低风险配置评估', '评估一项低风险配置变更，给出保守的审批评估记录。'],
    ['生产发布评估', '评估一次需要人工批准的生产发布，记录风险和可核验依据。'],
    ['多风险审批评估', '生成包含多项评估项目的审批评估，不宣称不存在的证据。'],
  ],
  'approval-request.schema.json': [
    ['回滚审批请求', '生成一次服务回滚的审批请求，提供明确选项和推荐选项。'],
    ['权限提升审批请求', '生成临时权限提升的审批请求，使用保守证据引用。'],
    ['部署策略审批请求', '生成包含多个部署策略选项的审批请求，所有字段必须符合 Schema。'],
  ],
  'approval-response.schema.json': [
    ['批准回复', '生成对低风险变更的批准回复，选择一个已提供的选项标识。'],
    ['拒绝回复', '生成对高风险变更的拒绝回复，给出简洁、可审计的说明。'],
    ['补充信息回复', '生成要求补充信息的审批回复，不把用户意图伪装为已批准。'],
  ],
  'command-record.schema.json': [
    ['成功命令记录', '生成一条成功执行的受控测试命令记录。'],
    ['失败命令记录', '生成一条失败但已完整记录输出位置的命令记录。'],
    ['多命令审计记录', '生成多条命令审计记录，体现超时或脱敏等合法分支。'],
  ],
  'component-build-result.schema.json': [
    ['Skill 构建成功', '生成一个 Skill 构建成功结果，附带保守的校验信息。'],
    ['Agent 包校验失败', '生成一个 Agent package 构建失败结果，不捏造产物已可用。'],
    ['多项校验构建结果', '生成一个带多个校验结果的组件构建结果。'],
  ],
  'component-request.schema.json': [
    ['创建 Skill 请求', '生成创建受管理 Skill 的组件请求。'],
    ['创建 Agent 请求', '生成创建受管理 Agent 的组件请求，明确用途与能力。'],
    ['带模型约束的请求', '生成带目标 Agent、模型和保留策略的组件请求。'],
  ],
  'context-manifest.schema.json': [
    ['需求任务上下文', '生成一个需求分析任务的最小上下文清单。'],
    ['审查任务上下文', '生成一个代码审查任务的上下文清单，包含必要输入与输出路径。'],
    ['多产物开发上下文', '生成一个开发任务的上下文清单，包含多个输入文件与结构化输出。'],
  ],
  'evidence.schema.json': [
    ['文件证据', '生成一条来自文件的可审计证据记录。'],
    ['Git 证据', '生成一条来自 Git 定位信息的证据记录。'],
    ['多来源证据', '生成多条来自命令和文件的证据记录。'],
  ],
  'gate-result.schema.json': [
    ['通过 Gate', '生成一个所有必要检查均通过的 Gate 结果。'],
    ['阻断 Gate', '生成一个阻断发布的 Gate 结果，明确失败目标。'],
    ['需要返工 Gate', '生成一个含多项检查、需要返工的 Gate 结果。'],
  ],
  'json-validation-error.schema.json': [
    ['JSON 语法错误记录', '生成一条 JSON 语法错误的验证日志记录。'],
    ['字段错误记录', '生成一条缺少字段或字段名错误的验证日志记录。'],
    ['类型枚举格式错误记录', '生成一条同时体现类型、枚举或格式校验错误的日志记录。'],
  ],
  'release-decision.schema.json': [
    ['可发布结论', '生成一个可发布候选提交的发布决策。'],
    ['需要返工结论', '生成一个需要返工的发布决策，保守记录已知问题。'],
    ['阻断与回滚结论', '生成一个阻断发布且包含回滚交接信息的发布决策。'],
  ],
  'result.schema.json': [
    ['完成结果', '生成一个已完成的开发任务结果，只陈述该测试请求允许的保守事实。'],
    ['阻断结果', '生成一个被外部依赖阻断的任务结果，不虚构完成的工作。'],
    ['人工决策结果', '生成一个需要人工决策的任务结果，并保留诚实的限制说明。'],
  ],
  'review-findings.schema.json': [
    ['无问题审查', '生成一个没有发现阻断问题的审查结论。'],
    ['单项返工问题', '生成一个包含单项、可定位返工问题的审查结论。'],
    ['多严重度审查', '生成一个包含多项不同严重度发现的审查结论。'],
  ],
  'route-plan.schema.json': [
    ['标准开发路由', '生成一个标准低风险开发请求的路由计划。'],
    ['高风险路由', '生成一个高风险变更的路由计划，包含合适的关卡。'],
    ['多步骤跳过阶段路由', '生成一个多步骤且显式跳过适用阶段的路由计划。'],
  ],
  'skill-package.schema.json': [
    ['新建 Skill 包', '生成一个新建受管理 Skill package 的契约数据。'],
    ['受保护 Skill 包', '生成一个受保护且不可删除的 Skill package。'],
    ['带生命周期 Skill 包', '生成一个带来源、创建信息与生命周期的 Skill package。'],
  ],
  'task-run.schema.json': [
    ['首次归档任务', '生成一个首次执行后归档的不可变 task run 快照。'],
    ['重试归档任务', '生成一个重试后归档的 task run 快照。'],
    ['阻断任务归档', '生成一个阻断状态任务的归档快照，嵌入完整任务快照。'],
  ],
  'task.schema.json': [
    ['开发任务', '生成一个最小开发任务，包含结构化输出契约。'],
    ['审查任务', '生成一个代码审查任务，包含适用的依赖和验收信息。'],
    ['受审批多输出任务', '生成一个含审批依赖与多个结构化输出的任务。'],
  ],
};

function slug(value) {
  return value.replace(/\.schema\.json$/u, '').replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '');
}

function createCases(schemaFile) {
  const definitions = CASE_DEFINITIONS[schemaFile];
  if (!definitions || definitions.length !== 3) throw new Error(`Schema ${schemaFile} must define exactly three fixed JSON test cases.`);
  const family = slug(schemaFile);
  return definitions.map(([topic, requirement], index) => ({
    id: `${family}-${String(index + 1).padStart(2, '0')}`,
    topic,
    requirement,
    language: index === 1 ? 'English identifiers with concise Chinese business context' : '中文为主，保留必要英文标识符',
    variation: index + 1,
  }));
}

export const LLM_SCENARIOS = Object.entries(CONTRACT_SCENARIOS).map(([schemaFile, [agentId, jsonl]]) => ({
  name: slug(schemaFile), schemaFile, agentId, jsonl, cases: createCases(schemaFile),
}));

export const TEST_AGENT_LLM_SCENARIOS = LLM_SCENARIOS.filter((scenario) => scenario.agentId === 'test-agent');
export const NON_TEST_AGENT_LLM_SCENARIOS = LLM_SCENARIOS.filter((scenario) => scenario.agentId !== 'test-agent');

export function buildLlmCasePrompt(scenario, testCase, schemaText) {
  const format = scenario.jsonl ? 'JSONL，每一行是一个完整 JSON 对象' : '一个 JSON 对象';
  return [
    '这是自动化 JSON 生成与清洗工作流测试，旨在验证 Schema 输出、确定性清洗和失败修复重试是否正常。',
    '不要调用任何工具，不要读取或写入文件，不要分析或执行任务。',
    `请仅回复 ${format}，不要使用 Markdown 代码块、解释、前后缀、确认语或任何其他内容。`,
    'JSON 输出形态示例（仅示意，不可照抄字段或值）：{"field":"value"}。实际字段、类型、必填项和枚举必须以下方 Schema 为准。',
    '',
    `业务需求：${testCase.requirement}`,
    `语言偏好：${testCase.language}。`,
    `固定测试用例：${testCase.id}（变体 ${testCase.variation}，主题：${testCase.topic}）。`,
    '',
    '以下是唯一有效的 JSON Schema。不得复制项目模板，不得虚构命令、证据、提交、审批或外部事实。',
    '```json', schemaText, '```',
  ].join('\n');
}

export function buildLlmRetryPrompt(errors) {
  const compactErrors = JSON.stringify(errors);
  return [
    '这是 JSON 生成与清洗工作流测试的修复阶段。你上一次的最终回复未通过 JSON Schema 校验。',
    '不要调用工具，不要重做分析。仅根据下列错误重新回复一个完整、唯一且符合 Schema 的 JSON/JSONL 内容；不得使用 Markdown 或任何其他内容。',
    `校验错误：${compactErrors}`,
  ].join('\n');
}

export function buildEmptyLlmRetryPrompt(attempt) {
  return [
    '这是 JSON 生成与清洗工作流测试的修复阶段。你上一轮最终回复为空，未返回任何可解析内容。',
    '不要调用工具，不要重新分析任务。请依据本会话中已有的业务需求与 JSON Schema，重新输出唯一、完整、合法的 JSON/JSONL 内容。',
    '不得输出 Markdown、解释、前后缀、确认语或任何其他内容。',
    `这是针对空输出的第 ${attempt} 次重写（最多 3 次）。`,
  ].join('\n');
}
