import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createGitWorktreeManager } from '../scripts/stategraph/git-worktree.mjs';
import { createContextManifest, verifyContextManifest } from '../scripts/stategraph/context-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(root) {
  const repo = join(root, 'target');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'StateGraph Test');
  git(repo, 'config', 'user.email', 'stategraph@example.invalid');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'base');
  return { repo, commit: git(repo, 'rev-parse', 'HEAD') };
}

test('each run gets a detached worktree bound to the checkpoint input commit', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-worktree-'));
  try {
    const { repo, commit } = repository(temp);
    const manager = createGitWorktreeManager({ projectRoot: join(temp, 'framework') });
    assert.equal(manager.inspectTarget(repo).head_commit, commit);
    const first = { workflow_id: 'WF-trust', task_id: 'TASK-trust-dev', run_id: 'RUN-trust-dev-A1', input_commit: commit,
      target_project_root_abs: repo, worktree_path_abs: null };
    first.worktree_path_abs = manager.pathFor(first);
    const prepared = manager.prepare(first);
    assert.equal(manager.head(prepared.worktree_path_abs), commit);
    writeFileSync(join(prepared.worktree_path_abs, 'feature.txt'), 'candidate\n');
    git(prepared.worktree_path_abs, 'add', 'feature.txt');
    git(prepared.worktree_path_abs, 'commit', '-m', 'candidate');
    const candidate = manager.head(prepared.worktree_path_abs);
    assert.equal(manager.assertDescendant(prepared.worktree_path_abs, commit, candidate), true);
    const retry = { ...first, run_id: 'RUN-trust-dev-A2' };
    retry.worktree_path_abs = manager.pathFor(retry);
    manager.prepare(retry);
    assert.notEqual(retry.worktree_path_abs, first.worktree_path_abs);
    assert.equal(existsSync(first.worktree_path_abs), true);
    assert.equal(manager.head(retry.worktree_path_abs), commit);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('immutable context manifest detects input tampering before reconcile', () => {
  const temp = mkdtempSync(join(tmpdir(), 'stategraph-context-'));
  const workflowRoot = join(ROOT, 'runtime', 'artifacts', 'WF-context-boundary');
  try {
    const { repo, commit } = repository(temp);
    const task = {
      workflow_id: 'WF-context-boundary', task_id: 'TASK-context-boundary-dev', run_id: 'RUN-context-boundary-dev-A1',
      step_id: 'development', kind: 'DEVELOPMENT', title: '实现', prompt: 'test', agent_id: 'developer-agent', attempt: 1,
      route_hash: 'b'.repeat(64), input_commit: commit, target_project_root_abs: repo, worktree_path_abs: repo,
      artifact_root_abs: join(workflowRoot, 'TASK-context-boundary-dev', 'runs', 'RUN-context-boundary-dev-A1'),
      required_gate_checks: ['implementation'], session_id: 'session-test',
    };
    const created = createContextManifest({ projectRoot: ROOT, task });
    task.context_manifest_path_abs = created.path;
    task.context_manifest_sha256 = created.sha256;
    assert.equal(verifyContextManifest({ projectRoot: ROOT, task }).sha256, created.sha256);
    const manifest = JSON.parse(readFileSync(created.path, 'utf8'));
    const rule = manifest.input_files.find((item) => item.role === 'rule').path_abs;
    chmodSync(rule, 0o666);
    writeFileSync(rule, 'tampered\n');
    assert.throws(() => verifyContextManifest({ projectRoot: ROOT, task }), (error) => error.code === 'CONTEXT_INPUT_HASH_MISMATCH');
  } finally {
    rmSync(workflowRoot, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
});

