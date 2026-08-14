import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { canonicalJson, sha256 } from './events.mjs';
import { publishedOutputPath, rawOutputPath } from './output-ingestion.mjs';

export class ContextManifestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContextManifestError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ContextManifestError(code, message, details);
}

function regular(path, code = 'CONTEXT_INPUT_UNSAFE') {
  if (!existsSync(path)) fail('CONTEXT_INPUT_MISSING', `context input is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(code, `context input must be a regular non-symlink file: ${path}`);
}

function digestFile(path) {
  regular(path);
  return sha256(readFileSync(path));
}

function makeReadOnly(path) {
  try { chmodSync(path, 0o444); } catch { /* Windows integrity is enforced by hashes and documented ACL setup. */ }
}

function ruleSources(projectRoot, agentId) {
  const common = ['COMMON_RULES.md', 'CONTEXT_PROTOCOL.md', 'EVIDENCE_RULES.md', 'GIT_RULES.md', 'SECURITY_RULES.md', 'APPROVAL_RULES.md']
    .map((name) => join(projectRoot, 'agents', 'common', name));
  const workspace = ['AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'SOUL.md']
    .map((name) => join(projectRoot, 'agents', agentId, 'workspace', name));
  return [...common, ...workspace].filter(existsSync);
}

function taskInput(task) {
  return {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    step_id: task.step_id,
    kind: task.kind,
    title: task.title,
    assigned_agent: task.agent_id,
    attempt: task.attempt,
    route_hash: task.route_hash ?? null,
    input_commit: task.input_commit,
    target_project_root_abs: task.target_project_root_abs,
    worktree_path_abs: task.worktree_path_abs,
    artifact_root_abs: task.artifact_root_abs,
    required_gate_checks: task.required_gate_checks,
    prompt: task.prompt,
  };
}

function validator(projectRoot) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'context-manifest.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function createContextManifest({ projectRoot: projectRootInput, task, occurredAt = new Date().toISOString() } = {}) {
  const projectRoot = resolve(projectRootInput);
  const inputRoot = join(task.artifact_root_abs, 'input');
  const controlRoot = join(task.artifact_root_abs, '.stategraph');
  const rulesRoot = join(inputRoot, 'rules');
  mkdirSync(rulesRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  const taskPath = join(controlRoot, 'task.json');
  atomicWriteJson(taskPath, taskInput(task));
  makeReadOnly(taskPath);

  const inputs = [{ path_abs: taskPath, sha256: digestFile(taskPath), role: 'task' }];
  const ruleDigests = [];
  for (const [index, source] of ruleSources(projectRoot, task.agent_id).entries()) {
    regular(source, 'CONTEXT_RULE_UNSAFE');
    const target = join(rulesRoot, `${String(index + 1).padStart(2, '0')}-${basename(source)}`);
    copyFileSync(source, target);
    makeReadOnly(target);
    const digest = digestFile(target);
    inputs.push({ path_abs: target, sha256: digest, role: 'rule' });
    ruleDigests.push({ name: basename(source), sha256: digest });
  }
  const manifest = {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    assigned_agent: task.agent_id,
    created_at: occurredAt,
    manager_session_reference: task.kind === 'MANAGER_ANALYSIS' ? task.session_id ?? null : null,
    target_project_root_abs: task.target_project_root_abs,
    worktree_path_abs: task.worktree_path_abs,
    artifact_root_abs: task.artifact_root_abs,
    input_files: inputs,
    rule_version: 'stategraph-v1',
    rule_hash: sha256(canonicalJson(ruleDigests)),
    input_commit: task.input_commit,
    expected_output_paths_abs: [rawOutputPath(task), publishedOutputPath(task)],
  };
  const validate = validator(projectRoot);
  if (!validate(manifest)) fail('CONTEXT_MANIFEST_SCHEMA_INVALID', 'generated context manifest failed schema validation', { errors: validate.errors });
  const path = join(controlRoot, 'context-manifest.json');
  atomicWriteJson(path, manifest);
  const manifestSha256 = digestFile(path);
  atomicWriteJson(join(controlRoot, 'context-manifest.receipt.json'), {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    context_manifest_path_abs: path,
    context_manifest_sha256: manifestSha256,
    created_at: occurredAt,
  });
  makeReadOnly(path);
  return { path, sha256: manifestSha256, manifest };
}

export function verifyContextManifest({ projectRoot: projectRootInput, task } = {}) {
  const projectRoot = resolve(projectRootInput);
  const path = task.context_manifest_path_abs;
  regular(path, 'CONTEXT_MANIFEST_UNSAFE');
  const actual = digestFile(path);
  if (actual !== task.context_manifest_sha256) fail('CONTEXT_MANIFEST_HASH_MISMATCH', 'context manifest changed after dispatch preparation', { expected: task.context_manifest_sha256, actual });
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail('CONTEXT_MANIFEST_JSON_INVALID', 'context manifest is not valid JSON', { error: error.message }); }
  const validate = validator(projectRoot);
  if (!validate(manifest)) fail('CONTEXT_MANIFEST_SCHEMA_INVALID', 'context manifest failed schema validation', { errors: validate.errors });
  for (const [field, expected] of [['workflow_id', task.workflow_id], ['task_id', task.task_id], ['run_id', task.run_id], ['assigned_agent', task.agent_id], ['input_commit', task.input_commit]]) {
    if (manifest[field] !== expected) fail('CONTEXT_MANIFEST_IDENTITY_MISMATCH', `${field} does not match checkpoint task`, { field, expected, actual: manifest[field] });
  }
  for (const input of manifest.input_files) {
    const digest = digestFile(input.path_abs);
    if (digest !== input.sha256) fail('CONTEXT_INPUT_HASH_MISMATCH', 'context input changed after manifest creation', { path_abs: input.path_abs, expected: input.sha256, actual: digest });
  }
  return { manifest, path, sha256: actual };
}
