import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTestSandboxStager } from '../scripts/orchestrator/test-sandbox-staging.mjs';

function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  return String(result.stdout).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'test-sandbox-staging-'));
  const source = join(root, 'source');
  const workspace = join(root, 'test-agent-workspace');
  const artifactRootAbs = join(root, 'artifacts', 'WF-stage', 'TASK-stage');
  const inputRoot = join(artifactRootAbs, 'input');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'app.js'), 'export const value = 1;\n');
  git(source, ['init']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  git(source, ['config', 'user.name', 'Test Runner']);
  git(source, ['add', 'app.js']);
  git(source, ['commit', '-m', 'initial']);
  mkdirSync(inputRoot, { recursive: true });
  writeFileSync(join(inputRoot, 'context-manifest.json'), '{"task":"stage"}\n');
  writeFileSync(join(inputRoot, 'user-request.md'), 'Test only this repository.\n');
  return {
    root,
    workspace,
    task: {
      workflowId: 'WF-stage',
      taskId: 'TASK-stage',
      runId: 'RUN-stage',
      attempt: 1,
      inputCommit: git(source, ['rev-parse', 'HEAD']),
      worktreePathAbs: source,
      artifactRootAbs,
      contextManifestPathAbs: join(inputRoot, 'context-manifest.json'),
    },
  };
}

test('staging exposes only the assigned input and repository clone', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createTestSandboxStager({ workspaceRoot: value.workspace });

  const staged = stager.prepare(value.task);

  assert.equal(staged.executionRootAbs, join(value.workspace, '.task-sandbox'));
  assert.equal(staged.executionWorktreeAbs, join(value.workspace, '.task-sandbox', 'repo'));
  assert.equal(staged.executionInputRootAbs, join(value.workspace, '.task-sandbox', 'input'));
  assert.equal(readFileSync(join(staged.executionInputRootAbs, 'user-request.md'), 'utf8'), 'Test only this repository.\n');
  assert.equal(readFileSync(join(staged.executionWorktreeAbs, 'app.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(existsSync(join(value.workspace, '.task-sandbox', 'sibling-task')), false);
  assert.equal(staged.attestation.input_commit, value.task.inputCommit);

  stager.cleanup(staged);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
});

test('staging rejects a second TEST task until the active staging is cleaned', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createTestSandboxStager({ workspaceRoot: value.workspace });
  const first = stager.prepare(value.task);

  assert.throws(() => stager.prepare({ ...value.task, taskId: 'TASK-other' }), (error) => error.code === 'TEST_SANDBOX_BUSY');

  stager.cleanup(first);
  const second = stager.prepare({ ...value.task, taskId: 'TASK-other' });
  stager.cleanup(second);
});

test('collection copies only staged result and raw logs to the canonical artifact root', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createTestSandboxStager({ workspaceRoot: value.workspace });
  const staged = stager.prepare(value.task);
  mkdirSync(staged.executionRawLogsRootAbs, { recursive: true });
  writeFileSync(staged.executionRawOutputPath, '{"result_status":"BLOCKED"}\n');
  writeFileSync(join(staged.executionRawLogsRootAbs, 'test.stdout.log'), 'real test output\n');

  const collected = stager.collect(value.task, staged);

  assert.equal(readFileSync(join(value.task.artifactRootAbs, '.agent-raw', 'result.json.raw'), 'utf8'), '{"result_status":"BLOCKED"}\n');
  assert.equal(readFileSync(join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log'), 'utf8'), 'real test output\n');
  assert.deepEqual(collected.rawLogs, [join(value.task.artifactRootAbs, 'raw-logs', 'test.stdout.log')]);
  stager.cleanup(staged);
});
