import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { createTaskWorkspaceManager } from '../scripts/orchestrator/task-workspace.mjs';

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (value !== '..' && !value.startsWith('../'));
}

test('workspace names are readable and collisions receive short suffixes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const first = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', title: '新增 登录功能！' });
  const second = manager.reserve({ targetProjectRootAbs: 'C:/Projects/Storefront', title: '新增 登录功能！' });

  assert.equal(basename(first.workspaceRootAbs), 'storefront-新增-登录功能');
  assert.equal(basename(second.workspaceRootAbs), 'storefront-新增-登录功能-2');
  assert.equal(first.worktreePathAbs, join(first.workspaceRootAbs, 'repo'));
  assert.equal(existsSync(first.workspaceRootAbs), true);
  assert.equal(inside(join(root, 'work'), first.workspaceRootAbs), true);
});

test('workspace names safely normalize fallbacks, invalid characters and length', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'task-workspace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createTaskWorkspaceManager({ projectRoot: root });

  const fallback = manager.reserve({ targetProjectRootAbs: 'C:/<>:"/\\|?*', title: ' /<>:"\\|?* ' });
  const longTitle = manager.reserve({ targetProjectRootAbs: 'C:/Projects/App', title: 'a'.repeat(200) });

  assert.equal(basename(fallback.workspaceRootAbs), 'project-untitled-task');
  assert.ok(basename(longTitle.workspaceRootAbs).length <= 72);
  assert.doesNotMatch(basename(longTitle.workspaceRootAbs), /[<>:"/\\|?*]/u);
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
