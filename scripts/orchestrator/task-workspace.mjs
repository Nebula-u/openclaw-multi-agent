import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_DIRECTORY_NAME_LENGTH = 72;

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function readableName(value, fallback, maxLength = MAX_DIRECTORY_NAME_LENGTH) {
  const name = String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return (name || fallback).slice(0, maxLength).replace(/-+$/u, '') || fallback;
}

function canonicalWorkRoot(projectRoot) {
  const expected = join(resolve(projectRoot), 'work');
  mkdirSync(expected, { recursive: true });
  const root = realpathSync.native(expected);
  if (!inside(resolve(projectRoot), root)) throw Object.assign(new Error('work root escapes project root'), { code: 'TASK_WORKSPACE_ROOT_ESCAPE' });
  return root;
}

function nextAvailable(root, base) {
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const candidate = join(root, name);
    if (!inside(root, candidate)) throw Object.assign(new Error('workspace path escapes work root'), { code: 'TASK_WORKSPACE_ESCAPE' });
    if (!existsSync(candidate)) return candidate;
  }
}

function legacyGroupName(name) {
  const match = /^(.*)-\d+$/u.exec(name);
  return match?.[1] || name;
}

function isSafeDirectory(path) {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function hasLegacyWorkspace(path) {
  if (isSafeDirectory(join(path, 'repo'))) return true;
  return isSafeDirectory(join(path, 'input')) && isSafeDirectory(join(path, '.orchestrator'));
}

export function cleanLegacyWorkspaces({ projectRoot: projectRootInput, apply = false } = {}) {
  const workspaceRoot = canonicalWorkRoot(projectRootInput ?? process.cwd());
  const candidates = [];
  const retained = [];
  const skipped = [];
  const groups = new Map();
  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.name === 'restores') { skipped.push(join(workspaceRoot, entry.name)); continue; }
    const path = join(workspaceRoot, entry.name);
    if (!inside(workspaceRoot, path) || !entry.isDirectory() || entry.isSymbolicLink() || !isSafeDirectory(path)) {
      skipped.push(path); continue;
    }
    if (readdirSync(path).length === 0) { candidates.push(path); continue; }
    if (!hasLegacyWorkspace(path)) { skipped.push(path); continue; }
    const group = legacyGroupName(entry.name);
    const values = groups.get(group) ?? [];
    values.push(path); groups.set(group, values);
  }
  for (const paths of groups.values()) {
    paths.sort((left, right) => {
      const modified = statSync(right).mtimeMs - statSync(left).mtimeMs;
      return modified || right.localeCompare(left);
    });
    retained.push(paths[0]);
    candidates.push(...paths.slice(1));
  }
  candidates.sort((left, right) => left.localeCompare(right));
  retained.sort((left, right) => left.localeCompare(right));
  if (!apply) return { workspace_root_abs: workspaceRoot, apply: false, candidates, retained, skipped };
  const deleted = [];
  for (const path of candidates) {
    if (!inside(workspaceRoot, path) || !isSafeDirectory(path)) {
      throw Object.assign(new Error('legacy cleanup target must be a non-symlink directory inside work'), { code: 'TASK_WORKSPACE_CLEANUP_UNSAFE' });
    }
    rmSync(path, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
    deleted.push(path);
  }
  return { workspace_root_abs: workspaceRoot, apply: true, deleted, retained, skipped };
}

export function createTaskWorkspaceManager({ projectRoot: projectRootInput } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const workspaceRoot = canonicalWorkRoot(projectRoot);

  function reserve(task = {}) {
    const projectName = readableName(basename(resolve(task.targetProjectRootAbs ?? '')), 'project', 28);
    const agentName = readableName(task.agentId, 'unassigned-agent', 48);
    const agentRoot = join(workspaceRoot, projectName, agentName);
    if (!inside(workspaceRoot, agentRoot)) throw Object.assign(new Error('workspace path escapes work root'), { code: 'TASK_WORKSPACE_ESCAPE' });
    mkdirSync(agentRoot, { recursive: true });
    for (let operation = 1; ; operation += 1) {
      const candidate = join(agentRoot, `operation-${String(operation).padStart(4, '0')}`);
      if (!inside(workspaceRoot, candidate)) throw Object.assign(new Error('workspace path escapes work root'), { code: 'TASK_WORKSPACE_ESCAPE' });
      try {
        mkdirSync(candidate);
        const workspaceRootAbs = realpathSync.native(candidate);
        if (!inside(workspaceRoot, workspaceRootAbs)) throw Object.assign(new Error('workspace path escapes work root'), { code: 'TASK_WORKSPACE_ESCAPE' });
        return { workspaceRootAbs, worktreePathAbs: join(workspaceRootAbs, 'repo') };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }

  function restorePathFor() {
    const restoresRoot = join(workspaceRoot, 'restores');
    mkdirSync(restoresRoot, { recursive: true });
    return nextAvailable(restoresRoot, 'restore-snapshot');
  }

  function release(workspaceRootAbs) {
    const workspace = resolve(workspaceRootAbs);
    if (workspace === workspaceRoot || !inside(workspaceRoot, workspace)) {
      throw Object.assign(new Error('workspace cleanup target escapes work root'), { code: 'TASK_WORKSPACE_CLEANUP_ESCAPE' });
    }
    if (!existsSync(workspace)) return true;
    const rootStat = lstatSync(workspace);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw Object.assign(new Error('workspace cleanup target must be a non-symlink directory'), { code: 'TASK_WORKSPACE_CLEANUP_UNSAFE' });
    }
    const worktree = join(workspace, 'repo');
    if (existsSync(worktree)) {
      const worktreeStat = lstatSync(worktree);
      if (worktreeStat.isDirectory() && !worktreeStat.isSymbolicLink() && readdirSync(worktree).length === 0) rmdirSync(worktree);
    }
    if (existsSync(workspace) && readdirSync(workspace).length === 0) rmdirSync(workspace);
    const agentRoot = dirname(workspace);
    if (agentRoot !== workspaceRoot && existsSync(agentRoot) && isSafeDirectory(agentRoot) && readdirSync(agentRoot).length === 0) rmdirSync(agentRoot);
    const projectRoot = dirname(agentRoot);
    if (projectRoot !== workspaceRoot && existsSync(projectRoot) && isSafeDirectory(projectRoot) && readdirSync(projectRoot).length === 0) rmdirSync(projectRoot);
    return !existsSync(workspace);
  }

  return { workspaceRoot, reserve, release, restorePathFor };
}
