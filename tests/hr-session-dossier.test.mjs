import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSessionDossier } from '../scripts/hr/session-dossier.mjs';

test('HR dossier keeps assistant reasoning, final output and Git changes only', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hr-dossier-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'developer-agent', 'sessions'); mkdirSync(sessions, { recursive: true });
  const records = [
    { type: 'message', timestamp: '2026-08-21T01:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'private user request' }] } },
    { type: 'message', timestamp: '2026-08-21T01:01:00Z', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'I guess secret=abc and should inspect scope.' },
      { type: 'tool_use', name: 'shell', input: { token: 'tool-secret' } },
      { type: 'text', text: 'intermediate answer' },
    ] } },
    { type: 'message', timestamp: '2026-08-21T01:02:00Z', message: { role: 'assistant', content: [
      { type: 'reasoning', text: 'The task boundary is still uncertain.' },
      { type: 'text', text: 'Final verified output.' },
    ] } },
  ];
  writeFileSync(join(sessions, 'session-one.jsonl'), `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const dossier = buildSessionDossier({ sessionRoot: root, agentId: 'developer-agent', sessionId: 'session-one',
    snapshot: { snapshotId: 'SNP-one', runId: 'RUN-one', taskId: 'TASK-one', executionId: 'EXE-one', attempt: 2,
      createdAt: '2026-08-21T01:03:00Z', inputCommit: '1'.repeat(40), outputCommit: '2'.repeat(40), changeSummary: { modified: ['app.js'] } },
    boundary: { task_kind: 'DEVELOPMENT', title: 'Implement app change', mutation_policy: 'TARGET_REPOSITORY_ALLOWED' },
    patch: 'diff --git a/app.js b/app.js\n+changed\n' });
  assert.deepEqual(dossier.messages.map((item) => item.kind), ['THINKING', 'THINKING', 'FINAL_OUTPUT']);
  assert.doesNotMatch(JSON.stringify(dossier), /private user request|tool-secret|intermediate answer/u);
  assert.doesNotMatch(JSON.stringify(dossier), /secret=abc/u);
  assert.equal(dossier.git.output_commit, '2'.repeat(40));
  assert.deepEqual(dossier.git.change_summary.modified, ['app.js']);
  assert.equal(dossier.context.task_id, 'TASK-one');
  assert.equal(dossier.context.execution_id, 'EXE-one');
  assert.equal(dossier.context.boundary.title, 'Implement app change');
});

test('HR dossier rejects unsafe identities and reports deterministic truncation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hr-dossier-limit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'agent', 'sessions'); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'session.jsonl'), `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x'.repeat(100) }, { type: 'text', text: 'done' }] } })}\n`);
  assert.throws(() => buildSessionDossier({ sessionRoot: root, agentId: '../agent', sessionId: 'session' }), (error) => error.code === 'HR_SESSION_ID_UNSAFE');
  const dossier = buildSessionDossier({ sessionRoot: root, agentId: 'agent', sessionId: 'session', limits: { thinkingChars: 20, patchChars: 20 } });
  assert.equal(dossier.messages[0].truncated, true);
  assert.equal(dossier.messages[0].original_chars, 100);
  assert.equal(dossier.messages[0].retained_chars, 20);
});

test('HR dossier applies one total reasoning budget across the Session', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hr-dossier-total-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, 'agent', 'sessions'); mkdirSync(sessions, { recursive: true });
  const records = [
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'a'.repeat(15) }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'reasoning', text: 'b'.repeat(15) }, { type: 'text', text: 'done' }] } },
  ];
  writeFileSync(join(sessions, 'session.jsonl'), `${records.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const dossier = buildSessionDossier({ sessionRoot: root, agentId: 'agent', sessionId: 'session', limits: { thinkingChars: 20 } });
  const reasoning = dossier.messages.filter((item) => item.kind === 'THINKING');
  assert.equal(reasoning.reduce((sum, item) => sum + item.retained_chars, 0), 20);
  assert.equal(reasoning.at(-1).truncated, true);
  assert.equal(dossier.selection.reasoning_budget_chars, 20);
  assert.equal(dossier.selection.reasoning_original_chars, 30);
  assert.equal(dossier.selection.reasoning_truncated, true);
});

test('HR dossier rejects an Agent directory link that escapes the Session root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hr-dossier-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'hr-dossier-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  const sessions = join(outside, 'sessions'); mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'session.jsonl'), `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'outside' }] } })}\n`);
  symlinkSync(outside, join(root, 'agent'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildSessionDossier({ sessionRoot: root, agentId: 'agent', sessionId: 'session' }),
    (error) => error.code === 'HR_SESSION_PATH_ESCAPE');
});
