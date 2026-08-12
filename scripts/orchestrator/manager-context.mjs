import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControlSnapshot } from '../control-core/read-model.mjs';
import { loadManagerSessionLlmConfig } from '../config/llm-config.mjs';

function estimatedTokens(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error('estimatedTokens must be a non-negative integer'), { code: 'MANAGER_TOKEN_ESTIMATE_INVALID' });
  }
  return parsed;
}

export function createManagerSessionContext({ projectRoot: projectRootInput, database, workflowId,
  estimatedTokens: estimatedTokensInput = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const policy = JSON.parse(readFileSync(join(projectRoot, 'config', 'manager-session-policy.json'), 'utf8'));
  const llm = loadManagerSessionLlmConfig(projectRoot);
  const usedTokens = estimatedTokens(estimatedTokensInput);
  const context = createControlSnapshot(database, { workflowId, view: 'manager' });
  if (!context) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'CONTROL_WORKFLOW_NOT_FOUND' });
  const softBudgetTokens = llm.softBudgetTokens || policy.soft_budget_tokens;
  const remainingTokens = usedTokens === null ? null : Math.max(0, softBudgetTokens - usedTokens);
  const action = usedTokens === null ? 'MEASURE_CONTEXT'
    : usedTokens >= softBudgetTokens ? 'START_NEW_MANAGER_SESSION' : 'CONTINUE';
  return {
    schema_version: 1,
    workflow_id: workflowId,
    session_policy: {
      model: llm.model,
      provider: llm.provider,
      api: llm.api,
      context_window_tokens: llm.contextWindowTokens,
      max_output_tokens: llm.maxOutputTokens,
      thinking_level: llm.thinkingLevel,
      model_context_window_tokens: llm.contextWindowTokens,
      max_session_tokens: llm.maxSessionTokens,
      soft_budget_percent: llm.softBudgetPercent,
      soft_budget_tokens: softBudgetTokens,
      estimated_tokens: usedTokens,
      remaining_soft_budget_tokens: remainingTokens,
      action,
      visible_output: policy.visible_output ?? { mode: 'summary_only', max_items: 4, max_chars: 1200 },
    },
    prompt_context: context,
  };
}
