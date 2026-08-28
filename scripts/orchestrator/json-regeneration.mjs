import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteJson, sha256Text } from '../runtime-core/atomic-store.mjs';
import { buildJsonRepairPrompt } from '../agent-json-harness/json-repair-prompts.mjs';

export const MAX_JSON_REGENERATIONS = 2;

const REGENERABLE_CODES = new Set([
  'AGENT_OUTPUT_MISSING',
  'AGENT_OUTPUT_JSON_INVALID',
  'AGENT_OUTPUT_SCHEMA_INVALID',
  'AGENT_OUTPUT_IDENTITY_MISMATCH',
  'AGENT_OUTPUT_PATH_IDENTITY_MISMATCH',
  'AGENT_OUTPUT_INPUT_COMMIT_MISMATCH',
  'AGENT_OUTPUT_CONTEXT_HASH_MISMATCH',
]);

export function isJsonRegenerable(error) { return REGENERABLE_CODES.has(error?.code); }
export function isOutputBoundaryFailure(error) { return typeof error?.code === 'string' && error.code.startsWith('AGENT_OUTPUT_'); }

export function readRegularFileNoFollow(path) {
  let descriptor = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.nlink !== 1 || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino) return { available: false, text: '' };
    return { available: true, text: readFileSync(descriptor, 'utf8') };
  } catch {
    return { available: false, text: '' };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function promptClassification(error) {
  if (error?.code === 'AGENT_OUTPUT_MISSING') return 'EMPTY_RESPONSE';
  if (error?.code === 'AGENT_OUTPUT_JSON_INVALID') return error.details?.diagnostic ?? 'JSON_PARSE_ERROR';
  const keywords = (error?.details?.errors ?? []).map((item) => item.keyword ?? item.schema_keyword);
  if (keywords.includes('enum')) return 'ENUM_VIOLATION';
  if (keywords.includes('type')) return 'TYPE_VIOLATION';
  return 'SCHEMA_DRIFT';
}

function promptErrors(error) {
  const errors = error?.details?.errors;
  if (Array.isArray(errors) && errors.length) return errors.slice(0, 20).map((item) => ({
    instancePath: String(item.instancePath ?? item.path ?? '$').slice(0, 200),
    keyword: item.keyword ?? item.schema_keyword ?? null,
    params: {
      ...(item.params?.missingProperty ? { missingProperty: String(item.params.missingProperty).slice(0, 200) } : {}),
      ...(item.params?.type ? { type: String(item.params.type).slice(0, 100) } : {}),
      ...(item.params?.pattern ? { pattern: String(item.params.pattern).slice(0, 200) } : {}),
      ...(Array.isArray(item.params?.allowedValues) ? { allowedValues: item.params.allowedValues.slice(0, 20).map((value) => String(value).slice(0, 100)) } : {}),
    },
    message: String(item.message ?? 'JSON 产物校验失败').slice(0, 300),
  }));
  const field = error?.details?.field ? `/${String(error.details.field).slice(0, 100)}` : '$';
  return [{ instancePath: field, keyword: null, params: {}, message: String(error?.message ?? 'JSON 产物校验失败').slice(0, 300) }];
}

export function archiveOutputBoundaryFailure({ task, error, sessionId, occurredAt }) {
  const root = join(task.artifactRootAbs, '.orchestrator', 'output-boundary-failures', `attempt-${task.attempt}`);
  const rawResult = readRegularFileNoFollow(task.rawOutputPath);
  atomicWriteFile(join(root, 'rejected-result.json.raw'), rawResult.text);
  atomicWriteJson(join(root, 'diagnostic.json'), {
    schema_version: 1,
    task_id: task.taskId,
    run_id: task.runId,
    agent_id: task.agentId,
    session_id: sessionId,
    attempt: task.attempt,
    occurred_at: occurredAt,
    raw_sha256: sha256Text(rawResult.text),
    raw_available: rawResult.available,
    error: { code: error.code ?? 'AGENT_OUTPUT_INVALID', message: error.message, details: error.details ?? null },
  });
  return { root };
}

export function archiveJsonRegeneration({ task, error, regeneration, sessionId, occurredAt, exhausted = false }) {
  const label = exhausted ? 'regeneration-exhausted' : `regeneration-${regeneration}`;
  const root = join(task.artifactRootAbs, '.orchestrator', 'json-regenerations', `attempt-${task.attempt}`, label);
  const rawResult = readRegularFileNoFollow(task.rawOutputPath);
  const rawAvailable = rawResult.available;
  const raw = rawResult.text;
  const message = buildJsonRepairPrompt({
    classification: promptClassification(error),
    errors: promptErrors(error),
    retryNumber: regeneration,
    rawOutputPath: task.rawOutputPath,
    contextManifestSha256: task.contextManifestSha256,
    resultIdentity: {
      workflow_id: task.workflowId,
      task_id: task.taskId,
      run_id: task.runId,
      agent_id: task.agentId,
      role: task.kind,
      attempt: task.attempt,
      worktree_path_abs: task.worktreePathAbs,
      artifact_root_abs: task.artifactRootAbs,
      input_commit: task.inputCommit,
      output_commit: task.inputCommit,
      isolation_mode: task.kind === 'TEST' && task.testSandboxEnabled !== false ? 'SANDBOXED_DOCKER' : 'UNSANDBOXED_LOCAL',
      artifact_manifest_hash: task.contextManifestSha256,
    },
  });
  const messagePath = join(root, 'repair-message.md');
  atomicWriteFile(join(root, 'rejected-result.json.raw'), raw);
  atomicWriteJson(join(root, 'diagnostic.json'), {
    schema_version: 1,
    task_id: task.taskId,
    run_id: task.runId,
    agent_id: task.agentId,
    session_id: sessionId,
    attempt: task.attempt,
    regeneration,
    occurred_at: occurredAt,
    raw_sha256: sha256Text(raw),
    raw_available: rawAvailable,
    error: { code: error.code ?? 'AGENT_OUTPUT_INVALID', message: error.message, details: error.details ?? null },
  });
  atomicWriteFile(messagePath, `${message}\n`);
  return { messagePath, root };
}
