import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteJson, sha256File, sha256Text } from '../runtime-core/atomic-store.mjs';

function regular(path, code) {
  if (!existsSync(path)) throw Object.assign(new Error(`context input is missing: ${path}`), { code });
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Object.assign(new Error(`context input must be a regular non-symlink file: ${path}`), { code });
}

function readOnly(path) { try { chmodSync(path, 0o444); } catch { /* hashes remain authoritative on Windows */ } }

function ruleSources(projectRoot, agentId) {
  const common = ['COMMON_RULES.md', 'CONTEXT_PROTOCOL.md', 'EVIDENCE_RULES.md', 'GIT_RULES.md', 'SECURITY_RULES.md', 'APPROVAL_RULES.md']
    .map((name) => join(projectRoot, 'agents', 'common', name));
  const workspace = ['AGENTS.md', 'TOOLS.md', 'IDENTITY.md', 'SOUL.md']
    .map((name) => join(projectRoot, 'agents', agentId, 'workspace', name));
  return [...common, ...workspace].filter(existsSync);
}

function validateManifest(projectRoot, manifest) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'context-manifest.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(manifest)) throw Object.assign(new Error('generated context manifest failed JSON Schema validation'), { code: 'CONTEXT_MANIFEST_SCHEMA_INVALID', details: validate.errors });
}

export function rawOutputPath(task) { return join(task.artifactRootAbs, '.agent-raw', 'result.json.raw'); }
export function publishedOutputPath(task) { return join(task.artifactRootAbs, 'output', 'result.json'); }
export function inputRootForAttempt(task) {
  return task.attempt <= 1 ? join(task.artifactRootAbs, 'input') : join(task.artifactRootAbs, 'attempts', `attempt-${task.attempt}`, 'input');
}

export function createContextManifest({ projectRoot: projectRootInput, task, priorArtifacts = [] }) {
  const projectRoot = resolve(projectRootInput);
  if (typeof task.originalRequest !== 'string' || !task.originalRequest.trim()) {
    throw Object.assign(new Error('task is missing the immutable original user request'), { code: 'ORIGINAL_REQUEST_MISSING' });
  }
  const inputRoot = inputRootForAttempt(task);
  const rulesRoot = join(inputRoot, 'rules');
  const controlRoot = join(task.artifactRootAbs, '.orchestrator');
  mkdirSync(rulesRoot, { recursive: true });
  mkdirSync(controlRoot, { recursive: true });
  const taskPath = join(inputRoot, 'task.json');
  const taskInput = {
    schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    step_id: task.stepId, kind: task.kind, title: task.title, assigned_agent: task.agentId,
    attempt: task.attempt, route_hash: task.routeHash, input_commit: task.inputCommit,
    target_project_root_abs: task.targetProjectRootAbs, worktree_path_abs: task.worktreePathAbs,
    artifact_root_abs: task.artifactRootAbs, allowed_write_paths_abs: [task.worktreePathAbs, join(task.artifactRootAbs, '.agent-raw')],
    forbidden_paths_abs: [inputRoot, join(task.artifactRootAbs, 'output')], required_gate_checks: task.requiredGateChecks,
    original_request_path_abs: join(inputRoot, 'user-request.md'), prior_artifacts: priorArtifacts,
  };
  atomicWriteJson(taskPath, taskInput); readOnly(taskPath);
  const inputs = [{ path_abs: taskPath, sha256: sha256File(taskPath), role: 'task' }];
  const originalRequestPath = join(inputRoot, 'user-request.md');
  writeFileSync(originalRequestPath, task.originalRequest, 'utf8'); readOnly(originalRequestPath);
  inputs.push({ path_abs: originalRequestPath, sha256: sha256File(originalRequestPath), role: 'user_request' });
  const rules = [];
  for (const [index, source] of ruleSources(projectRoot, task.agentId).entries()) {
    regular(source, 'CONTEXT_RULE_UNSAFE');
    const target = join(rulesRoot, `${String(index + 1).padStart(2, '0')}-${basename(source)}`);
    copyFileSync(source, target); readOnly(target);
    inputs.push({ path_abs: target, sha256: sha256File(target), role: 'rule' });
    rules.push({ name: basename(source), sha256: sha256File(target) });
  }
  const contextPath = join(inputRoot, 'context.md');
  writeFileSync(contextPath, `# Orchestrator task context\n\n- Workflow: ${task.workflowId}\n- Task: ${task.taskId}\n- Stage: ${task.kind}\n- Assigned agent: ${task.agentId}\n- Input commit: ${task.inputCommit ?? 'none'}\n\n## Objective\n${task.title}\n\nRead \`user-request.md\` first. It is the immutable original user request for this workflow and is the authoritative source for product requirements, constraints, and approval expectations.\n\nOnly use published artifacts listed in task.json for earlier-stage context.\n`, 'utf8');
  readOnly(contextPath); inputs.push({ path_abs: contextPath, sha256: sha256File(contextPath), role: 'context' });
  const manifest = {
    schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    assigned_agent: task.agentId, attempt: task.attempt, created_at: new Date().toISOString(),
    manager_session_reference: null, target_project_root_abs: task.targetProjectRootAbs,
    worktree_path_abs: task.worktreePathAbs, artifact_root_abs: task.artifactRootAbs,
    input_files: inputs, rule_version: 'orchestrator-v1', rule_hash: sha256Text(JSON.stringify(rules)),
    input_commit: task.inputCommit, expected_output_paths_abs: [rawOutputPath(task), publishedOutputPath(task)],
  };
  validateManifest(projectRoot, manifest);
  const path = join(inputRoot, 'context-manifest.json');
  atomicWriteJson(path, manifest); readOnly(path);
  const sha256 = sha256File(path);
  atomicWriteJson(join(controlRoot, 'context-manifest.receipt.json'), { schema_version: 1, task_id: task.taskId, path_abs: path, sha256, created_at: manifest.created_at });
  return { path, sha256, manifest };
}
