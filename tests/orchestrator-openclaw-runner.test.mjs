import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenClawAgentArgs, extractFinalAssistantText } from '../scripts/orchestrator/openclaw-runner.mjs';

test('worker launch inherits configured thinking so HR can review persisted reasoning', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'developer-agent', sessionId: 'session-one', messagePath: 'F:/message.md' });
  assert.equal(args.includes('--thinking'), false);
});

test('HR launch can explicitly disable its own thinking output', () => {
  const args = buildOpenClawAgentArgs({ agentId: 'hr-agent', sessionId: 'hr-one', messagePath: 'F:/message.md', thinking: 'off' });
  assert.deepEqual(args.slice(args.indexOf('--thinking'), args.indexOf('--thinking') + 2), ['--thinking', 'off']);
});

test('JSON repair reads the final assistant payload from OpenClaw JSON stdout', () => {
  const text = '{"schema_version":1}';
  assert.equal(extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { payloads: [{ text }], finalAssistantVisibleText: text } })), text);
  assert.equal(extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { finalAssistantVisibleText: ` \n${text}\n ` } })), text);
  assert.throws(() => extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { payloads: [] } })),
    (error) => error.code === 'OPENCLAW_REPAIR_OUTPUT_MISSING');
});

test('JSON repair bridge rejects wrappers, fences, arrays and multiple values', () => {
  for (const text of [
    '修复结果如下：\n{"schema_version":1}',
    '```json\n{"schema_version":1}\n```',
    '[{"schema_version":1}]',
    '{"schema_version":1}\n{"schema_version":1}',
  ]) {
    assert.throws(() => extractFinalAssistantText(JSON.stringify({ status: 'ok', result: { finalAssistantVisibleText: text } })),
      (error) => error.code === 'OPENCLAW_REPAIR_OUTPUT_INVALID');
  }
});
