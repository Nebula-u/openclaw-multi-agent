import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadAgentLlmConfig } from '../scripts/config/llm-config.mjs';
import { parseDotEnv } from '../scripts/config/dotenv.mjs';

test('dotenv parser reads comments, export syntax and quoted values', () => {
  assert.deepEqual(parseDotEnv('# comment\nexport NAME="value"\nNUMBER=128000\n'), { NAME: 'value', NUMBER: '128000' });
});

test('agent LLM config reads a project .env and process variables override it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-dotenv-'));
  try {
    await writeFile(join(root, '.env'), [
      'OPENCLAW_LLM_PROVIDER=openai', 'OPENCLAW_LLM_API=openai-completions',
      'OPENCLAW_LLM_CONTEXT_WINDOW_TOKENS=128000', 'OPENCLAW_LLM_MAX_OUTPUT_TOKENS=49152',
      'OPENCLAW_LLM_MAX_SESSION_TOKENS=200000', 'OPENCLAW_AGENT_MANAGER_AGENT_MODEL=file/model',
    ].join('\n'));
    const fromFile = loadAgentLlmConfig(root, 'manager-agent', { processEnvironment: {} });
    assert.equal(fromFile.model, 'file/model');
    assert.equal(fromFile.provider, 'file');
    const fromProcess = loadAgentLlmConfig(root, 'manager-agent', { processEnvironment: {
      OPENCLAW_AGENT_MANAGER_AGENT_MODEL: 'process/model', OPENCLAW_LLM_CONTEXT_WINDOW_TOKENS: '64000',
    } });
    assert.equal(fromProcess.model, 'process/model');
    assert.equal(fromProcess.contextWindowTokens, 64000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('qualified model references derive their provider over a generic fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-dotenv-provider-'));
  try {
    await writeFile(join(root, '.env'), 'OPENCLAW_LLM_PROVIDER=openai\nOPENCLAW_AGENT_MANAGER_AGENT_MODEL=vendor/model\n');
    const config = loadAgentLlmConfig(root, 'manager-agent', { processEnvironment: {} });
    assert.equal(config.model, 'vendor/model');
    assert.equal(config.provider, 'vendor');
  } finally { await rm(root, { recursive: true, force: true }); }
});
