import assert from 'node:assert/strict';
import test from 'node:test';
import { redactValue } from '../monitor/redactor.mjs';

test('redactor removes thinking and credentials while truncating long text', () => {
  const value = redactValue({
    thinking: 'private reasoning',
    summary: 'token=super-secret-value Bearer abcdefghijklmnopqrstuvwxyz',
    nested: { password: 'do-not-show', text: 'x'.repeat(50) },
  }, { maxStringLength: 20 });
  assert.equal('thinking' in value, false);
  assert.doesNotMatch(value.summary, /super-secret|abcdef/u);
  assert.match(value.nested.text, /TRUNCATED/u);
});

