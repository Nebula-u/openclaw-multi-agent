import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONTRACT_SCENARIOS, INTERNAL_CONTRACTS } from './contract-scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const PROMPTS_PER_SCENARIO = 5;
export const REPETITIONS_PER_PROMPT = 20;

const PROMPT_VARIANTS = [
  {
    id: 'status-report',
    topic: '状态与结果汇报',
    owner: '客户服务团队',
    requirement: '生成一份保守的流程状态与结果汇报，明确当前状态、已知摘要和下一步信息；只使用需求与 Schema 能支持的内容。',
    language: '中文为主，保留 Schema 要求的英文标识符',
  },
  {
    id: 'approval-decision',
    topic: '审批与决策',
    owner: '业务审批团队',
    requirement: '生成一份审批或决策相关契约数据，表达可由 Schema 支持的决定、范围和理由；未知信息使用 Schema 允许的保守值。',
    language: 'English identifiers with concise Chinese context',
  },
  {
    id: 'audit-evidence',
    topic: '审计与证据',
    owner: '合规审计团队',
    requirement: '生成一份审计或证据记录，保持引用、时间和状态之间的一致性；不得虚构真实外部系统、提交或命令。',
    language: '中文说明，时间和 ID 使用标准英文格式',
  },
  {
    id: 'resource-description',
    topic: '配置与资源描述',
    owner: '平台运营团队',
    requirement: '生成一份配置、任务、资源或上下文描述，覆盖 Schema 要求的字段，但不增加 Schema 未允许的业务字段。',
    language: '简洁英文 JSON 字段语义，必要时使用中文值',
  },
  {
    id: 'blocked-recovery',
    topic: '异常与阻塞处理',
    owner: '故障恢复团队',
    requirement: '生成一份异常、阻塞或恢复场景契约数据，准确表达可确定的失败原因和后续动作；不把不确定信息写成事实。',
    language: '中文为主，保留枚举和标识符原文',
  },
];

function scenarioName(schemaFile) {
  return basename(schemaFile, '.schema.json');
}

function formatInstruction(jsonl) {
  return jsonl
    ? '请仅回复 JSONL；每个非空行必须是一个完整 JSON 对象。'
    : '请仅回复一个完整 JSON 对象。';
}

export function buildJsonSchemaPrompt({ scenario, prompt, schemaText }) {
  return [
    '这是一次仅检查 Agent 最终 JSON/JSONL 回复的契约测试。',
    '不要调用工具，不要读取或写入文件，不要检索信息，不要继续执行任何任务。',
    formatInstruction(scenario.jsonl),
    '不得使用 Markdown 代码块、解释、前后缀、多个候选或空回复。',
    `业务需求：${prompt.requirement}`,
    `业务主题：${prompt.topic}；负责团队：${prompt.owner}。`,
    `语言偏好：${prompt.language}。`,
    `这是固定测试 prompt：${prompt.id}。生成完成并回复唯一内容后立即结束本次会话，不要继续执行任何操作。`,
    '字段、类型、必填项、枚举、格式和允许的额外属性只能以下方唯一有效 JSON Schema 为准。',
    '不得照抄项目模板，不得虚构外部事实、命令、证据、提交、审批或文件。',
    '唯一有效 JSON Schema：',
    '```json',
    schemaText,
    '```',
  ].join('\n');
}

export function buildJsonSchemaScenarios({ contractScenarios = CONTRACT_SCENARIOS, contractsDir = join(PROJECT_ROOT, 'contracts') } = {}) {
  const entries = Object.entries(contractScenarios).sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([schemaFile, [agentId, jsonl]]) => {
    if (INTERNAL_CONTRACTS.has(schemaFile)) throw new Error(`Internal contract cannot be delegated to an Agent: ${schemaFile}`);
    const schemaPath = join(contractsDir, schemaFile);
    if (!existsSync(schemaPath)) throw new Error(`Agent contract Schema does not exist: ${schemaPath}`);
    const schemaText = readFileSync(schemaPath, 'utf8').trim();
    const name = scenarioName(schemaFile);
    const prompts = PROMPT_VARIANTS.map((variant) => {
      const prompt = { ...variant, id: `${name}-${variant.id}` };
      return { ...prompt, text: buildJsonSchemaPrompt({ scenario: { jsonl }, prompt, schemaText }) };
    });
    if (prompts.length !== PROMPTS_PER_SCENARIO) throw new Error(`Expected ${PROMPTS_PER_SCENARIO} prompts for ${schemaFile}.`);
    return { name, schemaFile, schemaPath, agentId, jsonl: Boolean(jsonl), prompts };
  });
}

export const JSON_SCHEMA_AGENT_SCENARIOS = buildJsonSchemaScenarios();
