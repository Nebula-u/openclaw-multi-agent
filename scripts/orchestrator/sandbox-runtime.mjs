import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const TEST_SANDBOX_ISOLATION_MODE = 'SANDBOXED_DOCKER';
export const TEST_SANDBOX_POLICY_RELATIVE_PATH = join('config', 'test-sandbox-policy.json');

const REQUIRED_MOUNT_KEYS = ['worktree', 'input', 'agent_raw', 'raw_logs'];
const CONTAINER_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export class SandboxRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SandboxRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SandboxRuntimeError(code, message, details);
}

function canonicalExistingPath(path, label) {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    fail('SANDBOX_PATH_NOT_ABSOLUTE', `${label} must be an absolute path`, { path });
  }
  const absolute = resolve(path);
  if (!existsSync(absolute)) fail('SANDBOX_PATH_MISSING', `${label} does not exist`, { path: absolute });
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    fail('SANDBOX_PATH_CANONICALIZE_FAILED', `cannot canonicalize ${label}`, { path: absolute, error: error.message });
  }
}

function isWithinPath(path, root) {
  const child = resolve(path);
  const parent = resolve(root).replace(/[\\/]$/u, '');
  const childRelative = relative(parent, child);
  return childRelative === '' || (childRelative !== '..' && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative));
}

function assertNoReparsePoint(path, label) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail('SANDBOX_REPARSE_POINT', `${label} must not be a symbolic link`, { path });
  if (process.platform === 'win32' && (stat.attributes & 0x400) !== 0) {
    fail('SANDBOX_REPARSE_POINT', `${label} must not be a junction or reparse point`, { path });
  }
}

function assertMountPath(path, root, label) {
  const canonicalPath = canonicalExistingPath(path, label);
  const canonicalRoot = canonicalExistingPath(root, `${label} root`);
  if (!isWithinPath(canonicalPath, canonicalRoot)) {
    fail('SANDBOX_PATH_ESCAPE', `${label} escapes its allowed root`, { path: canonicalPath, root: canonicalRoot });
  }
  assertNoReparsePoint(resolve(path), label);
  return canonicalPath;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function loadTestSandboxPolicy(projectRootInput) {
  const projectRoot = resolve(projectRootInput);
  const policyPath = join(projectRoot, TEST_SANDBOX_POLICY_RELATIVE_PATH);
  if (!existsSync(policyPath)) fail('SANDBOX_POLICY_MISSING', `test sandbox policy does not exist: ${policyPath}`);
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch (error) {
    fail('SANDBOX_POLICY_INVALID_JSON', `test sandbox policy is not valid JSON: ${policyPath}`, { error: error.message });
  }
  assertTestSandboxPolicy(policy);
  return { policy: clone(policy), policyPath };
}

export function assertTestSandboxPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('SANDBOX_POLICY_INVALID', 'test sandbox policy must be an object');
  const expected = {
    required: true,
    fail_closed: true,
    isolation_mode: TEST_SANDBOX_ISOLATION_MODE,
    agent_id: 'test-agent',
    mode: 'all',
    backend: 'docker',
    scope: 'session',
    workspace_access: 'none',
    exec_host: 'sandbox',
    elevated_enabled: false,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (policy[key] !== value) fail('SANDBOX_POLICY_WEAK', `test sandbox policy must set ${key}=${JSON.stringify(value)}`, { actual: policy[key] });
  }
  if (policy.enabled !== true) fail('SANDBOX_POLICY_DISABLED', 'test sandbox policy is disabled');
  const docker = policy.docker;
  if (!docker || typeof docker !== 'object' || docker.image !== 'openclaw-test-node:22-slim'
    || docker.network !== 'none' || docker.read_only_root !== true || docker.pids_limit !== 256
    || docker.memory !== '2g' || docker.cpus !== 2 || JSON.stringify(docker.cap_drop) !== JSON.stringify(['ALL'])) {
    fail('SANDBOX_POLICY_WEAK', 'test sandbox Docker limits do not match the required baseline', { docker });
  }
  if (!policy.mounts || typeof policy.mounts !== 'object') fail('SANDBOX_POLICY_INVALID', 'test sandbox policy must define mounts');
  for (const key of REQUIRED_MOUNT_KEYS) {
    const mount = policy.mounts[key];
    if (!mount || !CONTAINER_PATH_PATTERN.test(mount.container_path) || !['ro', 'rw'].includes(mount.mode)) {
      fail('SANDBOX_POLICY_INVALID', `invalid test sandbox mount: ${key}`, { mount });
    }
  }
  if (policy.mounts.input.mode !== 'ro') fail('SANDBOX_POLICY_WEAK', 'sandbox input mount must be read-only');
  if (new Set(REQUIRED_MOUNT_KEYS.map((key) => policy.mounts[key].container_path)).size !== REQUIRED_MOUNT_KEYS.length) {
    fail('SANDBOX_POLICY_INVALID', 'sandbox mount container paths must be unique');
  }
  return true;
}

