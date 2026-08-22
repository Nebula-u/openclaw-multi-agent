import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { createManagerControl } from '../scripts/manager-control/service.mjs';

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

test('manager control CLI only exposes semantic project actions', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'manager-control-cli-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../scripts/manager-control/cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'ensure', '--project-root', projectRoot, '--workflow-id', 'WF-CLI-001', '--project-json', '{"mode":"new","name":"cli demo"}'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).projectRef, /^PRJ-/u);
});
