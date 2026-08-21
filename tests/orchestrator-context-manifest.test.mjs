import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createContextManifest } from '../scripts/orchestrator/context-manifest.mjs';
import { sha256File } from '../scripts/runtime-core/atomic-store.mjs';

const ROOT = resolve(process.cwd());

function task(root, originalRequest = 'Build a Todo web app with local persistence.') {
  const artifactRootAbs = join(root, 'artifacts', 'WF-Context-001', 'TASK-Context-001');
  return {
    workflowId: 'WF-Context-001', taskId: 'TASK-Context-001', runId: 'RUN-Context-001',
    stepId: 'requirements', kind: 'REQUIREMENTS', title: 'Capture requirements', agentId: 'requirement-agent',
    attempt: 1, routeHash: 'a'.repeat(64), inputCommit: 'b'.repeat(40), originalRequest,
    targetProjectRootAbs: ROOT, worktreePathAbs: join(root, 'worktree'), artifactRootAbs,
    requiredGateChecks: [],
  };
}

test('context manifest provides the immutable original user request to Workers', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-context-'));
  try {
    const value = createContextManifest({ projectRoot: ROOT, task: task(root) });
    const requestPath = join(root, 'artifacts', 'WF-Context-001', 'TASK-Context-001', 'input', 'user-request.md');
    assert.equal(readFileSync(requestPath, 'utf8'), 'Build a Todo web app with local persistence.');
    assert.equal(value.manifest.input_files.find((file) => file.role === 'user_request')?.path_abs, requestPath);
    assert.equal(value.manifest.input_files.find((file) => file.role === 'user_request')?.sha256, sha256File(requestPath));
    const taskInput = JSON.parse(readFileSync(join(root, 'artifacts', 'WF-Context-001', 'TASK-Context-001', 'input', 'task.json'), 'utf8'));
    assert.equal(taskInput.original_request_path_abs, requestPath);
    assert.match(readFileSync(join(root, 'artifacts', 'WF-Context-001', 'TASK-Context-001', 'input', 'context.md'), 'utf8'), /Read `user-request\.md` first/u);
    assert.equal(existsSync(value.path), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('context creation fails closed if a run has no original user request', () => {
  const root = mkdtempSync(join(tmpdir(), 'orchestrator-context-'));
  try {
    assert.throws(() => createContextManifest({ projectRoot: ROOT, task: task(root, '') }), (error) => error.code === 'ORIGINAL_REQUEST_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
