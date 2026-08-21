import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteFile, atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { ingestJsonText } from '../runtime-core/json-ingestion.mjs';
import { rawOutputPath, publishedOutputPath } from './context-manifest.mjs';

export class OutputBoundaryError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'OutputBoundaryError'; this.code = code; this.details = details; }
}

function inside(root, path) {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}
function regular(path, code) {
  if (!existsSync(path)) throw new OutputBoundaryError(code, `required file is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OutputBoundaryError(code, `required file must be a regular non-symlink file: ${path}`);
}
function validateResult(projectRoot, value) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'result.schema.json'), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new OutputBoundaryError('AGENT_OUTPUT_SCHEMA_INVALID', 'result failed JSON Schema validation', { errors: structuredClone(validate.errors ?? []) });
}
function assertIdentity(task, value) {
  for (const [field, expected] of [['workflow_id', task.workflowId], ['task_id', task.taskId], ['run_id', task.runId], ['agent_id', task.agentId], ['attempt', task.attempt]]) {
    if (value[field] !== expected) throw new OutputBoundaryError('AGENT_OUTPUT_IDENTITY_MISMATCH', `${field} does not match the assigned task`, { field, expected, actual: value[field] });
  }
  if (resolve(value.artifact_root_abs) !== resolve(task.artifactRootAbs) || resolve(value.worktree_path_abs) !== resolve(task.worktreePathAbs)) {
    throw new OutputBoundaryError('AGENT_OUTPUT_PATH_IDENTITY_MISMATCH', 'result paths do not match the context manifest');
  }
  if (value.input_commit !== task.inputCommit) throw new OutputBoundaryError('AGENT_OUTPUT_INPUT_COMMIT_MISMATCH', 'result input_commit differs from task input_commit');
  if (value.artifact_manifest_hash !== task.contextManifestSha256) throw new OutputBoundaryError('AGENT_OUTPUT_CONTEXT_HASH_MISMATCH', 'result context hash differs from the immutable manifest');
  for (const field of ['report_files', 'command_record_refs', 'evidence_refs']) {
    for (const path of value[field] ?? []) {
      if (!isAbsolute(path)) continue;
      if (!inside(task.artifactRootAbs, path) && !inside(task.worktreePathAbs, path)) throw new OutputBoundaryError('AGENT_OUTPUT_REFERENCE_ESCAPE', `${field} escapes granted roots`, { path });
      regular(path, 'AGENT_OUTPUT_REFERENCE_UNSAFE');
    }
  }
}
export function ingestTaskOutput({ projectRoot, task, occurredAt = new Date().toISOString() }) {
  const rawPath = rawOutputPath(task); regular(rawPath, 'AGENT_OUTPUT_MISSING');
  const raw = readFileSync(rawPath, 'utf8');
  let ingestion;
  try { ingestion = ingestJsonText(raw); }
  catch (error) { throw new OutputBoundaryError('AGENT_OUTPUT_JSON_INVALID', error.message, { diagnostic: error.diagnostic ?? 'JSON_PARSE_ERROR' }); }
  validateResult(projectRoot, ingestion.value); assertIdentity(task, ingestion.value);
  const outputPath = publishedOutputPath(task); mkdirSync(dirname(outputPath), { recursive: true }); atomicWriteFile(outputPath, `${ingestion.text}\n`);
  const receiptPath = join(task.artifactRootAbs, '.orchestrator-ingest', 'result.receipt.json');
  atomicWriteJson(receiptPath, { schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    agent_id: task.agentId, raw_path_abs: rawPath, output_path_abs: outputPath, raw_sha256: ingestion.raw_sha256,
    cleaned_sha256: ingestion.cleaned_sha256, transformations: ingestion.transformations, accepted_at: occurredAt });
  const logPath = join(task.artifactRootAbs, 'logs', 'agent-output.jsonl'); mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ recorded_at: occurredAt, task_id: task.taskId, agent_id: task.agentId, raw_sha256: ingestion.raw_sha256, transformations: ingestion.transformations })}\n`, 'utf8');
  return { value: ingestion.value, outputPath, receiptPath, rawPath,
    artifacts: [{ sha256: sha256File(outputPath), path_abs: outputPath }, { sha256: sha256File(receiptPath), path_abs: receiptPath }] };
}

export function writeFailureReceipt(task, error, occurredAt = new Date().toISOString()) {
  const path = join(task.artifactRootAbs, '.orchestrator-ingest', 'failure.receipt.json');
  atomicWriteJson(path, { schema_version: 1, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId,
    occurred_at: occurredAt, error: { code: error.code ?? 'AGENT_OUTPUT_INVALID', message: error.message, details: error.details ?? null } });
  return path;
}
