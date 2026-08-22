import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const WORKFLOW = /^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u;
const PROJECT_REF = /^PRJ-[A-Za-z0-9][A-Za-z0-9-]*$/u;

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function inside(root, value) {
  const result = relative(resolve(root), resolve(value));
  return result === '' || (result !== '..' && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}
function slug(value) {
  const result = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  if (!result || result.length > 48) fail('MANAGER_PROJECT_NAME_INVALID', 'project name must produce a 1-48 character slug');
  return result;
}
function safeDetails(value) {
  return JSON.parse(JSON.stringify(value, (key, entry) => key.toLowerCase().includes('token') || key.toLowerCase().includes('password') ? '[redacted]' : entry));
}

export function createManagerControl({ projectRoot: projectRootInput, allowedGitHosts = null, runGit = null, clock = () => new Date() } = {}) {
  if (!projectRootInput) throw new TypeError('projectRoot is required');
  const projectRoot = resolve(projectRootInput);
  const projectsRoot = join(projectRoot, 'runtime', 'projects');
  const stateRoot = join(projectRoot, 'runtime', 'manager-control');
  const registryPath = join(stateRoot, 'projects.json');
  const auditPath = join(stateRoot, 'audit.jsonl');
  const policyPath = join(projectRoot, 'config', 'manager-control-policy.json');
  const configuredHosts = allowedGitHosts ?? (existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, 'utf8')).allowed_git_hosts ?? [] : []);
  if (!Array.isArray(configuredHosts)) fail('MANAGER_GIT_HOST_POLICY_INVALID', 'allowed_git_hosts must be an array');
  const allowedHosts = new Set(configuredHosts.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const invoke = runGit ?? ((cwd, args) => spawnSync('git', ['-C', cwd, ...args], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 30_000 }));

  function git(cwd, args, action) {
    const result = invoke(cwd, args);
    if (result.error || result.status !== 0) fail('MANAGER_GIT_FAILED', `${action} failed`, { status: result.status ?? null, stderr: String(result.stderr ?? '').trim() });
    return String(result.stdout ?? '').trim();
  }
  function readRegistry() {
    if (!existsSync(registryPath)) return { schema_version: 1, projects: {} };
    const value = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (value?.schema_version !== 1 || !value.projects || Array.isArray(value.projects)) fail('MANAGER_PROJECT_REGISTRY_INVALID', 'project registry has an unsupported shape');
    return value;
  }
  function writeRegistry(value) { atomicWriteJson(registryPath, value); }
  function audit(action, result, details) {
    mkdirSync(stateRoot, { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify({ schema_version: 1, operation_id: `MOP-${randomUUID()}`, occurred_at: clock().toISOString(), action, result, details: safeDetails(details) })}\n`, 'utf8');
  }
  function inspect(root) {
    if (!existsSync(root)) fail('MANAGER_PROJECT_NOT_FOUND', 'managed project does not exist');
    const canonical = realpathSync.native(resolve(root));
    if (!inside(projectsRoot, canonical) || lstatSync(canonical).isSymbolicLink()) fail('MANAGER_PROJECT_PATH_UNSAFE', 'project root escapes the managed project directory');
    const top = realpathSync.native(resolve(git(canonical, ['rev-parse', '--show-toplevel'], 'resolve project repository')));
    if (top.toLowerCase() !== canonical.toLowerCase()) fail('MANAGER_PROJECT_NOT_ROOT', 'managed project must be a Git repository root');
    const headCommit = git(canonical, ['rev-parse', '--verify', 'HEAD^{commit}'], 'resolve project HEAD');
    if (!SHA.test(headCommit)) fail('MANAGER_PROJECT_HEAD_INVALID', 'managed project HEAD is not a full commit SHA');
    return { projectRootAbs: canonical, headCommit };
  }
  function pathFor(workflowId, name) {
    if (!WORKFLOW.test(workflowId ?? '')) fail('MANAGER_WORKFLOW_ID_INVALID', 'workflow ID is invalid');
    const expected = join(projectsRoot, `${workflowId.toLowerCase()}-${slug(name)}`);
    if (!inside(projectsRoot, expected)) fail('MANAGER_PROJECT_PATH_UNSAFE', 'managed project path escapes project root');
    return expected;
  }
  function validateRemote(raw) {
    let remote;
    try { remote = new URL(raw); } catch { fail('MANAGER_REMOTE_INVALID', 'remote URL must be a valid HTTPS or SSH URL'); }
    if (!['https:', 'ssh:'].includes(remote.protocol)) fail('MANAGER_REMOTE_PROTOCOL_DENIED', 'only HTTPS and SSH Git remotes are allowed');
    if (remote.username || remote.password) fail('MANAGER_REMOTE_CREDENTIALS_DENIED', 'remote URL must not embed credentials');
    const host = remote.hostname.toLowerCase();
    if (!allowedHosts.has(host)) fail('MANAGER_GIT_HOST_DENIED', 'remote Git host is not allowed', { host });
    return { remoteUrl: remote.toString(), host };
  }
  function register({ workflowId, name, mode, projectRootAbs, remote = null }) {
    const inspected = inspect(projectRootAbs);
    const registry = readRegistry();
    const projectRef = `PRJ-${createHash('sha256').update(`${workflowId}:${inspected.projectRootAbs}`).digest('hex').slice(0, 20)}`;
    registry.projects[projectRef] = { project_ref: projectRef, workflow_id: workflowId, name: slug(name), mode, project_root_abs: inspected.projectRootAbs,
      remote, head_commit: inspected.headCommit, registered_at: clock().toISOString() };
    writeRegistry(registry);
    return { projectRef, ...inspected, remote };
  }
  function ensureProject({ workflowId, project }) {
    const mode = project?.mode;
    const expected = pathFor(workflowId, project?.name);
    if (existsSync(expected)) fail('MANAGER_PROJECT_EXISTS', 'managed project path already exists', { project_name: project?.name });
    mkdirSync(projectsRoot, { recursive: true });
    if (mode === 'new') {
      mkdirSync(expected, { recursive: false });
      git(expected, ['init', '--initial-branch=main'], 'initialize managed project');
      git(expected, ['-c', 'user.name=OpenClaw Manager', '-c', 'user.email=openclaw-manager@invalid', 'commit', '--allow-empty', '-m', 'chore: initialize managed project'], 'create initial managed project commit');
      const registered = register({ workflowId, name: project.name, mode, projectRootAbs: expected });
      audit('project.ensure', 'SUCCEEDED', { workflow_id: workflowId, project_ref: registered.projectRef, mode, project_root_abs: registered.projectRootAbs });
      return registered;
    }
    if (mode === 'remote') {
      const remote = validateRemote(project.remote_url);
      git(projectsRoot, ['clone', '--no-recurse-submodules', remote.remoteUrl, expected], 'clone managed project');
      const registered = register({ workflowId, name: project.name, mode, projectRootAbs: expected, remote: remote.remoteUrl });
      audit('project.ensure', 'SUCCEEDED', { workflow_id: workflowId, project_ref: registered.projectRef, mode, remote_host: remote.host, project_root_abs: registered.projectRootAbs });
      return registered;
    }
    fail('MANAGER_PROJECT_MODE_INVALID', 'project mode must be new or remote');
  }
  function resolveProject(projectRef) {
    if (!PROJECT_REF.test(projectRef ?? '')) fail('MANAGER_PROJECT_REF_INVALID', 'project reference is invalid');
    const entry = readRegistry().projects[projectRef];
    if (!entry) fail('MANAGER_PROJECT_REF_UNKNOWN', 'project reference is not registered');
    const inspected = inspect(entry.project_root_abs);
    return { projectRef, ...inspected, remote: entry.remote ?? null };
  }
  function fetchProject(projectRef) {
    const project = resolveProject(projectRef);
    if (!project.remote) fail('MANAGER_REMOTE_NOT_CONFIGURED', 'managed project has no registered remote');
    validateRemote(project.remote);
    git(project.projectRootAbs, ['fetch', '--prune', 'origin'], 'fetch registered remote');
    const resolved = resolveProject(projectRef); audit('project.fetch', 'SUCCEEDED', { project_ref: projectRef, project_root_abs: resolved.projectRootAbs });
    return resolved;
  }
  return { ensureProject, resolveProject, fetchProject, projectsRoot, registryPath, auditPath };
}
