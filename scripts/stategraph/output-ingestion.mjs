import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { atomicWriteFile, atomicWriteJson } from '../runtime-core/atomic-store.mjs';
import { ingestJsonText } from '../runtime-core/json-ingestion.mjs';
import { canonicalJson, sha256 } from './events.mjs';

export class OutputBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OutputBoundaryError';
    this.code = code;
    this.details = details;
  }
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function inside(root, path) {
  if (!isAbsolute(root) || !isAbsolute(path)) return false;
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function compileSchema(projectRoot, name) {
  const schema = JSON.parse(readFileSync(join(projectRoot, 'contracts', name), 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function expectedOutput(task) {
  return task.kind === 'MANAGER_ANALYSIS'
    ? { file: 'route-plan.json', schema: 'route-plan.schema.json' }
    : { file: 'result.json', schema: 'result.schema.json' };
}

export function rawOutputPath(task) {
  return join(task.artifact_root_abs, '.agent-raw', `${expectedOutput(task).file}.raw`);
}

export function publishedOutputPath(task) {
  return join(task.artifact_root_abs, 'output', expectedOutput(task).file);
}

function appendAgentOutput(task, raw, ingestion, occurredAt, cycle) {
  const path = join(task.artifact_root_abs, 'logs', 'agent-output.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    schema_version: 1,
    recorded_at: occurredAt,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.agent_id,
    attempt: task.attempt,
    cycle,
    source: rawOutputPath(task),
    raw_sha256: sha256(raw),
    transformations: ingestion?.transformations ?? [],
    raw_content: raw,
  })}\n`, 'utf8');
  return path;
}

function assertRegularRaw(path) {
  if (!existsSync(path)) throw new OutputBoundaryError('AGENT_OUTPUT_MISSING', `Agent raw output is missing: ${path}`);
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new OutputBoundaryError('AGENT_OUTPUT_UNSAFE_FILE', `Agent raw output must be a regular non-symlink file: ${path}`);
  }
}

function assertRegularReference(task, path, field) {
  if (!isAbsolute(path) || (!inside(task.artifact_root_abs, path) && !inside(task.worktree_path_abs, path))) {
    throw new OutputBoundaryError('AGENT_OUTPUT_REFERENCE_ESCAPE', `${field} escapes the granted roots`, { field, path });
  }
  if (!existsSync(path)) throw new OutputBoundaryError('AGENT_OUTPUT_REFERENCE_MISSING', `${field} references a missing file`, { field, path });
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new OutputBoundaryError('AGENT_OUTPUT_REFERENCE_UNSAFE', `${field} must reference a regular non-symlink file`, { field, path });
  return sha256(readFileSync(path));
}

function jsonLines(path, field) {
  return readFileSync(path, 'utf8').split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new OutputBoundaryError('AGENT_OUTPUT_REFERENCE_JSON_INVALID', `${field} contains invalid JSON at line ${index + 1}`, { path, line: index + 1, error: error.message }); }
  });
}

function validateCommandRecords(projectRoot, task, paths) {
  const validate = compileSchema(projectRoot, 'command-record.schema.json');
  for (const path of paths) {
    for (const [index, record] of jsonLines(path, 'command_record_refs').entries()) {
      if (!validate(record)) throw new OutputBoundaryError('COMMAND_RECORD_SCHEMA_INVALID', 'command record failed JSON Schema validation', { path, line: index + 1, errors: structuredClone(validate.errors ?? []) });
      for (const [field, expected] of [['task_id', task.task_id], ['run_id', task.run_id], ['invoked_by_agent', task.agent_id], ['attempt', task.attempt]]) {
        if (record[field] !== expected) throw new OutputBoundaryError('COMMAND_RECORD_IDENTITY_MISMATCH', `${field} does not match the checkpoint task`, { path, line: index + 1, field, expected, actual: record[field] });
      }
      if (task.kind === 'TEST' && record.isolation_mode !== 'SANDBOXED_DOCKER') throw new OutputBoundaryError('COMMAND_RECORD_SANDBOX_MISSING', 'test command record is not bound to the Docker sandbox', { path, line: index + 1 });
      for (const stream of ['stdout', 'stderr']) {
        const streamPath = record[`${stream}_path_abs`];
        const digest = assertRegularReference(task, streamPath, `${stream}_path_abs`);
        if (record[`${stream}_sha256`] && record[`${stream}_sha256`] !== digest) throw new OutputBoundaryError('COMMAND_RECORD_STREAM_HASH_MISMATCH', `${stream} hash does not match the referenced log`, { path: streamPath, expected: record[`${stream}_sha256`], actual: digest });
      }
    }
  }
}

function validateEvidence(projectRoot, task, paths) {
  const validate = compileSchema(projectRoot, 'evidence.schema.json');
  for (const path of paths) {
    for (const [index, record] of jsonLines(path, 'evidence_refs').entries()) {
      if (!validate(record)) throw new OutputBoundaryError('EVIDENCE_SCHEMA_INVALID', 'evidence record failed JSON Schema validation', { path, line: index + 1, errors: structuredClone(validate.errors ?? []) });
      if (record.locator_abs) {
        const digest = assertRegularReference(task, record.locator_abs, 'evidence.locator_abs');
        if (record.sha256 && record.sha256 !== digest) throw new OutputBoundaryError('EVIDENCE_HASH_MISMATCH', 'evidence hash does not match locator_abs', { path: record.locator_abs, expected: record.sha256, actual: digest });
      }
    }
  }
}

function assertResultIdentity(task, value) {
  const exact = [
    ['workflow_id', task.workflow_id],
    ['task_id', task.task_id],
    ['run_id', task.run_id],
    ['agent_id', task.agent_id],
    ['attempt', task.attempt],
  ];
  for (const [field, expected] of exact) {
    if (value[field] !== expected) throw new OutputBoundaryError('AGENT_OUTPUT_IDENTITY_MISMATCH', `${field} must equal the code-assigned value`, { field, expected, actual: value[field] });
  }
  if (normalized(value.artifact_root_abs) !== normalized(task.artifact_root_abs)) {
    throw new OutputBoundaryError('AGENT_OUTPUT_ARTIFACT_ROOT_MISMATCH', 'artifact_root_abs does not match the task capability');
  }
  if (normalized(value.worktree_path_abs) !== normalized(task.worktree_path_abs)) {
    throw new OutputBoundaryError('AGENT_OUTPUT_WORKTREE_MISMATCH', 'worktree_path_abs does not match the task capability');
  }
  if (value.input_commit !== task.input_commit) throw new OutputBoundaryError('AGENT_OUTPUT_INPUT_COMMIT_MISMATCH', 'input_commit does not match the checkpoint candidate', { expected: task.input_commit, actual: value.input_commit });
  if (value.artifact_manifest_hash !== task.context_manifest_sha256) throw new OutputBoundaryError('AGENT_OUTPUT_CONTEXT_HASH_MISMATCH', 'artifact_manifest_hash does not match the immutable context manifest', { expected: task.context_manifest_sha256, actual: value.artifact_manifest_hash });
  if (task.kind === 'TEST' && value.isolation_mode !== 'SANDBOXED_DOCKER') throw new OutputBoundaryError('AGENT_OUTPUT_SANDBOX_MISSING', 'test-agent result must declare SANDBOXED_DOCKER');
  if (task.kind === 'TEST' && canonicalJson(value.sandbox_attestation ?? null) !== canonicalJson(task.sandbox_attestation ?? null)) {
    throw new OutputBoundaryError('AGENT_OUTPUT_SANDBOX_ATTESTATION_MISMATCH', 'Agent result sandbox_attestation does not equal the code-verified process attestation');
  }
  for (const field of ['report_files', 'command_record_refs', 'evidence_refs']) {
    for (const path of value[field] ?? []) {
      assertRegularReference(task, path, field);
    }
  }
}

export function ingestTaskOutput({ projectRoot, task, occurredAt = new Date().toISOString(), cycle = 0 } = {}) {
  const rawPath = rawOutputPath(task);
  assertRegularRaw(rawPath);
  const raw = readFileSync(rawPath, 'utf8');
  let ingestion;
  try {
    ingestion = ingestJsonText(raw);
  } catch (error) {
    appendAgentOutput(task, raw, null, occurredAt, cycle);
    throw new OutputBoundaryError('AGENT_OUTPUT_JSON_INVALID', error.message, { diagnostic: error.diagnostic ?? 'JSON_PARSE_ERROR' });
  }
  appendAgentOutput(task, raw, ingestion, occurredAt, cycle);
  const output = expectedOutput(task);
  const validate = compileSchema(projectRoot, output.schema);
  if (!validate(ingestion.value)) {
    throw new OutputBoundaryError('AGENT_OUTPUT_SCHEMA_INVALID', `${output.file} failed JSON Schema validation`, { errors: structuredClone(validate.errors ?? []) });
  }
  if (task.kind === 'MANAGER_ANALYSIS') {
    if (ingestion.value.workflow_id !== task.workflow_id) {
      throw new OutputBoundaryError('ROUTE_PLAN_WORKFLOW_MISMATCH', 'route plan workflow_id does not match the checkpoint thread');
    }
  } else {
    assertResultIdentity(task, ingestion.value);
    validateCommandRecords(projectRoot, task, ingestion.value.command_record_refs ?? []);
    validateEvidence(projectRoot, task, ingestion.value.evidence_refs ?? []);
  }
  const publishedPath = publishedOutputPath(task);
  mkdirSync(dirname(publishedPath), { recursive: true });
  atomicWriteFile(publishedPath, `${ingestion.text}\n`);
  const receiptPath = join(task.artifact_root_abs, '.stategraph-ingest', `${output.file}.receipt.json`);
  atomicWriteJson(receiptPath, {
    schema_version: 1,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    agent_id: task.agent_id,
    raw_path_abs: rawPath,
    output_path_abs: publishedPath,
    raw_sha256: ingestion.raw_sha256,
    cleaned_sha256: ingestion.cleaned_sha256,
    transformations: ingestion.transformations,
    references: task.kind === 'MANAGER_ANALYSIS' ? [] : ['report_files', 'command_record_refs', 'evidence_refs'].flatMap((field) =>
      (ingestion.value[field] ?? []).map((path) => ({ field, path_abs: path, sha256: sha256(readFileSync(path)) }))),
    accepted_at: occurredAt,
  });
  return { value: ingestion.value, output_path_abs: publishedPath, receipt_path_abs: receiptPath, ingestion };
}

export function buildLocalGate(task, result, requiredChecks, occurredAt = new Date().toISOString(), { worktrees = null } = {}) {
  const reported = new Map((result.self_validation?.checks ?? []).map((item) => [item.name, item]));
  const items = requiredChecks.map((name) => {
    const item = reported.get(name);
    const status = item?.status ?? 'UNKNOWN';
    return { item_id: name, status, blocking: true, detail: item?.detail ?? 'required local gate check was not supplied' };
  });
  if (result.self_validation?.preflight_passed !== true) {
    items.unshift({ item_id: 'preflight', status: 'FAIL', blocking: true, detail: 'Agent preflight did not pass' });
  }
  if (result.result_status !== 'COMPLETED') {
    items.unshift({ item_id: 'result_status', status: 'FAIL', blocking: true, detail: `Agent returned ${result.result_status}` });
  }
  if (['DEVELOPMENT', 'TEST'].includes(task.kind)) {
    try {
      if (!worktrees) throw new Error('Git worktree verifier is unavailable');
      if (!/^[0-9a-f]{40}$/u.test(result.output_commit ?? '')) throw new Error(`${task.kind} requires a full output commit SHA (use input_commit when no files changed)`);
      worktrees.assertDescendant(task.worktree_path_abs, task.input_commit, result.output_commit);
      const head = worktrees.head(task.worktree_path_abs);
      if (head !== result.output_commit) throw new Error(`worktree HEAD ${head} does not equal output_commit ${result.output_commit}`);
      items.push({ item_id: 'commit_binding', status: 'PASS', blocking: true, detail: `${result.output_commit} descends from ${task.input_commit} and equals worktree HEAD` });
    } catch (error) {
      items.push({ item_id: 'commit_binding', status: 'FAIL', blocking: true, detail: error.message });
    }
  } else if (result.output_commit && result.output_commit !== task.input_commit) {
    items.push({ item_id: 'commit_scope', status: 'FAIL', blocking: true, detail: `${task.kind} is not authorized to advance the candidate commit` });
  }
  if (task.kind === 'TEST' && (result.command_record_refs ?? []).length === 0) {
    items.push({ item_id: 'command_evidence', status: 'FAIL', blocking: true, detail: 'TEST requires command record evidence' });
  }
  if (task.kind === 'TEST' && (!task.sandbox_attestation || result.isolation_mode !== 'SANDBOXED_DOCKER')) {
    items.push({ item_id: 'docker_sandbox', status: 'FAIL', blocking: true, detail: 'code-verified Docker sandbox attestation is required' });
  } else if (task.kind === 'TEST') {
    items.push({ item_id: 'docker_sandbox', status: 'PASS', blocking: true, detail: `verified container ${task.sandbox_attestation.container_id}` });
  }
  const pass = items.every((item) => ['PASS', 'NOT_APPLICABLE'].includes(item.status));
  const gate = {
    schema_version: 1,
    gate_id: `GATE-${task.task_id.slice(5)}`,
    gate_name: `${task.kind}_GATE`,
    workflow_id: task.workflow_id,
    task_id: task.task_id,
    run_id: task.run_id,
    evaluated_at: occurredAt,
    items,
    overall: pass ? 'PASS' : 'FAIL',
    overall_reason: pass ? 'all code-defined checks passed' : 'one or more code-defined checks failed',
  };
  const path = join(task.artifact_root_abs, 'output', 'local-gate.json');
  atomicWriteJson(path, gate);
  return { gate, path };
}
