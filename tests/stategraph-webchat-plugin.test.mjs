import assert from 'node:assert/strict';
import test from 'node:test';
import plugin from '../extensions/stategraph-webchat/index.js';

test('StateGraph WebChat uses a synthetic reply hook instead of a blocking gate', () => {
  const registrations = [];
  plugin.register({
    pluginConfig: {},
    logger: {},
    on(name, handler, options) { registrations.push({ name, handler, options }); },
  });
  assert.ok(registrations.some(({ name }) => name === 'inbound_claim'));
  const direct = registrations.find(({ name }) => name === 'before_agent_reply');
  assert.ok(direct);
  assert.equal(direct.options.priority, 100);
  assert.equal(registrations.some(({ name }) => name === 'before_agent_run'), false);
});
