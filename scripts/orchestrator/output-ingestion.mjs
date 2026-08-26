import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteFile, atomicWriteJson, sha256File } from '../runtime-core/atomic-store.mjs';
import { ingestJsonText } from '../runtime-core/json-ingestion.mjs';
import { rawOutputPath, publishedOutputPath } from './context-manifest.mjs';
import { readRegularFileNoFollow } from './json-regeneration.mjs';

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
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new OutputBoundaryError(code, `required file must be a single-link regular non-symlink file: ${path}`);
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

function mappedReferences(value, mappings = []) {
  const mapped = structuredClone(value);
  for (const field of ['report_files', 'command_record_refs', 'evidence_refs']) {
    mapped[field] = (mapped[field] ?? []).map((path) => {
      if (typeof path !== 'string' || !posix.isAbsolute(path)) return path;
      for (const mapping of mappings) {
        const containerRoot = String(mapping?.container_root_abs ?? '').replace(/\/$/u, '');
        if (!containerRoot || (path !== containerRoot && !path.startsWith(`${containerRoot}/`))) continue;
        const suffix = posix.relative(containerRoot, path);
        if (suffix === '..' || suffix.startsWith('../')) continue;
        return suffix ? join(mapping.host_root_abs, ...suffix.split('/')) : resolve(mapping.host_root_abs);
      }
      return path;
    });
  }
  return mapped;
}

function attachHostSandboxAttestation(task, value, sandboxContext) {
  if (task.agentId !== 'test-agent' || value.isolation_mode !== 'SANDBOXED_DOCKER') return value;
  const attestation = sandboxContext?.attestation;
  if (!attestation?.receipt_path_abs || !attestation?.receipt_sha256) {
    throw new OutputBoundaryError('TEST_SANDBOX_ATTESTATION_MISSING', 'SANDBOXED_DOCKER TEST output requires a host-owned sandbox attestation receipt');
  }
  regular(attestation.receipt_path_abs, 'TEST_SANDBOX_ATTESTATION_UNSAFE');
  const actualSha256 = sha256File(attestation.receipt_path_abs);
  if (actualSha256 !== attestation.receipt_sha256) {
    throw new OutputBoundaryError('TEST_SANDBOX_ATTESTATION_HASH_MISMATCH', 'host sandbox attestation receipt changed after staging', {
      expected: attestation.receipt_sha256, actual: actualSha256,
    });
  }
  let receipt;
  try { receipt = JSON.parse(readFileSync(attestation.receipt_path_abs, 'utf8')); }
  catch { throw new OutputBoundaryError('TEST_SANDBOX_ATTESTATION_INVALID', 'host sandbox attestation receipt is not valid JSON'); }
  for (const [field, expected] of [['workflow_id', task.workflowId], ['task_id', task.taskId], ['run_id', task.runId], ['agent_id', task.agentId], ['attempt', task.attempt]]) {
    if (receipt[field] !== expected) throw new OutputBoundaryError('TEST_SANDBOX_ATTESTATION_IDENTITY_MISMATCH', `host sandbox attestation ${field} does not match the assigned task`, { field, expected, actual: receipt[field] });
  }
  if (receipt.kind !== 'test-sandbox-attestation' || receipt.authority !== 'orchestrator-host'
    || receipt.verification?.effective_openclaw_configuration !== true || receipt.verification?.staging_workspace !== true
    || receipt.verification?.runtime_container_inspected !== false || receipt.configured_sandbox?.backend !== 'docker') {
    throw new OutputBoundaryError('TEST_SANDBOX_ATTESTATION_INVALID', 'host sandbox attestation receipt does not contain the required configured/staging verification facts');
  }
  return {
    ...value,
    sandbox_attestation: {
      authority: 'orchestrator-host', verification_scope: 'HOST_CONFIG_AND_STAGING_VERIFIED',
      receipt_path_abs: attestation.receipt_path_abs, receipt_sha256: actualSha256,
      effective_openclaw_configuration_verified: true, staging_workspace_verified: true,
      runtime_container_inspected: false, configured_sandbox: receipt.configured_sandbox,
      limitations: receipt.limitations ?? [], agent_claim: value.sandbox_attestation ?? null,
    },
  };
}

export function ingestTaskOutput({ projectRoot, task, occurredAt = new Date().toISOString(), sandboxContext = null }) {
  const rawPath = rawOutputPath(task); const rawResult = readRegularFileNoFollow(rawPath);
  if (!rawResult.available) throw new OutputBoundaryError('AGENT_OUTPUT_MISSING', `required file must be a single-link regular file: ${rawPath}`);
  const raw = rawResult.text;
  let ingestion;
  try { ingestion = ingestJsonText(raw); }
  catch (error) { throw new OutputBoundaryError('AGENT_OUTPUT_JSON_INVALID', error.message, { diagnostic: error.diagnostic ?? 'JSON_PARSE_ERROR' }); }
  validateResult(projectRoot, ingestion.value);
  const mapped = mappedReferences(ingestion.value, sandboxContext?.referencePathMappings);
  const value = attachHostSandboxAttestation(task, mapped, sandboxContext);
  assertIdentity(task, value);
  const boundaryTransformations = [];
  if (JSON.stringify(mapped) !== JSON.stringify(ingestion.value)) boundaryTransformations.push('container_references_mapped');
  if (value.sandbox_attestation !== mapped.sandbox_attestation) boundaryTransformations.push('host_sandbox_attestation_attached');
  const transformations = [...ingestion.transformations, ...boundaryTransformations];
  const publishedText = boundaryTransformations.length ? JSON.stringify(value) : ingestion.text;
  const outputPath = publishedOutputPath(task); mkdirSync(dirname(outputPath), { recursive: true }); atomicWriteFile(outputPath, `${publishedText}\n`);
  const receiptPath = join(task.artifactRootAbs, '.orchestrator-ingest', 'result.receipt.json');
  atomicWriteJson(receiptPath, { schema_version: 1, workflow_id: task.workflowId, task_id: task.taskId, run_id: task.runId,
    agent_id: task.agentId, raw_path_abs: rawPath, output_path_abs: outputPath, raw_sha256: ingestion.raw_sha256,
    cleaned_sha256: ingestion.cleaned_sha256, published_sha256: sha256File(outputPath), transformations,
    sandbox_attestation_receipt_path_abs: sandboxContext?.attestation?.receipt_path_abs ?? null, accepted_at: occurredAt });
  const logPath = join(task.artifactRootAbs, 'logs', 'agent-output.jsonl'); mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify({ recorded_at: occurredAt, task_id: task.taskId, agent_id: task.agentId, raw_sha256: ingestion.raw_sha256, transformations })}\n`, 'utf8');
  const artifacts = [{ sha256: sha256File(outputPath), path_abs: outputPath }, { sha256: sha256File(receiptPath), path_abs: receiptPath }];
  if (sandboxContext?.attestation?.receipt_path_abs) artifacts.push({
    sha256: sandboxContext.attestation.receipt_sha256, path_abs: sandboxContext.attestation.receipt_path_abs,
  });
  return { value, outputPath, receiptPath, rawPath,
    artifacts };
}

export function writeFailureReceipt(task, error, occurredAt = new Date().toISOString()) {
  const path = join(task.artifactRootAbs, '.orchestrator-ingest', 'failure.receipt.json');
  atomicWriteJson(path, { schema_version: 1, task_id: task.taskId, run_id: task.runId, agent_id: task.agentId,
    occurred_at: occurredAt, error: { code: error.code ?? 'AGENT_OUTPUT_INVALID', message: error.message, details: error.details ?? null } });
  return path;
}
