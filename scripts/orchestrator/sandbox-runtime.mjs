import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { openClawSpawnSpec, terminateProcessTree } from './process-utils.mjs';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';

export const TEST_SANDBOX_ISOLATION_MODE = 'SANDBOXED_DOCKER';
export const TEST_SANDBOX_POLICY_RELATIVE_PATH = join('config', 'test-sandbox-policy.json');
export const TEST_SANDBOX_CONTAINER_USER = '10001:10001';

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
    || docker.workdir !== '/workspace' || docker.user !== TEST_SANDBOX_CONTAINER_USER || docker.network !== 'none'
    || docker.read_only_root !== true || docker.pids_limit !== 256
    || docker.memory !== '2g' || docker.cpus !== 2 || docker.dangerously_allow_external_bind_sources !== true
    || docker.dangerously_allow_reserved_container_targets !== false || JSON.stringify(docker.cap_drop) !== JSON.stringify(['ALL'])) {
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
  mkdirSync(join(artifact, 'raw-logs'), { recursive: true });
  mkdirSync(join(artifact, '.agent-raw'), { recursive: true });
  mkdirSync(join(artifact, 'input'), { recursive: true });
  stageSandboxInputs(task, artifact);
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

function stageSandboxInputs(task, artifact) {
  const inputRoot = join(artifact, 'input');
  if (!task.context_manifest_path_abs || !existsSync(task.context_manifest_path_abs)) {
    fail('SANDBOX_INPUT_MANIFEST_MISSING', 'test-agent task context manifest is unavailable');
  }
  assertNoReparsePoint(task.context_manifest_path_abs, 'test context manifest');
  let manifest;
  try { manifest = JSON.parse(readFileSync(task.context_manifest_path_abs, 'utf8')); }
  catch (error) { fail('SANDBOX_INPUT_MANIFEST_INVALID', 'test-agent context manifest is not valid JSON', { error: error.message }); }
  if (!Array.isArray(manifest.input_files)) fail('SANDBOX_INPUT_MANIFEST_INVALID', 'test-agent context manifest input_files is not an array');
  const filesRoot = join(inputRoot, 'files');
  mkdirSync(filesRoot, { recursive: true });
  const stagedInputs = [];
  for (const [index, inputFile] of manifest.input_files.entries()) {
    if (typeof inputFile?.path_abs !== 'string' || !isAbsolute(inputFile.path_abs) || !existsSync(inputFile.path_abs)) {
      fail('SANDBOX_INPUT_FILE_MISSING', 'declared test-agent input file is missing', { input: inputFile });
    }
    assertNoReparsePoint(inputFile.path_abs, 'test input file');
    const inputDigest = createHash('sha256').update(readFileSync(inputFile.path_abs)).digest('hex');
    if (inputDigest !== inputFile.sha256) {
      fail('SANDBOX_INPUT_HASH_MISMATCH', 'declared test-agent input file hash does not match the context manifest', {
        path_abs: inputFile.path_abs, expected: inputFile.sha256, actual: inputDigest,
      });
    }
    const target = join(filesRoot, `${String(index + 1).padStart(2, '0')}-${basename(inputFile.path_abs)}`);
    copyFileSync(inputFile.path_abs, target);
    stagedInputs.push({ ...inputFile, path_abs: `/input/files/${basename(target)}` });
  }
  const sandboxManifest = {
    ...manifest,
    target_project_root_abs: '/worktree',
    worktree_path_abs: '/worktree',
    artifact_root_abs: '/agent-raw',
    input_files: stagedInputs,
    host_path_metadata: {
      target_project_root_abs: manifest.target_project_root_abs,
      worktree_path_abs: manifest.worktree_path_abs,
      artifact_root_abs: manifest.artifact_root_abs,
      input_files: manifest.input_files.map((inputFile) => ({ path_abs: inputFile.path_abs, role: inputFile.role ?? null })),
    },
  };
  atomicWriteJson(join(inputRoot, 'context-manifest.json'), sandboxManifest);
  atomicWriteJson(join(inputRoot, 'task.json'), {
    ...task,
    target_project_root_abs: '/worktree',
    worktree_path_abs: '/worktree',
    artifact_root_abs: '/agent-raw',
    context_manifest_path_abs: '/input/context-manifest.json',
    allowed_write_paths_abs: ['/worktree'],
    forbidden_paths_abs: ['/input', '/raw-logs'],
    host_task_metadata: {
      target_project_root_abs: task.target_project_root_abs ?? task.worktree_path_abs,
      worktree_path_abs: task.worktree_path_abs,
      artifact_root_abs: task.artifact_root_abs,
      context_manifest_path_abs: task.context_manifest_path_abs,
    },
  });
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
    workdir: policy.docker.workdir,
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

function windowsCommandLine(executable, args) {
  const values = [executable, ...args].map((value) => {
    const text = String(value);
    if (text.includes('"') || /[\r\n]/u.test(text)) fail('SANDBOX_COMMAND_INVALID', 'sandbox control command contains unsafe characters');
    return `"${text}"`;
  });
  return `"${values.join(' ')}"`;
}

function commandSpec(executable, args) {
  if (executable === 'openclaw' && process.platform === 'win32') {
    const candidates = [
      process.env.OPENCLAW_NODE_ENTRY,
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs') : null,
    ].filter(Boolean);
    const entry = candidates.find((candidate) => existsSync(candidate));
    if (entry) return { file: process.execPath, args: [entry, ...args], options: { shell: false } };
  }
  if (executable === 'openclaw') return openClawSpawnSpec(args);
  if (process.platform !== 'win32') return { file: executable, args, options: { shell: false } };
  const file = process.env.ComSpec || 'cmd.exe';
  return { file, args: ['/d', '/s', '/c', windowsCommandLine(executable, args)], options: { shell: false, windowsVerbatimArguments: true } };
}

export function runSandboxCommand(executable, args, { timeoutMs = 15000, runner = null } = {}) {
  if (runner) return runner({ executable, args, timeoutMs });
  const spec = commandSpec(executable, args);
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try { child = spawn(spec.file, spec.args, { ...spec.options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { rejectRun(new SandboxRuntimeError('SANDBOX_COMMAND_START_FAILED', error.message)); return; }
    let stdout = ''; let stderr = ''; let timedOut = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => { timedOut = true; terminateProcessTree(child.pid); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timeout); rejectRun(new SandboxRuntimeError('SANDBOX_COMMAND_FAILED', error.message, { executable, args })); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      if (timedOut) { rejectRun(new SandboxRuntimeError('SANDBOX_COMMAND_TIMEOUT', `${executable} command timed out`, { executable, args, stdout, stderr })); return; }
      resolveRun({ exit_code: exitCode, signal, stdout, stderr });
    });
  });
}

function parseJsonCommandResult(result, commandName) {
  if (result.exit_code !== 0) fail('SANDBOX_COMMAND_FAILED', `${commandName} failed`, { ...result });
  try { return JSON.parse(result.stdout); }
  catch (error) { fail('SANDBOX_COMMAND_INVALID_JSON', `${commandName} returned invalid JSON`, { error: error.message, stdout: result.stdout, stderr: result.stderr }); }
}

function configAgent(value) {
  const list = Array.isArray(value) ? value : value?.agents?.list;
  if (!Array.isArray(list)) fail('SANDBOX_CONFIG_INVALID', 'OpenClaw agents.list response is not an array');
  const index = list.findIndex((agent) => agent?.id === 'test-agent');
  if (index < 0) fail('SANDBOX_AGENT_MISSING', 'OpenClaw config does not contain test-agent');
  return { index, agent: list[index] };
}

function assertEffectiveAgentConfig(agent, policy) {
  const sandbox = agent.sandbox ?? {};
  const docker = sandbox.docker ?? {};
  const expected = [
    ['sandbox.mode', sandbox.mode, policy.mode], ['sandbox.backend', sandbox.backend, policy.backend],
    ['sandbox.scope', sandbox.scope, policy.scope], ['sandbox.workspaceAccess', sandbox.workspaceAccess, policy.workspace_access],
    ['sandbox.docker.image', docker.image, policy.docker.image], ['sandbox.docker.workdir', docker.workdir, policy.docker.workdir],
    ['sandbox.docker.user', docker.user, policy.docker.user],
    ['sandbox.docker.network', docker.network, policy.docker.network], ['sandbox.docker.readOnlyRoot', docker.readOnlyRoot, policy.docker.read_only_root],
    ['sandbox.docker.pidsLimit', docker.pidsLimit, policy.docker.pids_limit], ['sandbox.docker.memory', docker.memory, policy.docker.memory],
    ['sandbox.docker.cpus', docker.cpus, policy.docker.cpus],
  ];
  for (const [name, actual, wanted] of expected) if (actual !== wanted) fail('SANDBOX_CONFIG_WEAK', `${name} is not the required value`, { actual, wanted });
  if (JSON.stringify(docker.capDrop ?? []) !== JSON.stringify(policy.docker.cap_drop)) fail('SANDBOX_CONFIG_WEAK', 'sandbox.docker.capDrop is not ALL');
  if (docker.dangerouslyAllowExternalBindSources !== true) fail('SANDBOX_CONFIG_WEAK', 'external bind sources are not explicitly enabled for the controlled runtime mount');
  if (docker.dangerouslyAllowReservedContainerTargets !== false) fail('SANDBOX_CONFIG_WEAK', 'reserved container targets must remain blocked');
  if (agent.tools?.exec?.host !== policy.exec_host || agent.tools?.elevated?.enabled !== false) fail('SANDBOX_CONFIG_WEAK', 'test-agent tools permit a non-sandbox or elevated execution path');
}

function bindSpec(mount) {
  return `${mount.host_path_abs.replaceAll('\\', '/')}:${mount.container_path}:${mount.mode}`;
}

function parseCommandJson(result, commandName) { return parseJsonCommandResult(result, commandName); }

export async function prepareTestSandboxSession({ projectRootInput, task, sessionId, sessionKey, runtimeRootAbs, commandRunner = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const { policy, policyPath } = loadTestSandboxPolicy(projectRoot);
  const mountPlan = createSandboxMountPlan({ task, policy, runtimeRootAbs });
  const runner = (executable, args, options = {}) => runSandboxCommand(executable, args, { ...options, runner: commandRunner });
  const configResult = await runner('openclaw', ['config', 'get', 'agents.list', '--json']);
  const { index, agent } = configAgent(parseCommandJson(configResult, 'openclaw config get agents.list'));
  assertEffectiveAgentConfig(agent, policy);
  const previousBinds = [...(agent.sandbox?.docker?.binds ?? [])];
  const desiredBinds = mountPlan.mounts.map(bindSpec);
  const setArgs = ['config', 'set', `agents.list[${index}].sandbox.docker.binds`, JSON.stringify(desiredBinds), '--strict-json', '--dry-run'];
  const dryRun = await runner('openclaw', setArgs);
  if (dryRun.exit_code !== 0) fail('SANDBOX_CONFIG_PATCH_REJECTED', 'OpenClaw rejected the dynamic sandbox bind plan', { stdout: dryRun.stdout, stderr: dryRun.stderr });
  let applied = false;
  try {
    const writeResult = await runner('openclaw', setArgs.slice(0, -1));
    if (writeResult.exit_code !== 0) fail('SANDBOX_CONFIG_PATCH_FAILED', 'OpenClaw failed to apply the dynamic sandbox bind plan', { stdout: writeResult.stdout, stderr: writeResult.stderr });
    applied = true;
    const recreated = await runner('openclaw', ['sandbox', 'recreate', '--session', sessionKey, '--force']);
    if (recreated.exit_code !== 0) fail('SANDBOX_RECREATE_FAILED', 'OpenClaw failed to recreate the test sandbox session', { stdout: recreated.stdout, stderr: recreated.stderr });
    const explained = parseCommandJson(await runner('openclaw', ['sandbox', 'explain', '--session', sessionKey, '--json']), 'openclaw sandbox explain');
    const effective = explained.sandbox ?? {};
    if (effective.sessionIsSandboxed !== true || effective.mode !== 'all' || effective.backend !== 'docker'
      || effective.scope !== 'session' || effective.workspaceAccess !== 'none'
      || !Array.isArray(effective.workspaceMounts) || effective.workspaceMounts.length < mountPlan.mounts.length) {
      fail('SANDBOX_EFFECTIVE_POLICY_MISMATCH', 'OpenClaw did not resolve the required sandbox policy for the test session', { effective });
    }
  } catch (error) {
    if (applied) {
      try {
        await runner('openclaw', ['config', 'set', `agents.list[${index}].sandbox.docker.binds`, JSON.stringify(previousBinds), '--strict-json']);
        await runner('openclaw', ['sandbox', 'recreate', '--session', sessionKey, '--force']);
      } catch (restoreError) {
        error.details = { ...(error.details ?? {}), restore_error: restoreError.message };
        error.code = 'SANDBOX_CONFIG_RESTORE_FAILED';
      }
    }
    throw error;
  }
  const leasePath = join(task.artifact_root_abs, '.orchestrator', 'test-sandbox-lease.json');
  const statePath = join(task.artifact_root_abs, '.orchestrator', 'test-sandbox-state.json');
  mkdirSync(join(task.artifact_root_abs, '.orchestrator'), { recursive: true });
  const lease = {
    schema_version: 1, agent_id: 'test-agent', session_id: sessionId, session_key: sessionKey,
    project_root_abs: projectRoot, policy_path_abs: policyPath, policy_digest: sandboxPolicyDigest(policy), policy,
    config_index: index, previous_binds: previousBinds, desired_binds: desiredBinds, mount_plan: mountPlan,
    state_path_abs: statePath,
    created_at: new Date().toISOString(), lease_path_abs: leasePath,
  };
  atomicWriteJson(leasePath, lease);
  let attestation;
  try {
    attestation = await verifySandboxRuntime({ lease, commandRunner });
  } catch (error) {
    try {
      await cleanupTestSandboxSession({ lease, leasePath, commandRunner });
    } catch (cleanupError) {
      error.details = { ...(error.details ?? {}), prepare_cleanup_error: cleanupError.message, prepare_cleanup_error_code: cleanupError.code ?? null };
    }
    throw error;
  }
  return { lease, leasePath, policy, mountPlan, attestation };
}

function inspectMounts(container, mountPlan) {
  const mounts = new Map((container.Mounts ?? []).map((mount) => [mount.Destination, mount]));
  for (const expected of mountPlan.mounts) {
    const actual = mounts.get(expected.container_path);
    if (!actual || Boolean(actual.RW) !== (expected.mode === 'rw') || !isWithinPath(actual.Source, expected.host_path_abs) || !isWithinPath(expected.host_path_abs, actual.Source)) {
      fail('SANDBOX_RUNTIME_MOUNT_MISMATCH', `sandbox mount mismatch at ${expected.container_path}`, { expected, actual });
    }
  }
  const allowedExtras = new Set(['/workspace', '/etc/hosts', '/etc/hostname', '/etc/resolv.conf']);
  const unexpected = [...mounts.keys()].filter((destination) => !mountPlan.mounts.some((mount) => mount.container_path === destination) && !allowedExtras.has(destination));
  if (unexpected.length > 0) fail('SANDBOX_RUNTIME_EXTRA_MOUNT', 'sandbox contains an unexpected host mount', { mount_destinations: unexpected });
}

function runtimeLabelOf(record) {
  return typeof record?.runtimeLabel === 'string' && record.runtimeLabel.trim()
    ? record.runtimeLabel.trim()
    : (typeof record?.containerName === 'string' && record.containerName.trim() ? record.containerName.trim() : null);
}

/**
 * OpenClaw's registry is a history of runtimes, not an availability check.
 * A stopped record is deliberately kept out of current_candidates; a running
 * record without a runtime label is unusable and must never be selected.
 */
export function classifySandboxContainerRecords(containers, sessionKey) {
  const sessionRecords = (Array.isArray(containers) ? containers : [])
    .filter((item) => item?.sessionKey === sessionKey);
  return {
    session_records: sessionRecords,
    current_candidates: sessionRecords.filter((item) => item.running === true && runtimeLabelOf(item)),
    historical_records: sessionRecords.filter((item) => item.running !== true),
    unusable_records: sessionRecords.filter((item) => item.running === true && !runtimeLabelOf(item)),
  };
}

function stateRecord(record, classification, details = {}) {
  return { ...clone(record), classification, ...details };
}

function writeSandboxState(lease, state) {
  if (!lease?.state_path_abs) return;
  mkdirSync(dirname(lease.state_path_abs), { recursive: true });
  atomicWriteJson(lease.state_path_abs, {
    schema_version: 1,
    agent_id: lease.agent_id,
    session_id: lease.session_id,
    session_key: lease.session_key,
    lease_path_abs: lease.lease_path_abs,
    ...state,
    updated_at: new Date().toISOString(),
  });
}

async function inspectRuntimeRecord(record, runner) {
  const runtimeLabel = runtimeLabelOf(record);
  if (!runtimeLabel) return { record, runtimeLabel: null, docker: null, reason: 'missing_runtime_label' };
  const result = await runner('docker', ['inspect', runtimeLabel]);
  if (result.exit_code !== 0) return {
    record, runtimeLabel, docker: null, reason: 'docker_inspect_failed',
    inspect_result: { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr },
  };
  let parsed;
  try { parsed = JSON.parse(result.stdout); }
  catch (error) {
    return { record, runtimeLabel, docker: null, reason: 'docker_inspect_invalid_json', error: error.message };
  }
  return { record, runtimeLabel, docker: Array.isArray(parsed) ? parsed[0] : null, reason: null };
}

function rootUserValue(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'root' || text === 'root:root' || text.split(':')[0] === '0';
}

function assertDockerRuntime(docker, lease) {
  const { policy, mount_plan: mountPlan } = lease;
  if (!docker?.Id) fail('SANDBOX_RUNTIME_INVALID', 'docker inspect returned no container identity');
  if (docker.Config?.Image !== policy.docker.image) fail('SANDBOX_RUNTIME_IMAGE_MISMATCH', 'sandbox image does not match the policy', { image: docker.Config?.Image });
  if (docker.Config?.WorkingDir !== policy.docker.workdir) fail('SANDBOX_RUNTIME_WORKDIR_MISMATCH', 'sandbox working directory does not match the policy', { working_dir: docker.Config?.WorkingDir });
  const actualUser = typeof docker.Config?.User === 'string' ? docker.Config.User.trim() : '';
  if (rootUserValue(actualUser)) fail('SANDBOX_RUNTIME_ROOT_USER', 'sandbox runtime is running as root; refusing to execute test-agent work', { actual_user: actualUser, expected_user: policy.docker.user });
  if (actualUser !== policy.docker.user) fail('SANDBOX_RUNTIME_USER_MISMATCH', 'sandbox runtime user does not match the non-root policy', { actual_user: actualUser, expected_user: policy.docker.user });
  if (docker.HostConfig?.NetworkMode !== policy.docker.network || docker.HostConfig?.ReadonlyRootfs !== policy.docker.read_only_root
    || JSON.stringify(docker.HostConfig?.CapDrop ?? []) !== JSON.stringify(policy.docker.cap_drop)
    || Number(docker.HostConfig?.PidsLimit) !== policy.docker.pids_limit || Number(docker.HostConfig?.NanoCpus) !== policy.docker.cpus * 1_000_000_000
    || Number(docker.HostConfig?.Memory) !== 2 * 1024 * 1024 * 1024) {
    fail('SANDBOX_RUNTIME_POLICY_MISMATCH', 'Docker runtime limits do not match the test sandbox policy', { host_config: docker.HostConfig });
  }
  inspectMounts(docker, mountPlan);
}

function runtimeStateSummary(lease, classifications, inspections, current = null, phase = 'VERIFYING') {
  const inspectedNonExecutable = inspections
    .filter((item) => !item.docker || item.docker.State?.Running !== true)
    .map((item) => stateRecord(item.record, 'current_non_executable', { runtime_label: item.runtimeLabel, reason: item.reason ?? 'not_running' }));
  return {
    phase,
    current_executable_container: current,
    current_candidate_records: classifications.current_candidates.map((item) => stateRecord(item, 'current_candidate')),
    historical_container_records: classifications.historical_records.map((item) => stateRecord(item, 'historical')),
    non_executable_container_records: [
      ...classifications.unusable_records.map((item) => stateRecord(item, 'current_non_executable', { reason: 'missing_runtime_label' })),
      ...inspectedNonExecutable,
    ],
  };
}

export async function verifySandboxRuntime({ lease, commandRunner = null } = {}) {
  const runner = (executable, args, options = {}) => runSandboxCommand(executable, args, { ...options, runner: commandRunner });
  const listed = parseCommandJson(await runner('openclaw', ['sandbox', 'list', '--json']), 'openclaw sandbox list');
  const classifications = classifySandboxContainerRecords(listed.containers, lease.session_key);
  const inspections = [];
  for (const record of classifications.current_candidates) inspections.push(await inspectRuntimeRecord(record, runner));
  const running = inspections.filter((item) => item.docker?.State?.Running === true);
  if (running.length !== 1) {
    writeSandboxState(lease, runtimeStateSummary(lease, classifications, inspections, null, 'UNAVAILABLE'));
    if (running.length > 1) fail('SANDBOX_RUNTIME_AMBIGUOUS', 'more than one currently running sandbox matches the test session', { session_key: lease.session_key, runtime_labels: running.map((item) => item.runtimeLabel) });
    fail('SANDBOX_RUNTIME_MISSING', 'no currently executable Docker sandbox was found for the test session', {
      session_key: lease.session_key, current_candidates: classifications.current_candidates, historical_records: classifications.historical_records,
    });
  }
  const active = running[0];
  try {
    assertDockerRuntime(active.docker, lease);
  } catch (error) {
    writeSandboxState(lease, runtimeStateSummary(lease, classifications, inspections, null, 'UNAVAILABLE'));
    const current = stateRecord(active.record, 'current_non_executable', { runtime_label: active.runtimeLabel, reason: error.code });
    const state = JSON.parse(readFileSync(lease.state_path_abs, 'utf8'));
    state.non_executable_container_records.push(current);
    atomicWriteJson(lease.state_path_abs, state);
    throw error;
  }
  const current = {
    classification: 'current_executable', runtime_label: active.runtimeLabel, container_id: active.docker.Id,
    session_key: lease.session_key, user: active.docker.Config.User, image: active.docker.Config.Image,
  };
  writeSandboxState(lease, runtimeStateSummary(lease, classifications, inspections, current, 'ACTIVE'));
  lease.runtime_label = active.runtimeLabel;
  lease.runtime_container_id = active.docker.Id;
  if (lease.lease_path_abs) atomicWriteJson(lease.lease_path_abs, { ...lease, runtime_verified_at: new Date().toISOString() });
  return createSandboxAttestation({
    policy: lease.policy, mountPlan: lease.mount_plan, runtimeId: lease.session_key,
    containerId: active.docker.Id, imageDigest: active.docker.Image, verifiedAt: new Date().toISOString(),
  });
}

async function collectPostStopState(lease, runner) {
  const listed = parseCommandJson(await runner('openclaw', ['sandbox', 'list', '--json']), 'openclaw sandbox list');
  const classifications = classifySandboxContainerRecords(listed.containers, lease.session_key);
  const labels = new Set(classifications.session_records.map(runtimeLabelOf).filter(Boolean));
  if (lease.runtime_label) labels.add(lease.runtime_label);
  const inspections = [];
  for (const runtimeLabel of labels) inspections.push(await inspectRuntimeRecord({ runtimeLabel, sessionKey: lease.session_key }, runner));
  return { listed, classifications, inspections };
}

function existingRunning(inspections) {
  return inspections.filter((item) => item.docker?.State?.Running === true);
}

async function removeStoppedOwnedRuntimes(lease, postStop, runner) {
  const removed = [];
  for (const item of postStop.inspections.filter((value) => value.docker && value.docker.State?.Running !== true)) {
    const labels = item.docker.Config?.Labels ?? {};
    if (labels['openclaw.sandbox'] !== '1' || labels['openclaw.sessionKey'] !== lease.session_key) {
      fail('SANDBOX_CLEANUP_TARGET_MISMATCH', 'refusing to remove a container that is not owned by this sandbox session', { runtime_label: item.runtimeLabel, labels });
    }
    const result = await runner('docker', ['rm', '-f', item.runtimeLabel]);
    if (result.exit_code !== 0) fail('SANDBOX_CLEANUP_FAILED', 'failed to remove the stopped sandbox container', { runtime_label: item.runtimeLabel, stdout: result.stdout, stderr: result.stderr });
    removed.push(item.runtimeLabel);
  }
  return removed;
}

export async function cleanupTestSandboxSession({ lease, leasePath, commandRunner = null } = {}) {
  const runner = (executable, args, options = {}) => runSandboxCommand(executable, args, { ...options, runner: commandRunner });
  let configError = null;
  try {
    const configResult = await runner('openclaw', ['config', 'get', 'agents.list', '--json']);
    const { index, agent } = configAgent(parseCommandJson(configResult, 'openclaw config get agents.list'));
    const currentBinds = [...(agent.sandbox?.docker?.binds ?? [])];
    if (JSON.stringify(currentBinds) !== JSON.stringify(lease.desired_binds)) fail('SANDBOX_CONFIG_CHANGED_DURING_LEASE', 'test sandbox config changed while the run was active; refusing to overwrite it');
    const writeResult = await runner('openclaw', ['config', 'set', `agents.list[${index}].sandbox.docker.binds`, JSON.stringify(lease.previous_binds), '--strict-json']);
    if (writeResult.exit_code !== 0) fail('SANDBOX_CONFIG_RESTORE_FAILED', 'failed to restore the prior sandbox bind configuration', { stdout: writeResult.stdout, stderr: writeResult.stderr });
  } catch (error) {
    configError = error;
  }

  let stopError = null;
  let postStop = null;
  let removed = [];
  try {
    const recreated = await runner('openclaw', ['sandbox', 'recreate', '--session', lease.session_key, '--force']);
    if (recreated.exit_code !== 0) fail('SANDBOX_CLEANUP_FAILED', 'failed to stop and remove the test sandbox runtime', { stdout: recreated.stdout, stderr: recreated.stderr });
    postStop = await collectPostStopState(lease, runner);
    removed = await removeStoppedOwnedRuntimes(lease, postStop, runner);
    if (removed.length > 0) postStop = await collectPostStopState(lease, runner);
    const running = existingRunning(postStop.inspections);
    if (running.length > 0) fail('SANDBOX_CLEANUP_RUNTIME_REMAINS', 'a sandbox container is still running after cleanup', { runtime_labels: running.map((item) => item.runtimeLabel) });
  } catch (error) {
    stopError = error;
  }

  if (postStop) {
    const inspections = postStop.inspections;
    const running = existingRunning(inspections);
    const nonExecutable = [
      ...postStop.classifications.unusable_records.map((item) => stateRecord(item, 'current_non_executable', { reason: 'missing_runtime_label' })),
      ...inspections.filter((item) => !item.docker || item.docker.State?.Running !== true)
        .map((item) => stateRecord(item.record, 'historical_or_stopped', { runtime_label: item.runtimeLabel, reason: item.reason ?? 'not_running' })),
    ];
    writeSandboxState(lease, {
      phase: (configError || stopError) ? 'CLEANED_WITH_ERRORS' : 'CLEANED',
      current_executable_container: running.length > 0 ? running.map((item) => ({ classification: 'current_executable', runtime_label: item.runtimeLabel, container_id: item.docker.Id, session_key: lease.session_key })) : null,
      current_candidate_records: postStop.classifications.current_candidates.map((item) => stateRecord(item, 'stopped_or_unverified')),
      historical_container_records: postStop.classifications.historical_records.map((item) => stateRecord(item, 'historical')),
      non_executable_container_records: nonExecutable,
      cleanup: {
        stop_requested: true, stop_verified: !stopError && running.length === 0, removed_runtime_labels: removed,
        config_restored: !configError, config_error: configError?.code ?? null, stop_error: stopError?.code ?? null,
      },
    });
  } else {
    writeSandboxState(lease, {
      phase: 'CLEANUP_FAILED', current_executable_container: null, cleanup: {
        stop_requested: true, stop_verified: false, removed_runtime_labels: removed,
        config_restored: !configError, config_error: configError?.code ?? null, stop_error: stopError?.code ?? null,
      },
    });
  }

  if (stopError) throw stopError;
  if (configError) throw configError;
  if (leasePath) atomicWriteJson(leasePath, { ...lease, cleaned_at: new Date().toISOString(), cleanup_state_path_abs: lease.state_path_abs });
  return true;
}

export function sandboxPolicyDigest(policy) {
  return createHash('sha256').update(JSON.stringify(policy), 'utf8').digest('hex');
}
