import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createManagerControl } from '../scripts/manager-control/service.mjs';
import { run as runManagerControl } from '../scripts/manager-control/cli.mjs';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createWorkflowRepository } from '../scripts/control-kernel/workflow-repository.mjs';
import { createManagerRequestProcessor } from '../scripts/orchestrator/manager-request-queue.mjs';
import { atomicWriteJson } from '../scripts/runtime-core/atomic-store.mjs';

const ROOT = resolve(process.cwd());

function fixture(t, options = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'manager-control-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  return { projectRoot, control: createManagerControl({ projectRoot, ...options }) };
}

test('manager control creates and registers a new managed Git project', (t) => {
  const { projectRoot, control } = fixture(t);
  const project = control.ensureProject({ workflowId: 'WF-Todo-001', project: { mode: 'new', name: 'todo list' } });

  assert.match(project.projectRef, /^PRJ-[A-Za-z0-9-]+$/u);
  assert.equal(project.projectRootAbs.startsWith(realpathSync(join(projectRoot, 'runtime', 'projects'))), true);
  assert.equal(existsSync(join(project.projectRootAbs, '.git')), true);
  assert.match(project.headCommit, /^[0-9a-f]{40}$/u);
  assert.equal(control.resolveProject(project.projectRef).projectRootAbs, project.projectRootAbs);
});

test('manager control rejects a remote whose host is not configured', (t) => {
  const { control } = fixture(t);

  assert.throws(
    () => control.ensureProject({ workflowId: 'WF-Remote-001', project: { mode: 'remote', name: 'blocked', remote_url: 'https://example.invalid/org/repo.git' } }),
    (error) => error.code === 'MANAGER_GIT_HOST_DENIED',
  );
});

test('manager control reads the deployment Git host policy', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'manager-control-policy-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(join(projectRoot, 'config'), { recursive: true });
  writeFileSync(join(projectRoot, 'config', 'manager-control-policy.json'), '{"schema_version":1,"allowed_git_hosts":["git.example.test"]}\n');
  const control = createManagerControl({ projectRoot });

  assert.throws(
    () => control.ensureProject({ workflowId: 'WF-Remote-002', project: { mode: 'remote', name: 'allowed-host', remote_url: 'https://git.example.test/org/repo.git' } }),
    (error) => error.code === 'MANAGER_GIT_FAILED',
  );
});

test('manager control rechecks the host policy before fetching a registered remote', (t) => {
  const { control } = fixture(t);
  const project = control.ensureProject({ workflowId: 'WF-Fetch-001', project: { mode: 'new', name: 'fetch guard' } });
  const registry = JSON.parse(readFileSync(control.registryPath, 'utf8'));
  registry.projects[project.projectRef].remote = 'https://example.invalid/org/repo.git';
  writeFileSync(control.registryPath, `${JSON.stringify(registry)}\n`);

  assert.throws(() => control.fetchProject(project.projectRef), (error) => error.code === 'MANAGER_GIT_HOST_DENIED');
});

