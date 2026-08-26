import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTestSandboxStager } from '../scripts/orchestrator/test-sandbox-staging.mjs';
import { sha256File } from '../scripts/runtime-core/atomic-store.mjs';

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
  const hostRawOutput = join(artifactRootAbs, '.agent-raw', 'result.json.raw');
  const hostPublishedOutput = join(artifactRootAbs, 'output', 'result.json');
  writeFileSync(join(inputRoot, 'task.json'), `${JSON.stringify({
    target_project_root_abs: source,
    worktree_path_abs: source,
    artifact_root_abs: artifactRootAbs,
    allowed_write_paths_abs: [source, join(artifactRootAbs, '.agent-raw')],
    forbidden_paths_abs: [inputRoot, join(artifactRootAbs, 'output')],
    original_request_path_abs: join(inputRoot, 'user-request.md'),
    prior_artifacts: [],
  })}\n`);
  writeFileSync(join(inputRoot, 'context-manifest.json'), `${JSON.stringify({
    task: 'stage', target_project_root_abs: source, worktree_path_abs: source, artifact_root_abs: artifactRootAbs,
    input_files: [{ path_abs: join(inputRoot, 'task.json'), sha256: 'a'.repeat(64), role: 'task' }],
    expected_output_paths_abs: [hostRawOutput, hostPublishedOutput],
  })}\n`);
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
  const executionManifest = JSON.parse(readFileSync(staged.executionContextManifestPathAbs, 'utf8'));
  assert.equal(staged.containerWorktreeAbs, '/workspace/.task-sandbox/repo');
  assert.equal(executionManifest.worktree_path_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.execution_raw_output_path_abs, staged.containerRawOutputPath);
  assert.equal(executionManifest.target_project_root_abs, staged.containerWorktreeAbs);
  assert.equal(executionManifest.artifact_root_abs, staged.containerRootAbs);
  assert.deepEqual(executionManifest.input_files.map((file) => file.path_abs), [join(staged.containerInputRootAbs, 'task.json')]);
  assert.deepEqual(executionManifest.input_files.map((file) => file.sha256), [sha256File(join(staged.executionInputRootAbs, 'task.json'))]);
  assert.deepEqual(executionManifest.expected_output_paths_abs, [staged.containerRawOutputPath]);
  assert.deepEqual(executionManifest.result_identity, {
    worktree_path_abs: value.task.worktreePathAbs,
    artifact_root_abs: value.task.artifactRootAbs,
    input_commit: value.task.inputCommit,
    artifact_manifest_hash: null,
  });
  const stagedTask = JSON.parse(readFileSync(join(staged.executionInputRootAbs, 'task.json'), 'utf8'));
  assert.equal(stagedTask.worktree_path_abs, staged.containerWorktreeAbs);
  assert.equal(stagedTask.artifact_root_abs, staged.containerRootAbs);
  assert.deepEqual(stagedTask.allowed_write_paths_abs, [staged.containerWorktreeAbs, staged.containerOutputRootAbs, staged.containerRawLogsRootAbs]);
  assert.deepEqual(stagedTask.forbidden_paths_abs, [staged.containerInputRootAbs]);
  assert.deepEqual(stagedTask.result_identity, executionManifest.result_identity);
  const { result_identity: ignoredResultIdentity, ...executionView } = executionManifest;
  const { result_identity: ignoredTaskIdentity, ...executionTaskView } = stagedTask;
  assert.equal(JSON.stringify(executionView).includes(value.task.worktreePathAbs), false, 'execution manifest must not retain the host worktree outside result identity');
  assert.equal(JSON.stringify(executionView).includes(value.task.artifactRootAbs), false, 'execution manifest must not retain the host artifact root outside result identity');
  assert.equal(JSON.stringify(executionTaskView).includes(value.task.worktreePathAbs), false, 'staged task input must not retain the host worktree outside result identity');
  assert.equal(JSON.stringify(executionTaskView).includes(value.task.artifactRootAbs), false, 'staged task input must not retain the host artifact root outside result identity');
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

test('failed preparation removes the staging root and lock before propagating the error', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const stager = createTestSandboxStager({ workspaceRoot: value.workspace });

  assert.throws(() => stager.prepare({ ...value.task, worktreePathAbs: join(value.root, 'missing-worktree') }), (error) => error.code === 'TEST_SANDBOX_WORKTREE_MISSING');

  assert.equal(existsSync(join(value.workspace, '.task-sandbox')), false);
  assert.equal(existsSync(join(value.workspace, '.task-sandbox.lock')), false);
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
