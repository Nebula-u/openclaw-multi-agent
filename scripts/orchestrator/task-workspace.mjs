import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

export function createTaskWorkspaceManager({ projectRoot: projectRootInput } = {}) {
  const projectRoot = resolve(projectRootInput ?? process.cwd());
  const workspaceRoot = canonicalWorkRoot(projectRoot);

  function reserve(task = {}) {
    const projectName = readableName(basename(resolve(task.targetProjectRootAbs ?? '')), 'project', 28);
    const summary = readableName(task.title, 'untitled-task', MAX_DIRECTORY_NAME_LENGTH - projectName.length - 1);
    const base = `${projectName}-${summary}`;
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? base : `${base}-${suffix}`;
      const candidate = join(workspaceRoot, name);
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

  return { workspaceRoot, reserve, restorePathFor };
}