test('manager control rejects a linked managed projects root before creating a Git repository', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'manager-control-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'manager-control-outside-'));
  t.after(() => { rmSync(projectRoot, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  mkdirSync(join(projectRoot, 'runtime'), { recursive: true });
  try { symlinkSync(outside, join(projectRoot, 'runtime', 'projects'), 'junction'); }
  catch { t.skip('current platform does not permit creating a directory link'); return; }
  const control = createManagerControl({ projectRoot });

  assert.throws(() => control.ensureProject({ workflowId: 'WF-Link-001', project: { mode: 'new', name: 'must stay managed' } }), (error) => error.code === 'MANAGER_PROJECT_PATH_UNSAFE');
  assert.equal(existsSync(join(outside, 'wf-link-001-must-stay-managed', '.git')), false);
});

test('manager control CLI only exposes semantic project actions', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-cli-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const output = { value: '', write(value) { this.value += value; } };

  const result = runManagerControl(['ensure', '--workflow-id', 'WF-CLI-001', '--project-name', 'cli demo', '--project-mode', 'new'], output, { runtimeRoot });
  assert.match(result.projectRef, /^PRJ-/u);
  assert.match(JSON.parse(output.value).projectRef, /^PRJ-/u);
  assert.throws(() => runManagerControl(['ensure', '--workflow-id', 'WF-CLI-002', '--project-name', 'invalid remote', '--project-mode', 'new', '--remote-url', 'https://example.test/project.git'], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
  assert.throws(() => runManagerControl(['ensure', '--workflow-id', 'WF-CLI-003', '--project-name', 'missing remote', '--project-mode', 'remote'], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
  assert.throws(() => runManagerControl(['ensure', '--project-root', runtimeRoot, '--workflow-id', 'WF-CLI-004', '--project-name', 'not allowed', '--project-mode', 'new'], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
});

test('manager control lists any absolute directory without reading files or following links', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-directory-list-runtime-'));
  const directory = mkdtempSync(join(tmpdir(), 'manager-control-directory-list-target-'));
  t.after(() => { rmSync(runtimeRoot, { recursive: true, force: true }); rmSync(directory, { recursive: true, force: true }); });
  mkdirSync(join(directory, 'nested'));
  writeFileSync(join(directory, 'top-level.txt'), 'not returned as content');
  writeFileSync(join(directory, 'nested', 'child.txt'), 'not returned as content');
  const output = { value: '', write(value) { this.value += value; } };

  const listed = runManagerControl(['directory-list', '--path', directory, '--recursive', 'true'], output, { runtimeRoot });

  assert.equal(listed.path_abs, realpathSync(directory));
  assert.deepEqual(listed.entries.map((entry) => [entry.relative_path, entry.type]), [
    ['nested', 'directory'], ['nested/child.txt', 'file'], ['top-level.txt', 'file'],
  ]);
  assert.doesNotMatch(output.value, /not returned as content/u);
  assert.throws(() => runManagerControl(['directory-list', '--path', 'relative-directory'], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
});

test('manager control reads the bound pending approval and writes a matching decision request', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-approval-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-manager-approval', request: {}, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  const task = await repository.createTask({ runId: run.runId, step: { step_id: 'requirements', kind: 'REQUIREMENTS', title: 'Requirements' }, agentId: 'requirement-agent' });
  await repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: 'REQUIREMENT_AMBIGUITY', request: {
    decision_id: 'DEC-manager-approval-full', workflow_id: run.workflowId, run_id: run.runId, task_id: task.taskId, summary: 'Approve requirements', options: [{ id: 'APPROVE', description: 'Continue' }],
  } });
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-status', '--workflow-id', run.workflowId, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key'], output, { runtimeRoot });
  assert.equal(status.pending_approval.decision_id, 'DEC-manager-approval-full');
  const submitted = runManagerControl(['orchestrator-approve', '--workflow-id', run.workflowId, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key',
    '--decision-id', status.pending_approval.decision_id, '--choice', 'APPROVE', '--authorization-summary', 'User explicitly approved requirements'], output, { runtimeRoot });
  const request = JSON.parse(readFileSync(submitted.request_path, 'utf8'));
  assert.equal(request.decision_id, 'DEC-manager-approval-full');
  assert.equal(request.choice, 'APPROVE');
  assert.equal(request.user_authorized.message, 'User explicitly approved requirements');
  assert.throws(() => runManagerControl(['orchestrator-approve', '--workflow-id', run.workflowId, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key',
    '--decision-id', status.pending_approval.decision_id, '--choice', 'APPROVE', '--authorization-summary', '   '], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
});

test('manager control finds the latest workflow bound to the supplied session key', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-current-status-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  let timestamp = Date.parse('2026-09-01T00:00:00.000Z');
  const repository = createWorkflowRepository({ database, clock: () => new Date(timestamp += 1000) });
  await repository.createRun({ workflowId: 'WF-current-old', request: { original_request: '旧需求', project_ref: 'PRJ-old' }, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session-old', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  await repository.createRun({ workflowId: 'WF-current-other', request: { original_request: '不应泄露', project_ref: 'PRJ-other' }, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session-other', managerSessionKey: 'other-manager-key', routePlan: { steps: [], route_hash: 'b'.repeat(64) } });
  const latest = await repository.createRun({ workflowId: 'WF-current-latest', request: { original_request: '重新发起待办项目', project_ref: 'PRJ-latest' }, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session-latest', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'c'.repeat(64) } });
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-current-status', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.equal(status.workflow_id, latest.workflowId);
  assert.equal(status.manager_session_id, 'manager-session-latest');
  assert.equal(status.original_request, '重新发起待办项目');
  assert.equal(status.project_ref, 'PRJ-latest');
  assert.doesNotMatch(output.value, /不应泄露/u);
  assert.throws(() => runManagerControl(['orchestrator-current-status', '--manager-session-key', 'missing-manager-key'], output, { runtimeRoot }), (error) => error.code === 'WORKFLOW_NOT_FOUND');
});

test('manager control finds a queued workflow bound to the supplied session key before SQLite exists', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-current-queued-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  const requestRoot = join(runtimeRoot, 'agents', 'manager-agent', 'workspace', '.orchestrator');
  mkdirSync(join(requestRoot, 'requests'), { recursive: true });
  atomicWriteJson(join(requestRoot, 'requests', 'queued.json'), {
    schema_version: 1, request_id: 'REQ-current-queued', request_type: 'CREATE', workflow_id: 'WF-current-queued',
    manager_session_id: 'manager-session-queued', manager_session_key: 'manager-key', original_request: '排队中的需求', project_ref: 'PRJ-queued',
  });
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-current-status', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.equal(status.state, 'REQUEST_QUEUED');
  assert.equal(status.workflow_id, 'WF-current-queued');
  assert.equal(status.manager_session_id, 'manager-session-queued');
  assert.equal(status.original_request, '排队中的需求');
  assert.equal(status.project_ref, 'PRJ-queued');
});

test('manager control reports the latest published task location for its bound workflow', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-result-location-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-manager-result-location', request: {}, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  const task = await repository.createTask({ runId: run.runId, step: { step_id: 'development', kind: 'DEVELOPMENT', title: 'Build' }, agentId: 'developer-agent' });
  const publishedResult = {
    task_id: task.taskId,
    worktree_path_abs: join(runtimeRoot, 'work', 'build', 'repo'),
    artifact_root_abs: join(runtimeRoot, 'work', 'build'),
    published_output_path_abs: join(runtimeRoot, 'work', 'build', 'output', 'result.json'),
    output_commit: '2'.repeat(40),
  };
  await repository.updateTask(task.taskId, { state: 'SUCCEEDED', payload: {
    workspace_root_abs: publishedResult.artifact_root_abs,
    worktree_path_abs: publishedResult.worktree_path_abs,
    artifact_root_abs: publishedResult.artifact_root_abs,
    published_output_path_abs: publishedResult.published_output_path_abs,
    snapshot: { outputCommit: publishedResult.output_commit },
  } });
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-status', '--workflow-id', run.workflowId, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.deepEqual(status.published_result, publishedResult);
});

test('manager control reports a bound rejected request before it is stored in SQLite', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-rejected-request-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const request = {
    schema_version: 1, request_id: 'REQ-rejected-status', request_type: 'CREATE', workflow_id: 'WF-rejected-status', submitted_by: 'manager-agent',
    manager_session_id: 'manager-session', manager_session_key: 'manager-key', project_path_abs: ROOT, original_request: 'Build a demo',
    route_plan: {
      schema_version: 1, workflow_id: 'WF-rejected-status', request_class: 'ANALYSIS_ONLY', summary: 'Review the codebase.', display_title: 'This title is too long', risk_flags: [],
      steps: [{ step_id: 'review', kind: 'CODE_REVIEW', title: 'Review', rationale: 'The user requested a review.', human_approval_after: false, approval_reason: null }],
      skipped_stages: ['REQUIREMENTS', 'ARCHITECTURE', 'DESIGN', 'DEVELOPMENT', 'TEST', 'RELEASE'].map((kind) => ({ kind, reason: 'Not required for this request.' })),
    },
    user_authorized: { confirmed: true, actor: 'human:liuxu', message: 'Run the confirmed route.' },
  };
  const queue = createManagerRequestProcessor({
    projectRoot: ROOT,
    orchestrator: { projectRoot: ROOT, runtimeRoot, async createRun() { throw new Error('must not create a rejected run'); }, async tickAll() { return []; } },
  });
  atomicWriteJson(join(queue.requests, 'rejected-status.json'), request);
  await queue.processFile('rejected-status.json');
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-status', '--workflow-id', request.workflow_id, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.equal(status.state, 'REQUEST_REJECTED');
  assert.equal(status.run_id, null);
  assert.equal(status.request.request_id, request.request_id);
  assert.equal(status.request.request_type, request.request_type);
  assert.equal(status.request.status, 'REJECTED');
  assert.equal(status.request.error.code, 'ROUTE_PLAN_SCHEMA_INVALID');
  assert.match(status.request.error.message, /route plan failed JSON Schema validation/u);
  assert.equal(typeof status.request.processed_at, 'string');
});

test('manager control recognizes a legacy rejected receipt with missing identity fields', (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-legacy-receipt-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const requestRoot = join(runtimeRoot, 'agents', 'manager-agent', 'workspace', '.orchestrator');
  mkdirSync(join(requestRoot, 'requests'), { recursive: true });
  mkdirSync(join(requestRoot, 'receipts'), { recursive: true });
  const request = { request_id: 'REQ-legacy-receipt', request_type: 'CREATE', workflow_id: 'WF-legacy-receipt', manager_session_id: 'manager-session', manager_session_key: 'manager-key' };
  const requestPath = join(requestRoot, 'requests', 'legacy.json');
  atomicWriteJson(requestPath, request);
  const inputSha256 = createHash('sha256').update(readFileSync(requestPath, 'utf8'), 'utf8').digest('hex');
  atomicWriteJson(join(requestRoot, 'receipts', 'legacy.json.receipt.json'), {
    schema_version: 1, request_id: null, request_type: null, workflow_id: null, input_sha256: inputSha256,
    status: 'REJECTED', processed_at: '2026-08-31T00:00:00.000Z', error: { code: 'ROUTE_PLAN_SCHEMA_INVALID', message: 'Route plan is invalid', details: null },
  });
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-status', '--workflow-id', request.workflow_id, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.equal(status.state, 'REQUEST_REJECTED');
  assert.equal(status.request.request_id, request.request_id);
  assert.equal(status.request.error.code, 'ROUTE_PLAN_SCHEMA_INVALID');
});

test('manager control keeps SQLite workflow status authoritative over a matching request receipt', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-sqlite-authority-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-sqlite-authority', request: {}, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  const requestRoot = join(runtimeRoot, 'agents', 'manager-agent', 'workspace', '.orchestrator');
  mkdirSync(join(requestRoot, 'requests'), { recursive: true });
  mkdirSync(join(requestRoot, 'receipts'), { recursive: true });
  const request = { request_id: 'REQ-shadow', request_type: 'CREATE', workflow_id: run.workflowId, manager_session_id: 'manager-session', manager_session_key: 'manager-key' };
  writeFileSync(join(requestRoot, 'requests', 'shadow.json'), JSON.stringify(request));
  writeFileSync(join(requestRoot, 'receipts', 'shadow.json.receipt.json'), JSON.stringify({ request_id: request.request_id, request_type: request.request_type, workflow_id: request.workflow_id, status: 'REJECTED' }));
  const output = { value: '', write(value) { this.value += value; } };

  const status = runManagerControl(['orchestrator-status', '--workflow-id', run.workflowId, '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key'], output, { runtimeRoot });

  assert.equal(status.run_id, run.runId);
  assert.notEqual(status.state, 'REQUEST_REJECTED');
  assert.equal(status.request, undefined);
});

test('manager control queues a session-bound user-authorized pause command', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-pause-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-manager-pause', request: {}, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  const output = { value: '', write(value) { this.value += value; } };

  const submitted = runManagerControl(['orchestrator-control', '--workflow-id', run.workflowId,
    '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key', '--action', 'PAUSE',
    '--authorization-summary', '用户要求暂停当前流程'], output, { runtimeRoot });

  assert.equal(submitted.status, 'QUEUED');
  assert.equal(JSON.parse(readFileSync(submitted.command_path, 'utf8')).action, 'PAUSE');
  assert.throws(() => runManagerControl(['orchestrator-control', '--workflow-id', run.workflowId,
    '--manager-session-id', 'manager-session', '--manager-session-key', 'manager-key', '--action', 'PAUSE',
    '--authorization-summary', '  '], output, { runtimeRoot }), (error) => error.code === 'MANAGER_CONTROL_USAGE');
});

test('Windows manager-control.cmd preserves semantic project arguments from PowerShell', (t) => {
  if (process.platform !== 'win32') { t.skip('Windows-only PowerShell and .cmd integration test'); return; }
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-cmd-'));
  t.after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
  for (const directory of ['manager-control', 'runtime-core', 'control-kernel']) {
    cpSync(join(import.meta.dirname, '..', 'scripts', directory), join(runtimeRoot, directory), { recursive: true });
  }
  writeFileSync(join(runtimeRoot, 'manager-control', 'manager-control-policy.json'), '{"schema_version":1,"allowed_git_hosts":[]}\n');
  const entrypoint = join(runtimeRoot, 'manager-control', 'manager-control.cmd');
  const invocation = spawnSync('pwsh.exe', [
    '-NoProfile', '-Command',
    '& $env:MANAGER_CONTROL_ENTRY ensure --workflow-id $env:MANAGER_CONTROL_WORKFLOW --project-name $env:MANAGER_CONTROL_PROJECT --project-mode new',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      MANAGER_CONTROL_ENTRY: entrypoint,
      MANAGER_CONTROL_WORKFLOW: 'WF-Windows-Cmd-001',
      MANAGER_CONTROL_PROJECT: 'project name with spaces',
    },
  });
  assert.equal(invocation.status, 0, invocation.stderr);
  assert.match(JSON.parse(invocation.stdout).projectRef, /^PRJ-/u);
});
