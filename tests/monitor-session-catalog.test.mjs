import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSessionCatalog } from '../monitor/session-catalog.mjs';

test('session catalog includes package and persisted agents but exposes only redacted user-visible dialogue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monitor-sessions-'));
  try {
    const project = join(root, 'project');
    const sessions = join(root, 'sessions');
    mkdirSync(join(project, 'agents', 'packages', 'builtin'), { recursive: true });
    writeFileSync(join(project, 'agents', 'packages', 'builtin', 'idle.json'), JSON.stringify({ id: 'idle-agent' }));
    mkdirSync(join(sessions, 'worker-agent', 'sessions'), { recursive: true });
    writeFileSync(join(sessions, 'worker-agent', 'sessions', 'sessions.json'), JSON.stringify({
      'agent:worker-agent:explicit:key': { sessionId: 'session-1', status: 'done', model: 'test-model', totalTokens: 42,
        sessionStartedAt: 1786086506361, updatedAt: 1786087039936, endedAt: 1786087039924 },
    }));
    writeFileSync(join(sessions, 'worker-agent', 'sessions', 'session-1.jsonl'), [
      JSON.stringify({ type: 'message', timestamp: '2026-08-01T00:00:00Z', message: { role: 'user', content: '请分析 token=secret-value' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-01T00:00:01Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private chain' }, { type: 'text', text: '安全答复' }, { type: 'toolCall', name: 'exec', arguments: { password: 'x' } },
      ] } }),
      JSON.stringify({ type: 'message', message: { role: 'toolResult', content: 'private result' } }),
      JSON.stringify({ type: 'message', message: { role: 'system', content: 'private prompt' } }),
    ].join('\n'));
    const catalog = createSessionCatalog({ sessionRoot: sessions, projectRoot: project });
    assert.deepEqual(catalog.agents().map((item) => item.agent_id), ['idle-agent', 'worker-agent']);
    assert.equal(catalog.sessions('idle-agent').length, 0);
    assert.equal(catalog.sessions('worker-agent')[0].total_tokens, 42);
    const result = catalog.messages('worker-agent', 'session-1');
    assert.deepEqual(result.messages.map((item) => item.role), ['user', 'assistant']);
    assert.match(result.messages[0].text, /REDACTED_SECRET/u);
    assert.equal(result.messages[1].text, '安全答复');
    assert.doesNotMatch(JSON.stringify(result), /private chain|private result|password/u);
    assert.equal(catalog.messages('worker-agent', '../escape'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
