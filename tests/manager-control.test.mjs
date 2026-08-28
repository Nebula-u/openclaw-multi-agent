import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createManagerControl } from '../scripts/manager-control/service.mjs';
import { run as runManagerControl } from '../scripts/manager-control/cli.mjs';
import { openKernelDatabase } from '../scripts/control-kernel/database.mjs';
import { createWorkflowRepository } from '../scripts/control-kernel/workflow-repository.mjs';

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

test('manager control reads the bound pending approval and writes a matching decision request', async (t) => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'manager-control-approval-'));
  const database = openKernelDatabase({ databasePath: join(runtimeRoot, 'control', 'kernel.db') });
  t.after(() => { database.close(); rmSync(runtimeRoot, { recursive: true, force: true }); });
  const repository = createWorkflowRepository({ database });
  const run = await repository.createRun({ workflowId: 'WF-manager-approval', request: {}, targetProjectRootAbs: runtimeRoot, baseCommit: '1'.repeat(40),
    managerSessionId: 'manager-session', managerSessionKey: 'manager-key', routePlan: { steps: [], route_hash: 'a'.repeat(64) } });
  const task = await repository.createTask({ runId: run.runId, step: { step_id: 'requirements', kind: 'REQUIREMENTS', title: 'Requirements' }, agentId: 'requirement-agent' });
  await repository.createApproval({ runId: run.runId, taskId: task.taskId, stepId: task.stepId, trigger: 'REQUIREMENT_AMBIGUITY', request: {
    decision_id: 'DEC-manager-approval-full', workflow_id: run.workflowId, run_id: run.runId, task_id: task.taskId, summary: 'Approve requirements', options: [{ option_id: 'APPROVE', description: 'Continue' }],
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
