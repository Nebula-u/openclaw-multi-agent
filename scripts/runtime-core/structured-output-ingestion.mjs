import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFile, atomicWriteJson, sha256File } from './atomic-store.mjs';
import { ingestJsonText, JsonIngestionError } from './json-ingestion.mjs';

export class StructuredOutputIngestionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StructuredOutputIngestionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new StructuredOutputIngestionError(code, message, details);
}

function normalized(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function safeRelative(root, path) {
  if (!isAbsolute(root) || !isAbsolute(path)) fail('TASK_OUTPUT_PATH_NOT_ABSOLUTE', 'artifact and output paths must be absolute');
  const result = relative(resolve(root), resolve(path));
  if (!result || result === '..' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
    fail('TASK_OUTPUT_PATH_ESCAPE', `output path escapes artifact root: ${path}`);
  }
  return result;
}

function assertRegularFile(path, missingCode, unsafeCode) {
  if (!existsSync(path)) fail(missingCode, `structured output is missing: ${path}`, { path_abs: path });
  if (lstatSync(path).isSymbolicLink()) fail(unsafeCode, `structured output must not be a symbolic link: ${path}`, { path_abs: path });
}

export function stagedOutputPath(task, output) {
  const outputRelative = safeRelative(task.artifact_root_abs, output.path_abs);
  return join(task.artifact_root_abs, '.agent-raw', `${outputRelative}.raw`);
}

export function outputIngestionReceiptPath(task, output) {
  const outputRelative = safeRelative(task.artifact_root_abs, output.path_abs);
  return join(task.artifact_root_abs, '.orchestrator-ingest', `${outputRelative}.receipt.json`);
}

function parseValues(raw, output) {
  try {
    return ingestJsonText(raw, { jsonl: output.format === 'jsonl' });
  } catch (error) {
    if (error instanceof JsonIngestionError) {
      fail('TASK_OUTPUT_INGESTION_INVALID', `cannot safely ingest ${output.path_abs}: ${error.message}`, {
        path_abs: output.path_abs,
        diagnostic: error.diagnostic,
      });
    }
    throw error;
  }
}

/**
 * Accepts only Agent-staged raw files and atomically publishes the validated
 * JSON/JSONL files declared by a task.  Agents never decide the final file,
 * parser recovery rule, schema acceptance, or receipt content.
 */
export function ingestStructuredOutputs(task, { validateSchema, occurredAt = new Date().toISOString() } = {}) {
  if (task.output_ingestion_mode !== 'LOCAL_STAGED') {
    fail('TASK_OUTPUT_INGESTION_MODE', 'new tasks must use LOCAL_STAGED output ingestion');
  }
  if (typeof validateSchema !== 'function') fail('TASK_OUTPUT_INGESTION_INTERNAL', 'validateSchema callback is required');
  const accepted = [];
  for (const output of task.structured_outputs ?? []) {
    const rawPath = stagedOutputPath(task, output);
    if (!existsSync(rawPath)) {
      if (output.required) fail('TASK_REQUIRED_OUTPUT_RAW_MISSING', `required staged output is missing: ${rawPath}`, { path_abs: rawPath });
      continue;
    }
    assertRegularFile(rawPath, 'TASK_OUTPUT_RAW_MISSING', 'TASK_OUTPUT_RAW_SYMLINK');
    const raw = readFileSync(rawPath, 'utf8');
    const ingestion = parseValues(raw, output);
    const values = output.format === 'json' ? [ingestion.value] : ingestion.value;
    if (output.required && values.length === 0) fail('TASK_REQUIRED_OUTPUT_EMPTY', `required output is empty: ${rawPath}`);
    const validator = validateSchema(output.schema_path_abs);
    for (const value of values) {
      if (!validator(value)) {
        fail('TASK_OUTPUT_SCHEMA_INVALID', `JSON Schema validation failed: ${output.path_abs}`, {
          path_abs: output.path_abs,
          errors: structuredClone(validator.errors ?? []),
        });
      }
    }
    const publishedText = output.format === 'jsonl' ? `${ingestion.text.trimEnd()}\n` : `${ingestion.text}\n`;
    atomicWriteFile(output.path_abs, publishedText);
    const publishedSha256 = sha256File(output.path_abs);
    const receiptPath = outputIngestionReceiptPath(task, output);
    atomicWriteJson(receiptPath, {
      schema_version: 1,
      record_type: 'STRUCTURED_OUTPUT_INGESTION',
      workflow_id: task.workflow_id,
      task_id: task.task_id,
      run_id: task.run_id,
      agent_id: task.assigned_agent,
      output_path_abs: output.path_abs,
      staged_raw_path_abs: rawPath,
      raw_sha256: ingestion.raw_sha256,
      cleaned_sha256: ingestion.cleaned_sha256,
      published_sha256: publishedSha256,
      transformations: ingestion.transformations,
      records: values.length,
      accepted_at: occurredAt,
    });
    accepted.push({
      output,
      values,
      staged_raw_path_abs: rawPath,
      receipt_path_abs: receiptPath,
      raw_sha256: ingestion.raw_sha256,
      cleaned_sha256: ingestion.cleaned_sha256,
      published_sha256: publishedSha256,
      transformations: ingestion.transformations,
    });
  }
  return accepted;
}

export function isPublishedOutput(task, output, path) {
  return normalized(output.path_abs) === normalized(path);
}

export function ingestionDirectoryFor(task) {
  return dirname(outputIngestionReceiptPath(task, task.structured_outputs?.[0] ?? { path_abs: join(task.artifact_root_abs, 'output', 'result.json') }));
}
