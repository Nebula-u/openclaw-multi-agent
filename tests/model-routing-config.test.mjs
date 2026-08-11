import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const PRO = 'deepseek/deepseek-v4-pro';
const FLASH = 'deepseek/deepseek-v4-flash';

function json(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

test('builtin Agent packages use the approved static Pro and Flash split', () => {
  const expected = {
    'manager-agent': PRO,
    'requirement-agent': FLASH,
    'architect-agent': PRO,
    'developer-agent': PRO,
    'review-agent': PRO,
    'test-agent': FLASH,
    'release-agent': FLASH,
  };
  for (const [agentId, model] of Object.entries(expected)) {
    const manifest = json(join('agents', 'packages', 'builtin', `${agentId}.json`));
    assert.equal(manifest.model, model, agentId);
  }
});

test('model routing example is static and matches the builtin split', () => {
  const routing = json(join('config', 'agent-models.deepseek-routing.example.json'));
  assert.equal(routing.agents['manager-agent'].model, PRO);
  assert.equal(routing.agents['requirement-agent'].model, FLASH);
  assert.equal(routing.agents['test-agent'].model, FLASH);
  assert.equal(routing.agents['release-agent'].model, FLASH);
  assert.equal(routing.routing, undefined);
  assert.equal(routing.selector, undefined);
});

test('generated dialogue Agent defaults to the lightweight Flash model', () => {
  const manifest = json(join('agents', 'packages', 'generated', 'agents', 'dialogue-agent', 'agent.json'));
  assert.equal(manifest.model, FLASH);
});

test('manager session policy rotates before long context dominates the session', () => {
  const policy = json(join('config', 'manager-session-policy.json'));
  assert.equal(policy.soft_budget_percent, 60);
  assert.equal(policy.soft_budget_tokens, 120000);
  assert.equal(policy.thinking_level, 'medium');
  assert.ok(policy.prompt_content.include.includes('Control Kernel manager-context snapshot'));
  assert.ok(policy.prompt_content.exclude.includes('complete Control Kernel snapshot'));
  assert.ok(policy.prompt_content.exclude.includes('dispatch receipts and completion payloads'));
});
