import { integerEnvironment, loadProjectEnvironment } from './dotenv.mjs';

const NATIVE_AGENT_IDS = ['manager-agent', 'requirement-agent', 'architect-agent', 'developer-agent', 'review-agent', 'test-agent', 'release-agent'];

function envKey(agentId, suffix) {
  return `OPENCLAW_AGENT_${agentId.replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_${suffix}`;
}

function providerEnvKey(provider, suffix) {
  return `OPENCLAW_PROVIDER_${String(provider).replace(/[^A-Za-z0-9]/gu, '_').toUpperCase()}_${suffix}`;
}

function value(environment, agentId, suffix, globalName, fallback = '') {
  return environment[envKey(agentId, suffix)] || environment[globalName] || fallback;
}

export function nativeAgentIds() { return [...NATIVE_AGENT_IDS]; }

export function loadAgentLlmConfig(projectRoot, agentId, { processEnvironment = process.env } = {}) {
  if (!NATIVE_AGENT_IDS.includes(agentId)) throw new Error(`unsupported native Agent: ${agentId}`);
  const environment = loadProjectEnvironment(projectRoot, { processEnvironment });
  const contextWindowTokens = integerEnvironment(environment, envKey(agentId, 'CONTEXT_WINDOW_TOKENS'),
    integerEnvironment(environment, 'OPENCLAW_LLM_CONTEXT_WINDOW_TOKENS', 128000, { minimum: 1 }), { minimum: 1 });
  const maxOutputTokens = integerEnvironment(environment, envKey(agentId, 'MAX_OUTPUT_TOKENS'),
    integerEnvironment(environment, 'OPENCLAW_LLM_MAX_OUTPUT_TOKENS', 49152, { minimum: 1 }), { minimum: 1 });
  const maxSessionTokens = integerEnvironment(environment, envKey(agentId, 'MAX_SESSION_TOKENS'),
    integerEnvironment(environment, 'OPENCLAW_LLM_MAX_SESSION_TOKENS', 200000, { minimum: 1 }), { minimum: 1 });
  const model = value(environment, agentId, 'MODEL', 'OPENCLAW_LLM_MODEL', '');
  const inferredProvider = model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
  // A qualified model reference (provider/model) is authoritative.  This
  // prevents a generic OPENCLAW_LLM_PROVIDER value from producing an invalid
  // pair such as provider=openai with model=deepseek/....
  const configuredProvider = value(environment, agentId, 'PROVIDER', 'OPENCLAW_LLM_PROVIDER', '');
  const provider = inferredProvider || configuredProvider || 'openai';
  return {
    agentId,
    model,
    provider,
    api: value(environment, agentId, 'API', providerEnvKey(provider, 'API'), environment.OPENCLAW_LLM_API || 'openai-completions'),
    baseUrl: value(environment, agentId, 'BASE_URL', providerEnvKey(provider, 'BASE_URL'), environment.OPENCLAW_LLM_BASE_URL || 'https://api.openai.com/v1'),
    contextWindowTokens,
    maxOutputTokens,
    maxSessionTokens,
    maxTokensField: value(environment, agentId, 'MAX_TOKENS_FIELD', 'OPENCLAW_LLM_MAX_TOKENS_FIELD', 'max_completion_tokens'),
    thinkingLevel: value(environment, agentId, 'THINKING_LEVEL', 'OPENCLAW_LLM_THINKING_LEVEL', 'medium'),
  };
}

export function loadManagerSessionLlmConfig(projectRoot, { processEnvironment = process.env } = {}) {
  const environment = loadProjectEnvironment(projectRoot, { processEnvironment });
  const agent = loadAgentLlmConfig(projectRoot, 'manager-agent', { processEnvironment });
  const softBudgetPercent = integerEnvironment(environment, 'OPENCLAW_MANAGER_SOFT_BUDGET_PERCENT', 60, { minimum: 1, maximum: 99 });
  const softBudgetTokens = integerEnvironment(environment, 'OPENCLAW_MANAGER_SOFT_BUDGET_TOKENS',
    Math.floor(agent.contextWindowTokens * softBudgetPercent / 100), { minimum: 1 });
  return { ...agent, softBudgetPercent, softBudgetTokens };
}
