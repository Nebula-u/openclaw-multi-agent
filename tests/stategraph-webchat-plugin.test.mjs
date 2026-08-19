import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../extensions/stategraph-webchat/index.js';

test('Manager CLI remains conversational while StateGraph injects only ephemeral schemas', () => {
  const registrations = [];
  plugin.register({
    pluginConfig: {},
    logger: {},
    on(name, handler, options) { registrations.push({ name, handler, options }); },
  });
  assert.equal(registrations.some(({ name }) => name === 'inbound_claim'), false);
  assert.equal(registrations.some(({ name }) => name === 'before_agent_reply'), false);
  const prompt = registrations.find(({ name }) => name === 'before_prompt_build');
  assert.ok(prompt);
  assert.equal(prompt.options.priority, 100);
  assert.ok(registrations.some(({ name }) => name === 'gateway_start'));
  assert.equal(registrations.some(({ name }) => name === 'before_agent_run'), false);
});
