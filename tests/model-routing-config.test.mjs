import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadAgentLlmConfig, loadManagerSessionLlmConfig } from '../scripts/config/llm-config.mjs';

const ROOT = resolve(import.meta.dirname, '..');
function json(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

test('model selection interface is static, per Agent and provider-neutral', () => {
  const routing = json(join('config', 'agent-models.example.json'));
  for (const agentId of ['manager-agent', 'requirement-agent', 'architect-agent', 'developer-agent', 'review-agent', 'test-agent', 'release-agent']) {
    assert.equal(typeof routing.agents[agentId].model, 'string', agentId);
  }
  assert.equal(routing.routing, undefined);
  assert.equal(routing.selector, undefined);
});

test('OpenAI provider template uses Chat Completions with bounded generic limits', () => {
  const provider = json(join('config', 'openai-provider.example.json'));
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.models[0].api, 'openai-completions');
  assert.equal(provider.models[0].contextWindow, 128000);
  assert.equal(provider.models[0].maxTokens, 49152);
  assert.equal(provider.models[0].compat.maxTokensField, 'max_completion_tokens');
  assert.equal(provider.apiKey, undefined);
});

test('manager session policy rotates before long context dominates the session', () => {
  const policy = json(join('config', 'manager-session-policy.json'));
  const llm = loadManagerSessionLlmConfig(ROOT, { processEnvironment: {} });
  assert.equal(llm.softBudgetPercent, 60);
  assert.equal(llm.contextWindowTokens, 128000);
  assert.equal(llm.softBudgetTokens, 76800);
  assert.equal(llm.maxSessionTokens, 200000);
  assert.equal(llm.thinkingLevel, 'medium');
  assert.equal(policy.thinking_level, undefined);
  assert.equal(policy.visible_output.mode, 'summary_only');
  assert.equal(policy.visible_output.max_items, 4);
  assert.ok(policy.prompt_content.include.includes('Control Kernel manager-context snapshot'));
  assert.ok(policy.prompt_content.exclude.includes('complete Control Kernel snapshot'));
  assert.ok(policy.prompt_content.exclude.includes('dispatch receipts and completion payloads'));
});

test('the project .env is the active seven-Agent LLM source', () => {
  const agentIds = ['manager-agent', 'requirement-agent', 'architect-agent', 'developer-agent', 'review-agent', 'test-agent', 'release-agent'];
  for (const agentId of agentIds) {
    const config = loadAgentLlmConfig(ROOT, agentId, { processEnvironment: {} });
    assert.ok(config.model, agentId);
    assert.equal(config.contextWindowTokens, 128000, agentId);
    assert.equal(config.maxOutputTokens, 49152, agentId);
    assert.equal(config.maxSessionTokens, 200000, agentId);
    assert.equal(config.api, 'openai-completions', agentId);
    assert.equal(config.provider, config.model.split('/', 1)[0], agentId);
  }
});
