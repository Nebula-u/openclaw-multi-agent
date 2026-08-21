import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenClawAgentArgs } from '../scripts/orchestrator/openclaw-runner.mjs';

test('worker launch inherits configured thinking so HR can review persisted reasoning', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'developer-agent', sessionId: 'session-one', messagePath: 'F:/message.md' });
  assert.equal(args.includes('--thinking'), false);
});

test('HR launch can explicitly disable its own thinking output', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'hr-agent', sessionId: 'hr-one', messagePath: 'F:/message.md', thinking: 'off' });
  assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', 'off']);
});
