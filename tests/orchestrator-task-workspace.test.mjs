import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { cleanLegacyWorkspaces, createTaskWorkspaceManager } from '../scripts/orchestrator/task-workspace.mjs';

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (value !== '..' && !value.startsWith('../'));
}

test('workspace paths use readable project and Agent segments with incrementing operations', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const first = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', agentId: 'developer-agent', title: '新增 登录功能！' });
  const second = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', agentId: 'developer-agent', title: '新增 登录功能！' });

  assert.equal(relative(join(root, 'work'), first.workspaceRootAbs), join('storefront', 'developer-agent', 'operation-0001'));
  assert.equal(relative(join(root, 'work'), second.workspaceRootAbs), join('storefront', 'developer-agent', 'operation-0002'));
  assert.equal(first.worktreePathAbs, join(first.workspaceRootAbs, 'repo'));
  assert.equal(existsSync(first.workspaceRootAbs), true);
  assert.equal(inside(join(root, 'work'), first.workspaceRootAbs), true);
});

test('workspace paths are grouped by project, Agent and incrementing operation number', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const first = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', agentId: 'developer-agent', title: '新增 登录功能' });
  const second = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', agentId: 'developer-agent', title: '修复 登录功能' });

  assert.equal(relative(join(root, 'work'), first.workspaceRootAbs), join('storefront', 'developer-agent', 'operation-0001'));
  assert.equal(relative(join(root, 'work'), second.workspaceRootAbs), join('storefront', 'developer-agent', 'operation-0002'));
  assert.equal(first.worktreePathAbs, join(first.workspaceRootAbs, 'repo'));
});

test('legacy cleanup deletes empty workspaces and retains only the newest repeated workspace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-cleanup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work'); mkdirSync(work);
  for (const name of ['todo-requirements', 'todo-requirements-2']) mkdirSync(join(work, name));
  for (const name of ['run-tests', 'run-tests-2']) {
    mkdirSync(join(work, name, '.orchestrator'), { recursive: true });
    mkdirSync(join(work, name, 'input'), { recursive: true });
    mkdirSync(join(work, name, 'logs'), { recursive: true });
    mkdirSync(join(work, name, 'output'), { recursive: true });
    writeFileSync(join(work, name, 'output', 'result.json'), name);
  }
  mkdirSync(join(work, 'run-tests-3', '.orchestrator'), { recursive: true });
  mkdirSync(join(work, 'run-tests-3', 'input'), { recursive: true });
  const newest = join(work, 'run-tests-2');
  const older = join(work, 'run-tests');
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  const newTime = new Date('2021-01-01T00:00:00.000Z');
  utimesSync(older, oldTime, oldTime);
  utimesSync(newest, newTime, newTime);
  utimesSync(join(work, 'run-tests-3'), oldTime, oldTime);
  mkdirSync(join(work, 'project', 'developer-agent', 'operation-0001'), { recursive: true });

  const report = cleanLegacyWorkspaces({ projectRoot: root, apply: true });

  assert.deepEqual(report.deleted.map((path) => basename(path)).sort(), ['run-tests', 'run-tests-3', 'todo-requirements', 'todo-requirements-2']);
  assert.deepEqual(report.retained.map((path) => basename(path)), ['run-tests-2']);
  assert.equal(existsSync(newest), true);
  assert.equal(existsSync(join(work, 'project', 'developer-agent', 'operation-0001')), true);
});

test('workspace paths safely normalize project and Agent fallbacks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const fallback = manager.reserve({ targetProjectRootAbs: 'C:/<>:"/\\|?*', agentId: ' /<>:"\\|?* ' });
  const longAgent = manager.reserve({ targetProjectRootAbs: 'C:/Projects/App', agentId: 'a'.repeat(200) });

  assert.equal(relative(join(root, 'work'), fallback.workspaceRootAbs), join('project', 'unassigned-agent', 'operation-0001'));
  assert.ok(basename(dirname(longAgent.workspaceRootAbs)).length <= 48);
  assert.doesNotMatch(basename(dirname(longAgent.workspaceRootAbs)), /[<>:"/\\|?*]/u);
});

test('restore paths remain inside the readable work root', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const path = manager.restorePathFor('SNP-accepted');

  assert.equal(inside(join(root, 'work'), path), true);
  assert.equal(path.includes(`${join('runtime', 'restores')}`), false);
  assert.match(basename(path), /^restore-snapshot(?:-\d+)?$/u);
});
