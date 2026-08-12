import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControlSnapshot } from '../control-core/read-model.mjs';

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
  const usedTokens = estimatedTokens(estimatedTokensInput);
  const context = createControlSnapshot(database, { workflowId, view: 'manager' });
  if (!context) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'CONTROL_WORKFLOW_NOT_FOUND' });
  const remainingTokens = usedTokens === null ? null : Math.max(0, policy.soft_budget_tokens - usedTokens);
  const action = usedTokens === null ? 'MEASURE_CONTEXT'
    : usedTokens >= policy.soft_budget_tokens ? 'START_NEW_MANAGER_SESSION' : 'CONTINUE';
  return {
    schema_version: 1,
    workflow_id: workflowId,
    session_policy: {
      model_context_window_tokens: policy.model_context_window_tokens,
      max_session_tokens: policy.max_session_tokens,
      soft_budget_percent: policy.soft_budget_percent,
      soft_budget_tokens: policy.soft_budget_tokens,
      estimated_tokens: usedTokens,
      remaining_soft_budget_tokens: remainingTokens,
      action,
      visible_output: policy.visible_output ?? { mode: 'summary_only', max_items: 4, max_chars: 1200 },
    },
    prompt_context: context,
  };
}