export function createSandboxMountPlan({ task, policy, runtimeRootAbs }) {
  assertTestSandboxPolicy(policy);
  if (!task || task.assigned_agent !== 'test-agent') fail('SANDBOX_AGENT_MISMATCH', 'sandbox mount plan is only valid for test-agent tasks');
  const runtimeRoot = canonicalExistingPath(runtimeRootAbs, 'runtime root');
  const worktree = assertMountPath(task.worktree_path_abs, join(runtimeRoot, 'worktrees'), 'test worktree');
  const artifact = assertMountPath(task.artifact_root_abs, join(runtimeRoot, 'artifacts'), 'test artifact root');
  const input = assertMountPath(join(artifact, 'input'), artifact, 'test input directory');
  const agentRaw = assertMountPath(join(artifact, '.agent-raw'), artifact, 'test agent raw directory');
  const rawLogs = assertMountPath(join(artifact, 'raw-logs'), artifact, 'test raw logs directory');
  const mounts = [
    { name: 'worktree', host_path_abs: worktree, container_path: policy.mounts.worktree.container_path, mode: policy.mounts.worktree.mode },
    { name: 'input', host_path_abs: input, container_path: policy.mounts.input.container_path, mode: policy.mounts.input.mode },
    { name: 'agent_raw', host_path_abs: agentRaw, container_path: policy.mounts.agent_raw.container_path, mode: policy.mounts.agent_raw.mode },
    { name: 'raw_logs', host_path_abs: rawLogs, container_path: policy.mounts.raw_logs.container_path, mode: policy.mounts.raw_logs.mode },
  ];
  return {
    schema_version: 1,
    isolation_mode: TEST_SANDBOX_ISOLATION_MODE,
    backend: policy.backend,
    scope: policy.scope,
    network: policy.docker.network,
    host_paths: { worktree, artifact_root: artifact, input, agent_raw: agentRaw, raw_logs: rawLogs },
    container_paths: Object.fromEntries(mounts.map((mount) => [mount.name, mount.container_path])),
    mounts,
  };
}

export function createSandboxAttestation({ policy, mountPlan, runtimeId, containerId, imageDigest, hostExecution = false, verifiedAt = new Date().toISOString() }) {
  assertTestSandboxPolicy(policy);
  if (!mountPlan || mountPlan.isolation_mode !== TEST_SANDBOX_ISOLATION_MODE) fail('SANDBOX_MOUNT_PLAN_INVALID', 'sandbox attestation requires a valid mount plan');
  if (!runtimeId || !containerId || !imageDigest) fail('SANDBOX_ATTESTATION_INCOMPLETE', 'sandbox attestation requires runtime, container and image identities');
  if (hostExecution !== false) fail('SANDBOX_HOST_EXECUTION', 'sandbox attestation cannot claim host execution');
  return {
    schema_version: 1,
    provider: 'openclaw',
    backend: policy.backend,
    mode: policy.mode,
    scope: policy.scope,
    runtime_id: String(runtimeId),
    container_id: String(containerId),
    image: policy.docker.image,
    image_digest: String(imageDigest),
    network: policy.docker.network,
    workspace_access: policy.workspace_access,
    read_only_root: policy.docker.read_only_root,
    cap_drop: [...policy.docker.cap_drop],
    mounts: mountPlan.mounts.map((mount) => ({ container_path: mount.container_path, mode: mount.mode })),
    host_execution: false,
    verified_at: verifiedAt,
  };
}

export function assertSandboxAttestation(attestation, mountPlan) {
  if (!attestation || attestation.provider !== 'openclaw' || attestation.backend !== 'docker'
    || attestation.mode !== 'all' || attestation.scope !== 'session' || attestation.network !== 'none'
    || attestation.workspace_access !== 'none' || attestation.read_only_root !== true
    || JSON.stringify(attestation.cap_drop) !== JSON.stringify(['ALL']) || attestation.host_execution !== false) {
    fail('SANDBOX_ATTESTATION_WEAK', 'sandbox attestation does not prove the required Docker boundary', { attestation });
  }
  if (mountPlan) {
    const expected = mountPlan.mounts.map((mount) => `${mount.container_path}:${mount.mode}`).sort();
    const actual = (attestation.mounts ?? []).map((mount) => `${mount.container_path}:${mount.mode}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('SANDBOX_MOUNTS_MISMATCH', 'sandbox attestation mounts do not match the task mount plan', { expected, actual });
  }
  return true;
}

export function sandboxPolicyDigest(policy) {
  return createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex');
}
