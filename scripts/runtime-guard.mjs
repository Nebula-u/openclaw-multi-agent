#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { serializeJson } from './runtime-core/atomic-store.mjs';
import {
  createDispatchIntent,
  currentDispatchState,
  dispatchDirectory,
  dispatchIdempotencyKey,
  dispatchIsTerminal,
  loadDispatch,
  reconcileDispatch,
  recordCompletionReceipt,
  recordDeadLetter,
  recordDispatchReceipt,
  scanDispatches,
} from './runtime-core/dispatch-ledger.mjs';
import { createTaskRunArchive, taskRunArchivePath } from './runtime-core/task-run-store.mjs';
import { commitTransaction, recoverTransactions } from './runtime-core/transaction-store.mjs';
import { acquireWorkflowLock } from './runtime-core/workflow-lock.mjs';

const VALIDATOR_NAME = 'ajv';
const JSONL_MAX_BYTES = 5 * 1024 * 1024;
const JSONL_MAX_LINE_BYTES = 1024 * 1024;
const LOG_EXCERPT_LIMIT = 16 * 1024;
const ZERO_HASH = '0'.repeat(64);
const VALIDATOR_CACHE = new Map();
const APPROVAL_TRIGGERS = [
  'REQUIREMENT_AMBIGUITY', 'IMPLEMENTATION_TRADEOFF', 'PUBLIC_API_BREAKING_CHANGE',
  'IRREVERSIBLE_DATA_OP', 'NEEDS_INSTALL_OR_NETWORK', 'NEEDS_CREDENTIALS',
  'INPUT_NOT_GIT_REPO', 'INPUT_DIRTY_WORKTREE', 'CHANGE_APPROVED_REQ_OR_ARCH',
  'THIRDPARTY_LICENSE_UNCLEAR', 'SECURITY_RISK_ACCEPTANCE', 'TEST_OR_SECURITY_EXCEPTION',
  'RELEASE_HOLD_OVERRIDE', 'MAX_REWORK_EXCEEDED', 'DESTRUCTIVE_OR_CROSS_PROJECT',
];

function ajvOptions() {
  return {
    allErrors: true,
    strict: true,
    allowUnionTypes: true,
  };
}

function createAjv(schema) {
  const schemaDialect = schema?.$schema ?? '';
  const AjvClass = schemaDialect.includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new AjvClass(ajvOptions());
  addFormats(ajv);
  return ajv;
}

function compiledValidator(schema) {
  const cacheKey = createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex');
  if (!VALIDATOR_CACHE.has(cacheKey)) {
    VALIDATOR_CACHE.set(cacheKey, createAjv(schema).compile(schema));
  }
  return VALIDATOR_CACHE.get(cacheKey);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const name = token.slice(2);
    if (['jsonl', 'allow-placeholders'].includes(name)) {
      options[name] = true;
      continue;
    }
    if (![
      'schema',
      'file',
      'project-root',
      'events',
      'event',
      'runtime-root',
      'workflow-id',
      'log-file',
      'stage',
      'agent-id',
      'task-id',
      'task-file',
      'next-workflow',
      'next-active',
      'next-task',
      'expected-revision',
      'run-id',
      'attempt',
      'retry-count',
      'retry-prompt',
      'dispatch-id',
      'session-key',
      'session-id',
      'lease-seconds',
      'max-retries',
      'status',
      'input-manifest',
      'result-file',
      'error-code',
      'error-message',
      'reason',
      'last-error',
    ].includes(name)) {
      throw new Error(`unknown option: --${name}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  return { command, options };
}

function emit(payload, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = exitCode;
}

function issue(code, path, message) {
  return { code, path, message };
}

function ajvIssue(error) {
  const path = ajvInstancePath(error.instancePath);
  return {
    code: schemaErrorCode(error.keyword),
    path,
    message: error.message ?? `schema validation failed: ${error.keyword}`,
    schema_keyword: error.keyword,
    schema_path: error.schemaPath,
    params: error.params ?? {},
  };
}

function schemaErrorCode(keyword) {
  const map = {
    additionalProperties: 'SCHEMA_ADDITIONAL_PROPERTY',
    const: 'SCHEMA_CONST',
    enum: 'SCHEMA_ENUM',
    falseSchema: 'SCHEMA_FALSE',
    format: 'SCHEMA_FORMAT',
    minimum: 'SCHEMA_MINIMUM',
    minItems: 'SCHEMA_MIN_ITEMS',
    minLength: 'SCHEMA_MIN_LENGTH',
    pattern: 'SCHEMA_PATTERN',
    required: 'SCHEMA_REQUIRED',
    type: 'SCHEMA_TYPE',
    uniqueItems: 'SCHEMA_UNIQUE_ITEMS',
  };
  return map[keyword] ?? `SCHEMA_${String(keyword).replaceAll(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`;
}

function ajvInstancePath(instancePath) {
  if (!instancePath) return '$';
  return instancePath
    .split('/')
    .slice(1)
    .reduce((path, rawPart) => {
      const part = rawPart.replaceAll('~1', '/').replaceAll('~0', '~');
      if (/^(0|[1-9]\d*)$/u.test(part)) return `${path}[${part}]`;
      return `${path}.${part}`;
    }, '$');
}

function readJson(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    const failure = new Error(`cannot parse JSON: ${path}`);
    failure.guardIssue = issue('JSON_PARSE_ERROR', path, error.message);
    throw failure;
  }
}

function readJsonLines(path) {
  const text = readFileSync(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > JSONL_MAX_BYTES) {
    const failure = new Error(`JSONL exceeds ${JSONL_MAX_BYTES} bytes: ${path}`);
    failure.guardIssue = issue('JSONL_TOTAL_SIZE_EXCEEDED', path, 'JSONL exceeds the total size limit');
    throw failure;
  }
  const values = [];
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    if (!rawLine.trim()) continue;
    if (Buffer.byteLength(rawLine, 'utf8') > JSONL_MAX_LINE_BYTES) {
      const failure = new Error(`JSONL line exceeds ${JSONL_MAX_LINE_BYTES} bytes: ${path}:${index + 1}`);
      failure.guardIssue = issue('JSONL_LINE_SIZE_EXCEEDED', `${path}:${index + 1}`, 'JSONL line exceeds the size limit');
      throw failure;
    }
    try {
      values.push({ line: index + 1, value: JSON.parse(rawLine) });
    } catch (error) {
      const failure = new Error(`cannot parse JSONL: ${path}:${index + 1}`);
      failure.guardIssue = issue('JSON_PARSE_ERROR', `${path}:${index + 1}`, error.message);
      throw failure;
    }
  }
  return values;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findPlaceholders(value, path = '$', errors = []) {
  if (typeof value === 'string' && value.includes('<PLACEHOLDER:')) {
    errors.push(issue('RUNTIME_PLACEHOLDER', path, 'runtime artifact contains an unresolved placeholder'));
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`, errors));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      findPlaceholders(child, `${path}.${key}`, errors);
    }
  }
  return errors;
}

function validateInstance(value, schema, { allowPlaceholders = false } = {}) {
  const errors = [];
  try {
    const validate = compiledValidator(schema);
    if (!validate(value)) {
      errors.push(...(validate.errors ?? []).map(ajvIssue));
    }
  } catch (error) {
    errors.push(issue('SCHEMA_COMPILE_ERROR', '$', error.message));
  }
  if (!allowPlaceholders) findPlaceholders(value, '$', errors);
  return errors;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareUnicodeCodePoints)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function compareUnicodeCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
  }
  return leftPoints.length - rightPoints.length;
}

function eventHash(event) {
  const { event_hash: ignored, ...unsigned } = event;
  const canonical = canonicalJson(unsigned);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort(compareUnicodeCodePoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStringSet(left, right) {
  return equalJson(sortedUnique(left), sortedUnique(right));
}

function scopeKey(taskId, runId) {
  return `${taskId}\u0000${runId}`;
}

function validateEvidenceRefs(refs, available, source, errors, { required = false } = {}) {
  if (required && (!Array.isArray(refs) || refs.length === 0)) {
    errors.push(issue('GATE_EVIDENCE_REQUIRED', source, 'blocking PASS item requires evidence_refs'));
  }
  for (const reference of refs ?? []) {
    if (!available.has(reference)) errors.push(issue('EVIDENCE_REFERENCE_NOT_FOUND', source, `evidence reference is not available in scope: ${reference}`));
  }
}

function isRealPathWithin(root, candidate) {
  try {
    const normalizedRoot = realpathSync(root);
    const normalizedCandidate = realpathSync(candidate);
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
  } catch {
    return false;
  }
}

function isSameRealPath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function jsonFiles(path, suffix = '.json', errors = null) {
  if (!existsSync(path)) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.name.endsWith(suffix)) continue;
    const entryPath = join(path, entry.name);
    let metadata;
    try {
      metadata = lstatSync(entryPath);
    } catch (error) {
      errors?.push(issue('CONTROL_FILE_UNREADABLE', entryPath, error.message));
      continue;
    }
    if (metadata.isSymbolicLink()) {
      errors?.push(issue('CONTROL_FILE_SYMLINK', entryPath, 'control JSON files must not be symbolic links'));
      continue;
    }
    if (!metadata.isFile()) {
      errors?.push(issue('CONTROL_FILE_NOT_REGULAR', entryPath, 'control JSON entry must be a regular file'));
      continue;
    }
    files.push(entryPath);
  }
  return files.sort();
}

function validateTrustedRuntimeLayout(runtimeRoot, workflowId, errors) {
  let trustedRuntimeRoot;
  try {
    trustedRuntimeRoot = realpathSync(runtimeRoot);
  } catch (error) {
    errors.push(issue('RUNTIME_ROOT_UNREADABLE', runtimeRoot, error.message));
    return null;
  }
  for (const runtimeSubtree of [['control', 'workflows'], ['artifacts'], ['worktrees']]) {
    const subtreeRoot = join(runtimeRoot, ...runtimeSubtree);
    if (!isRealPathWithin(trustedRuntimeRoot, subtreeRoot)) {
      errors.push(issue('RUNTIME_ROOT_ESCAPE', subtreeRoot, `${runtimeSubtree.join(sep)} must resolve below the trusted runtime root`));
    }
  }
  const workflowRoot = join(runtimeRoot, 'control', 'workflows');
  const workflowDir = join(workflowRoot, workflowId);
  if (!isRealPathWithin(workflowRoot, workflowDir)) {
    errors.push(issue('WORKFLOW_DIR_ESCAPE', workflowDir, 'workflow directory must resolve inside runtime control/workflows'));
  }
  return workflowDir;
}

function rejectSymlink(path, errors, code = 'CONTROL_FILE_SYMLINK') {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      errors.push(issue(code, path, 'trusted runtime files must not be symbolic links'));
      return true;
    }
  } catch (error) {
    errors.push(issue('CONTROL_FILE_UNREADABLE', path, error.message));
    return true;
  }
  return false;
}

function nonEmptyFile(path) {
  try {
    return existsSync(path) && readFileSync(path, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateWorkflowSnapshots(workflow, workflowDir, errors) {
  const snapshots = [
    ['rules-snapshot.md', 'rules_snapshot_sha256'],
    ['context-summary.md', 'context_summary_sha256'],
  ];
  for (const [fileName, hashField] of snapshots) {
    const path = join(workflowDir, fileName);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      errors.push(issue('WORKFLOW_SNAPSHOT_SYMLINK', path, `${fileName} must not be a symbolic link`));
    } else if (!nonEmptyFile(path)) {
      errors.push(issue('WORKFLOW_SNAPSHOT_REQUIRED', path, `${fileName} must exist and be non-empty`));
    } else if (sha256File(path) !== workflow[hashField]) {
      errors.push(issue('WORKFLOW_SNAPSHOT_HASH_MISMATCH', path, `${fileName} does not match workflow ${hashField}`));
    }
  }
}

function validateTaskContext(task, taskFile, contextSchema, errors) {
  const inputRoot = join(task.artifact_root_abs, 'input');
  const expectedManifestPath = join(inputRoot, 'context-manifest.json');
  if (!isSameRealPath(task.context_manifest_path_abs, expectedManifestPath)) {
    errors.push(issue('CONTEXT_MANIFEST_PATH_MISMATCH', taskFile, 'task context_manifest_path_abs must be its canonical input/context-manifest.json'));
    return;
  }
  const manifest = readJsonForCheck(expectedManifestPath, errors);
  if (!manifest) return;
  addSchemaErrors(errors, manifest, contextSchema, expectedManifestPath);
  for (const field of ['workflow_id', 'task_id', 'run_id', 'assigned_agent', 'input_commit']) {
    if (!equalJson(manifest[field], task[field])) {
      errors.push(issue('CONTEXT_MANIFEST_ID_MISMATCH', `${expectedManifestPath}:${field}`, `context manifest ${field} does not match task`));
    }
  }
  if (!isSameRealPath(manifest.artifact_root_abs, task.artifact_root_abs)
    || !isSameRealPath(manifest.worktree_path_abs, task.worktree_path_abs)) {
    errors.push(issue('CONTEXT_MANIFEST_PATH_MISMATCH', expectedManifestPath, 'context manifest roots do not match task roots'));
  }
  const inputEntries = new Map();
  for (const entry of manifest.input_files ?? []) {
    if (!isAbsolute(entry.path_abs) || !isRealPathWithin(inputRoot, entry.path_abs)) {
      errors.push(issue('CONTEXT_INPUT_PATH_ESCAPE', expectedManifestPath, `context input path escapes input root: ${entry.path_abs}`));
      continue;
    }
    if (inputEntries.has(entry.path_abs)) {
      errors.push(issue('DUPLICATE_CONTEXT_INPUT', expectedManifestPath, `duplicate context input: ${entry.path_abs}`));
      continue;
    }
    inputEntries.set(entry.path_abs, entry);
    if (!existsSync(entry.path_abs)) {
      errors.push(issue('CONTEXT_INPUT_MISSING', entry.path_abs, 'context manifest references a missing input file'));
    } else if (sha256File(entry.path_abs) !== entry.sha256) {
      errors.push(issue('CONTEXT_INPUT_HASH_MISMATCH', entry.path_abs, 'context input SHA-256 does not match manifest'));
    }
  }
  const requiredInputs = ['task.json', 'context.md', 'rules.md', 'acceptance-criteria.json', 'approved-decisions.json', 'source-manifest.json'];
  for (const fileName of requiredInputs) {
    const path = join(inputRoot, fileName);
    if (!inputEntries.has(path)) {
      errors.push(issue('CONTEXT_INPUT_REQUIRED', expectedManifestPath, `context manifest is missing ${fileName}`));
    }
  }
  const rulesPath = join(inputRoot, 'rules.md');
  if (inputEntries.has(rulesPath) && existsSync(rulesPath) && sha256File(rulesPath) !== manifest.rule_hash) {
    errors.push(issue('RULE_HASH_MISMATCH', expectedManifestPath, 'rule_hash must equal the SHA-256 of input/rules.md'));
  }
  const inputTaskPath = join(inputRoot, 'task.json');
  const inputTask = readJsonForCheck(inputTaskPath, errors);
  if (inputTask) {
    for (const field of ['workflow_id', 'task_id', 'run_id', 'assigned_agent']) {
      if (!equalJson(inputTask[field], task[field])) {
        errors.push(issue('CONTEXT_TASK_MISMATCH', `${inputTaskPath}:${field}`, `input task ${field} does not match control task`));
      }
    }
  }
}

function isPathLexicallyWithin(root, candidate) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function validateTaskPaths(task, taskFile, workflow, errors) {
  const runtimeArtifactsRoot = join(workflow.runtime_root_abs, 'artifacts');
  const workflowArtifactsRoot = join(runtimeArtifactsRoot, workflow.workflow_id);
  const expectedArtifactRoot = join(workflowArtifactsRoot, task.task_id, task.run_id);
  if (!isRealPathWithin(runtimeArtifactsRoot, workflowArtifactsRoot)
    || !isRealPathWithin(workflowArtifactsRoot, expectedArtifactRoot)
    || !isSameRealPath(expectedArtifactRoot, task.artifact_root_abs)) {
    errors.push(issue('ARTIFACT_PATH_ESCAPE', taskFile, 'artifact_root_abs must exactly resolve to this workflow/task/run artifact directory'));
  }
  const expectedWorktree = join(workflow.runtime_root_abs, 'worktrees', workflow.workflow_id, task.task_id, task.run_id, 'repo');
  if (!isRealPathWithin(join(workflow.runtime_root_abs, 'worktrees'), expectedWorktree)
    || !isSameRealPath(expectedWorktree, task.worktree_path_abs)) {
    errors.push(issue('WORKTREE_PATH_ESCAPE', taskFile, 'worktree_path_abs must exactly resolve to this workflow/task/run worktree without symlink escape'));
  }
}

function artifactRunKeys(runtimeRoot, workflowId) {
  const workflowRoot = join(runtimeRoot, 'artifacts', workflowId);
  if (!existsSync(workflowRoot)) return [];
  const runs = [];
  for (const taskEntry of readdirSync(workflowRoot, { withFileTypes: true })) {
    if (!taskEntry.isDirectory()) continue;
    const taskRoot = join(workflowRoot, taskEntry.name);
    for (const runEntry of readdirSync(taskRoot, { withFileTypes: true })) {
      if (!runEntry.isDirectory()) continue;
      runs.push({
        task_id: taskEntry.name,
        run_id: runEntry.name,
        path: join(taskRoot, runEntry.name),
      });
    }
  }
  return runs;
}

function taskRequiresArtifact(task) {
  return ['DISPATCHED', 'RUNNING', 'WAITING_HUMAN', 'BLOCKED', 'NEEDS_REWORK', 'COMPLETED', 'FAILED', 'LOST'].includes(task.status);
}

function addSchemaErrors(errors, value, schema, source, options = {}) {
  const before = errors.length;
  for (const error of validateInstance(value, schema, options)) {
    errors.push({ ...error, source });
  }
  return errors.length === before;
}

function redactSensitiveExcerpt(content) {
  return content
    .replaceAll(/((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)[^\s,;"']+/giu, '$1<REDACTED>')
    .replaceAll(/(bearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1<REDACTED>')
    .slice(0, LOG_EXCERPT_LIMIT);
}

function validateStructuredOutputs(task, taskFile, projectRoot, errors) {
  const outputRoot = join(task.artifact_root_abs, 'output');
  const contractsRoot = join(projectRoot, 'contracts');
  const seenPaths = new Set();
  const policy = readJsonForCheck(join(projectRoot, 'config', 'task-output-contracts.json'), errors);
  if (task.output_contract_version === policy?.schema_version) {
    const taskPolicy = policy.task_types?.[task.task_type];
    if (taskPolicy && taskPolicy.agent !== task.assigned_agent) {
      errors.push(issue('TASK_OUTPUT_CONTRACT_AGENT_MISMATCH', taskFile, 'task type must be assigned to its configured agent'));
    }
    for (const required of policy.defaults?.required ?? []) {
      const expectedPath = join(outputRoot, required.relative_path);
      const matches = (task.structured_outputs ?? []).some((entry) => entry.path_abs === expectedPath
        && entry.schema_path_abs === join(contractsRoot, required.schema) && entry.format === required.format && entry.required);
      if (!matches) errors.push(issue('TASK_OUTPUT_CONTRACT_MISSING', taskFile, `missing required output declaration: ${required.relative_path}`));
    }
  }
  for (const entry of task.structured_outputs ?? []) {
    if (entry.producer !== task.assigned_agent) {
      errors.push(issue('STRUCTURED_OUTPUT_PRODUCER_MISMATCH', taskFile, `structured output producer must equal assigned_agent: ${entry.path_abs}`));
    }
    if (!isAbsolute(entry.path_abs) || !isPathLexicallyWithin(outputRoot, entry.path_abs)
      || (existsSync(entry.path_abs) && !isRealPathWithin(outputRoot, entry.path_abs))) {
      errors.push(issue('STRUCTURED_OUTPUT_PATH_ESCAPE', taskFile, `structured output must exist under artifact output: ${entry.path_abs}`));
      continue;
    }
    if (seenPaths.has(entry.path_abs)) {
      errors.push(issue('DUPLICATE_STRUCTURED_OUTPUT', taskFile, `structured output is declared more than once: ${entry.path_abs}`));
      continue;
    }
    seenPaths.add(entry.path_abs);
    if (!isAbsolute(entry.schema_path_abs) || !isRealPathWithin(contractsRoot, entry.schema_path_abs)) {
      errors.push(issue('STRUCTURED_OUTPUT_SCHEMA_ESCAPE', taskFile, `structured output schema must exist under contracts: ${entry.schema_path_abs}`));
      continue;
    }
    if (!existsSync(entry.path_abs)) {
      if (task.status === 'COMPLETED' && entry.required) {
        errors.push(issue('STRUCTURED_OUTPUT_REQUIRED', entry.path_abs, 'completed task is missing a required structured output'));
      }
      continue;
    }
    const schema = readJsonForCheck(entry.schema_path_abs, errors);
    if (!schema) continue;
    const records = entry.format === 'jsonl'
      ? readJsonLinesForCheck(entry.path_abs, errors)
      : [{ line: null, value: readJsonForCheck(entry.path_abs, errors) }];
    if (entry.format === 'jsonl' && records.length === 0) {
      errors.push(issue('JSONL_EMPTY', entry.path_abs, 'declared JSONL output must contain at least one record'));
    }
    const idField = entry.schema_path_abs.endsWith('evidence.schema.json') ? 'evidence_id'
      : entry.schema_path_abs.endsWith('command-record.schema.json') ? 'command_record_id' : null;
    const ids = new Set();
    for (const record of records) {
      if (record.value === null) continue;
      addSchemaErrors(errors, record.value, schema, record.line ? `${entry.path_abs}:${record.line}` : entry.path_abs);
      if (idField && typeof record.value[idField] === 'string') {
        if (ids.has(record.value[idField])) errors.push(issue('JSONL_DUPLICATE_ID', `${entry.path_abs}:${record.line}`, `${idField} must be unique within JSONL`));
        ids.add(record.value[idField]);
      }
    }
  }
}

function validationFailureRecord({ options, schemaPath, filePath, errors }) {
  let rawContent = '';
  try {
    rawContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  } catch {
    rawContent = '';
  }
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    stage: options.stage ?? 'unspecified',
    agent_id: options['agent-id'] ?? null,
    workflow_id: options['workflow-id'] ?? null,
    task_id: options['task-id'] ?? null,
    run_id: options['run-id'] ?? null,
    attempt: options.attempt === undefined ? null : Number(options.attempt),
    file_path_abs: resolve(filePath),
    schema_path_abs: resolve(schemaPath),
    validator: VALIDATOR_NAME,
    validator_errors: errors,
    invalid_content_sha256: createHash('sha256').update(rawContent, 'utf8').digest('hex'),
    invalid_content_excerpt: redactSensitiveExcerpt(rawContent),
    retry_count: options['retry-count'] === undefined ? 0 : Number(options['retry-count']),
    retry_prompt_path_abs: options['retry-prompt'] ? resolve(options['retry-prompt']) : null,
    final_status: 'FAILED',
  };
}

function appendValidationFailureLog(options, schemaPath, filePath, errors) {
  if (!options['log-file']) return;
  const logPath = resolve(options['log-file']);
  appendFileSync(logPath, `${JSON.stringify(validationFailureRecord({
    options,
    schemaPath,
    filePath,
    errors,
  }))}\n`, 'utf8');
}

function appendGuardFailureLog(options, subjectPath, errors) {
  if (!options['log-file']) return;
  appendValidationFailureLog(options, subjectPath, subjectPath, errors);
}

function readJsonForCheck(path, errors) {
  try {
    return readJson(path);
  } catch (error) {
    errors.push(error.guardIssue ?? issue('JSON_READ_ERROR', path, error.message));
    return null;
  }
}

function readJsonLinesForCheck(path, errors) {
  try {
    return readJsonLines(path);
  } catch (error) {
    errors.push(error.guardIssue ?? issue('JSON_READ_ERROR', path, error.message));
    return [];
  }
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`missing required option --${name}`);
  return options[name];
}

function validateFileCommand(options) {
  const schemaPath = requireOption(options, 'schema');
  const filePath = requireOption(options, 'file');
  const errors = [];
  let schema;
  let records;
  try {
    schema = readJson(schemaPath);
    records = options.jsonl ? readJsonLines(filePath) : [{ line: null, value: readJson(filePath) }];
  } catch (error) {
    const parseIssue = error.guardIssue ?? issue('JSON_READ_ERROR', filePath, error.message);
    appendValidationFailureLog(options, schemaPath, filePath, [parseIssue]);
    emit({ ok: false, command: 'validate-file', file: filePath, validator: VALIDATOR_NAME, errors: [parseIssue] }, 1);
    return;
  }
  if (options.jsonl && records.length === 0) {
    errors.push(issue('JSONL_EMPTY', filePath, 'JSONL input must contain at least one record'));
  }
  const idField = schemaPath.endsWith('evidence.schema.json') ? 'evidence_id'
    : schemaPath.endsWith('command-record.schema.json') ? 'command_record_id' : null;
  const ids = new Set();
  for (const record of records) {
    const recordErrors = validateInstance(record.value, schema, {
      allowPlaceholders: Boolean(options['allow-placeholders']),
    });
    for (const error of recordErrors) {
      errors.push({
        ...error,
        path: record.line ? `${filePath}:${record.line}${error.path.slice(1)}` : error.path,
      });
    }
    if (idField && typeof record.value[idField] === 'string') {
      if (ids.has(record.value[idField])) errors.push(issue('JSONL_DUPLICATE_ID', `${filePath}:${record.line}`, `${idField} must be unique within JSONL`));
      ids.add(record.value[idField]);
    }
  }
  if (errors.length > 0) {
    appendValidationFailureLog(options, schemaPath, filePath, errors);
    emit({ ok: false, command: 'validate-file', file: filePath, validator: VALIDATOR_NAME, errors }, 1);
    return;
  }
  emit({ ok: true, command: 'validate-file', file: filePath, validator: VALIDATOR_NAME, records: records.length });
}

function appendEventCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const eventsPath = resolve(requireOption(options, 'events'));
  const draftPath = resolve(requireOption(options, 'event'));
  const eventSchema = readJson(join(projectRoot, 'contracts', 'workflow-event.schema.json'));
  const draft = readJson(draftPath);
  const machine = readJson(join(projectRoot, 'config', 'workflow-state-machine.json'));
  const lockPath = `${eventsPath}.lock`;
  let lock;
  try {
    try {
      lock = acquireWorkflowLock(lockPath, { purpose: 'append-event' });
    } catch (error) {
      error.guardIssue = issue(
        error.code === 'WORKFLOW_LOCK_CONFLICT' ? 'EVENT_LOCK_CONFLICT' : 'EVENT_LOCK_ERROR',
        lockPath,
        error.code === 'WORKFLOW_LOCK_CONFLICT' ? 'events chain is already locked' : error.message,
      );
      throw error;
    }
    const existing = existsSync(eventsPath) ? readJsonLines(eventsPath).map((record) => record.value) : [];
    const previous = existing.at(-1) ?? null;
    const event = {
      ...draft,
      schema_version: 1,
      seq: existing.length + 1,
      state_revision: existing.length + 1,
      previous_event_hash: previous?.event_hash ?? '0'.repeat(64),
    };
    delete event.event_hash;
    event.event_hash = eventHash(event);
    const errors = [];
    validateStateMachine(machine, errors);
    validateEventChain([...existing, event], {
      workflow_id: event.workflow_id,
      status: event.to_status,
      current_phase: event.to_phase,
      current_candidate_commit: event.candidate_commit,
      state_revision: event.state_revision,
    }, machine, eventSchema, errors);
    if (errors.length > 0) {
      appendGuardFailureLog(options, draftPath, errors);
      emit({ ok: false, command: 'append-event', effective_status: 'HOLD', errors }, 1);
      return;
    }
    const descriptor = openSync(eventsPath, 'a');
    try {
    appendFileSync(descriptor, `${JSON.stringify(event)}\n`, 'utf8');
    fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    emit({ ok: true, command: 'append-event', event });
  } finally {
    lock?.release();
  }
}

function parseRevisionOption(options, name = 'expected-revision') {
  const raw = options[name];
  if (raw === undefined) return null;
  if (!/^\d+$/u.test(String(raw))) throw new Error(`--${name} must be a non-negative integer`);
  return Number(raw);
}

function transactionError(code, path, message) {
  const error = new Error(message);
  error.guardIssue = issue(code, path, message);
  return error;
}

function transactionPath(workflowDir, fileName) {
  return join(workflowDir, fileName);
}

function safeReadJson(path, label) {
  try {
    return readJson(path);
  } catch (error) {
    throw transactionError('TRANSACTION_INPUT_INVALID', path, `${label}: ${error.message}`);
  }
}

function eventChainText(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function validateActiveSnapshotForTransition(active, workflow, workflowPath, activePath, machine, errors) {
  const activeEntries = (active.workflows ?? []).filter((entry) => entry.workflow_id === workflow.workflow_id);
  const terminal = new Set(machine.workflow?.terminal_statuses ?? []).has(workflow.status);
  if (terminal && activeEntries.length !== 0) {
    errors.push(issue('TERMINAL_ACTIVE_WORKFLOW_ENTRY', activePath, 'terminal workflow must have zero active entries'));
  } else if (!terminal && activeEntries.length !== 1) {
    errors.push(issue('ACTIVE_WORKFLOW_ENTRY_COUNT', activePath, 'nonterminal workflow requires one active entry'));
  }
  if (terminal) return;
  const entry = activeEntries[0];
  if (!entry) return;
  for (const field of ['status', 'current_phase', 'current_candidate_commit', 'state_revision', 'updated_at']) {
    if (!equalJson(entry[field], workflow[field])) {
      errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:${field}`, `active entry does not match next workflow ${field}`));
    }
  }
  if (resolve(entry.workflow_json_abs) !== resolve(workflowPath)) {
    errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:workflow_json_abs`, 'active entry must point to workflow.json'));
  }
}

function validateTransitionTask(nextTask, taskPath, workflow, event, taskSchema, errors) {
  if (!nextTask) return false;
  const valid = addSchemaErrors(errors, nextTask, taskSchema, taskPath);
  if (!valid) return false;
  if (nextTask.workflow_id !== workflow.workflow_id) {
    errors.push(issue('TASK_WORKFLOW_MISMATCH', taskPath, 'next task workflow_id does not match workflow'));
  }
  if (event.task_id !== nextTask.task_id || event.run_id !== nextTask.run_id) {
    errors.push(issue('TASK_EVENT_SCOPE_MISMATCH', taskPath, 'next task must match event task_id and run_id'));
  }
  if (event.task_status_after !== nextTask.status) {
    errors.push(issue('TASK_EVENT_MISMATCH', taskPath, 'next task status must match event task_status_after'));
  }
  const expectedPath = transactionPath(join(workflow.runtime_root_abs, 'control', 'workflows', workflow.workflow_id), 'tasks');
  if (resolve(taskPath) !== resolve(join(expectedPath, `${nextTask.task_id}.json`))) {
    errors.push(issue('TASK_CONTROL_PATH_MISMATCH', taskPath, 'next task must be written to its canonical control task path'));
  }
  return true;
}

function prepareTaskRunOperations({ workflowDir, expectedRevision, event, currentTask, nextTask, errors }) {
  const operations = [];
  const archives = new Map();
  const addArchive = (task, revision) => {
    if (!task) return;
    const path = taskRunArchivePath(workflowDir, task.task_id, task.run_id);
    const archive = createTaskRunArchive(task, revision, event.timestamp);
    const serialized = serializeJson(archive);
    if (existsSync(path)) {
      try {
        const existing = readJson(path);
        if (existing.task_snapshot_sha256 !== archive.task_snapshot_sha256) {
          errors.push(issue('TASK_RUN_ARCHIVE_IMMUTABLE', path, 'immutable task run archive already exists with different content'));
        }
      } catch (error) {
        errors.push(issue('TASK_RUN_ARCHIVE_INVALID', path, error.message));
      }
      return;
    }
    if (!archives.has(path)) {
      archives.set(path, true);
      operations.push({ kind: 'task-run-history', targetPath: path, content: serialized });
    }
  };
  if (currentTask && nextTask && currentTask.run_id !== nextTask.run_id) addArchive(currentTask, expectedRevision);
  if (nextTask && ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(nextTask.status)) addArchive(nextTask, expectedRevision + 1);
  return operations;
}

function commitTransitionCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  const eventDraftPath = resolve(requireOption(options, 'event'));
  const nextWorkflowPath = resolve(requireOption(options, 'next-workflow'));
  const nextActivePath = resolve(requireOption(options, 'next-active'));
  const nextTaskPath = options['next-task'] ? resolve(options['next-task']) : null;
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier')] }, 1);
    return;
  }
  const layoutErrors = [];
  const workflowDir = validateTrustedRuntimeLayout(runtimeRoot, workflowId, layoutErrors);
  if (!workflowDir || layoutErrors.length > 0) {
    emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors: layoutErrors.length > 0 ? layoutErrors : [issue('RUNTIME_ROOT_UNREADABLE', runtimeRoot, 'runtime root is not readable')] }, 1);
    return;
  }
  const workflowPath = join(workflowDir, 'workflow.json');
  const activePath = join(runtimeRoot, 'control', 'active-workflows.json');
  const eventsPath = join(workflowDir, 'events.jsonl');
  const lockPath = join(workflowDir, '.workflow.lock');
  let lock;
  try {
    lock = acquireWorkflowLock(lockPath, { purpose: 'commit-transition' });
    const recoveredTransactions = recoverTransactions(workflowDir);
    const errors = [];
    const workflowSchema = safeReadJson(join(projectRoot, 'contracts', 'workflow.schema.json'), 'workflow schema');
    const activeSchema = safeReadJson(join(projectRoot, 'contracts', 'active-workflows.schema.json'), 'active workflow schema');
    const eventSchema = safeReadJson(join(projectRoot, 'contracts', 'workflow-event.schema.json'), 'workflow event schema');
    const taskSchema = safeReadJson(join(projectRoot, 'contracts', 'task.schema.json'), 'task schema');
    const contextSchema = safeReadJson(join(projectRoot, 'contracts', 'context-manifest.schema.json'), 'context manifest schema');
    const machine = safeReadJson(join(projectRoot, 'config', 'workflow-state-machine.json'), 'workflow state machine');
    validateStateMachine(machine, errors);
    const expectedRevisionOption = parseRevisionOption(options);
    const currentWorkflow = existsSync(workflowPath) ? safeReadJson(workflowPath, 'current workflow') : null;
    const currentActive = existsSync(activePath) ? safeReadJson(activePath, 'current active index') : null;
    const currentEvents = existsSync(eventsPath) ? readJsonLines(eventsPath).map((record) => record.value) : [];
    const nextWorkflow = safeReadJson(nextWorkflowPath, 'next workflow');
    const nextActive = safeReadJson(nextActivePath, 'next active index');
    const eventDraft = safeReadJson(eventDraftPath, 'event draft');
    const nextTask = nextTaskPath ? safeReadJson(nextTaskPath, 'next task') : null;
    const taskPath = nextTask && typeof nextTask.task_id === 'string'
      ? join(workflowDir, 'tasks', `${nextTask.task_id}.json`)
      : null;
    const currentTask = taskPath && existsSync(taskPath)
      ? safeReadJson(taskPath, 'current task')
      : null;
    const expectedRevision = expectedRevisionOption ?? currentWorkflow?.state_revision ?? 0;
    if (currentWorkflow) {
      const currentWorkflowValid = addSchemaErrors(errors, currentWorkflow, workflowSchema, workflowPath);
      if (!currentWorkflowValid) {
        appendGuardFailureLog(options, workflowPath, errors);
        emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
        return;
      }
      if (currentWorkflow.workflow_id !== workflowId) errors.push(issue('WORKFLOW_ID_MISMATCH', workflowPath, 'current workflow_id does not match requested workflow'));
      if (currentWorkflow.state_revision !== expectedRevision) errors.push(issue('STATE_REVISION_CONFLICT', '$.state_revision', `expected ${expectedRevision}, found ${currentWorkflow.state_revision}`));
    } else if (expectedRevision !== 0) {
      errors.push(issue('STATE_REVISION_CONFLICT', '$.state_revision', 'new workflow transition must start at revision 0'));
    }
    const nextWorkflowValid = addSchemaErrors(errors, nextWorkflow, workflowSchema, nextWorkflowPath);
    const nextActiveValid = addSchemaErrors(errors, nextActive, activeSchema, nextActivePath);
    if (!nextWorkflowValid || !nextActiveValid) {
      appendGuardFailureLog(options, nextWorkflowPath, errors);
      emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    if (nextWorkflow.workflow_id !== workflowId) errors.push(issue('WORKFLOW_ID_MISMATCH', nextWorkflowPath, 'next workflow_id does not match requested workflow'));
    if (nextWorkflow.state_revision !== expectedRevision + 1) errors.push(issue('STATE_REVISION_CONFLICT', nextWorkflowPath, `next workflow state_revision must be ${expectedRevision + 1}`));
    if (currentWorkflow) {
      for (const field of ['target_project_root_abs', 'runtime_root_abs', 'integration_branch', 'base_commit', 'created_at']) {
        if (!equalJson(currentWorkflow[field], nextWorkflow[field])) errors.push(issue('WORKFLOW_IMMUTABLE_FIELD_CHANGED', `${nextWorkflowPath}:${field}`, `${field} cannot change during a transition`));
      }
    }
    const event = {
      ...eventDraft,
      schema_version: 1,
      seq: expectedRevision + 1,
      state_revision: expectedRevision + 1,
      previous_event_hash: currentEvents.at(-1)?.event_hash ?? ZERO_HASH,
    };
    delete event.event_hash;
    event.event_hash = eventHash(event);
    const eventValid = addSchemaErrors(errors, event, eventSchema, eventDraftPath);
    if (!eventValid) {
      appendGuardFailureLog(options, eventDraftPath, errors);
      emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    if (event.workflow_id !== workflowId) errors.push(issue('EVENT_WORKFLOW_MISMATCH', eventDraftPath, 'event workflow_id does not match requested workflow'));
    if (event.to_status !== nextWorkflow.status || event.to_phase !== nextWorkflow.current_phase
      || event.candidate_commit !== nextWorkflow.current_candidate_commit) {
      errors.push(issue('TRANSITION_SNAPSHOT_MISMATCH', nextWorkflowPath, 'next workflow status, phase and candidate must match event'));
    }
    if (nextWorkflow.updated_at !== event.timestamp) errors.push(issue('TRANSITION_TIMESTAMP_MISMATCH', nextWorkflowPath, 'next workflow updated_at must equal event timestamp'));
    validateEventChain([...currentEvents, event], {
      workflow_id: workflowId,
      status: nextWorkflow.status,
      current_phase: nextWorkflow.current_phase,
      current_candidate_commit: nextWorkflow.current_candidate_commit,
      state_revision: nextWorkflow.state_revision,
    }, machine, eventSchema, errors);
    if (currentActive && !addSchemaErrors(errors, currentActive, activeSchema, activePath)) {
      appendGuardFailureLog(options, activePath, errors);
      emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    validateActiveSnapshotForTransition(nextActive, nextWorkflow, workflowPath, activePath, machine, errors);
    if (nextTask) {
      const nextTaskValid = validateTransitionTask(nextTask, taskPath, nextWorkflow, event, taskSchema, errors);
      if (nextTaskValid) {
        validateTaskPaths(nextTask, taskPath, nextWorkflow, errors);
        if (nextTask.status !== 'CREATED') validateTaskContext(nextTask, taskPath, contextSchema, errors);
      }
      if (currentTask) {
        const currentTaskValid = addSchemaErrors(errors, currentTask, taskSchema, taskPath);
        if (currentTaskValid && currentTask.workflow_id !== nextWorkflow.workflow_id) errors.push(issue('TASK_WORKFLOW_MISMATCH', taskPath, 'current task workflow mismatch'));
      }
    } else if (event.task_id !== null || event.run_id !== null || event.task_status_after !== null) {
      errors.push(issue('TASK_SNAPSHOT_REQUIRED', nextTaskPath ?? '$.next-task', 'task transition requires --next-task'));
    }
    if (!nextWorkflow.task_ids.includes(nextTask?.task_id ?? event.task_id ?? '__none__') && nextTask) {
      errors.push(issue('WORKFLOW_TASK_REFERENCE_MISSING', nextWorkflowPath, 'next workflow task_ids must include next task'));
    }
    if (errors.length > 0) {
      appendGuardFailureLog(options, nextWorkflowPath, errors);
      emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    const taskRunOperations = prepareTaskRunOperations({ workflowDir, expectedRevision, event, currentTask, nextTask, errors });
    if (errors.length > 0) {
      appendGuardFailureLog(options, nextWorkflowPath, errors);
      emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    const operations = [
      { kind: 'event-chain', targetPath: eventsPath, content: eventChainText([...currentEvents, event]) },
      ...taskRunOperations,
      ...(nextTask ? [{ kind: 'task-current', targetPath: taskPath, content: serializeJson(nextTask) }] : []),
      { kind: 'workflow', targetPath: workflowPath, content: serializeJson(nextWorkflow) },
      { kind: 'active-index', targetPath: activePath, content: serializeJson(nextActive) },
    ];
    const transaction = commitTransaction({
      workflowDir,
      workflowId,
      expectedRevision,
      targetRevision: nextWorkflow.state_revision,
      ownerNonce: lock.owner.nonce,
      operations,
    });
    emit({
      ok: true,
      command: 'commit-transition',
      workflow_id: workflowId,
      state_revision: nextWorkflow.state_revision,
      event: transaction.operations.find((operation) => operation.kind === 'event-chain') ? event : null,
      transaction_id: transaction.transaction_id,
      recovered_transactions: recoveredTransactions,
    });
  } catch (error) {
    const guardIssue = error.guardIssue ?? issue(
      error.code === 'WORKFLOW_LOCK_CONFLICT' ? 'WORKFLOW_LOCK_CONFLICT'
        : String(error.code ?? '').startsWith('TRANSACTION_') ? error.code
          : 'TRANSACTION_COMMIT_FAILED',
      error.code === 'WORKFLOW_LOCK_CONFLICT' ? lockPath : workflowDir,
      error.message,
    );
    emit({ ok: false, command: 'commit-transition', workflow_id: workflowId, effective_status: 'HOLD', errors: [guardIssue] }, 1);
  } finally {
    lock?.release();
  }
}

function recoverTransactionsCommand(options) {
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    emit({ ok: false, command: 'recover-transactions', effective_status: 'HOLD', errors: [issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier')] }, 1);
    return;
  }
  const layoutErrors = [];
  const workflowDir = validateTrustedRuntimeLayout(runtimeRoot, workflowId, layoutErrors);
  if (!workflowDir || layoutErrors.length > 0) {
    emit({ ok: false, command: 'recover-transactions', workflow_id: workflowId, effective_status: 'HOLD', errors: layoutErrors }, 1);
    return;
  }
  let lock;
  try {
    lock = acquireWorkflowLock(join(workflowDir, '.workflow.lock'), { purpose: 'recover-transactions' });
    const recovered = recoverTransactions(workflowDir);
    emit({ ok: true, command: 'recover-transactions', workflow_id: workflowId, recovered_transactions: recovered });
  } catch (error) {
    const guardIssue = error.guardIssue ?? issue(
      error.code === 'WORKFLOW_LOCK_CONFLICT' ? 'WORKFLOW_LOCK_CONFLICT'
        : String(error.code ?? '').startsWith('TRANSACTION_') ? error.code
          : 'TRANSACTION_RECOVERY_FAILED',
      workflowDir,
      error.message,
    );
    emit({ ok: false, command: 'recover-transactions', workflow_id: workflowId, effective_status: 'HOLD', errors: [guardIssue] }, 1);
  } finally {
    lock?.release();
  }
}

function parseIntegerOption(options, name, { defaultValue = null, minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (options[name] === undefined) return defaultValue;
  if (!/^\d+$/u.test(String(options[name]))) throw new Error(`--${name} must be an integer`);
  const value = Number(options[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function dispatchCommandLayout(options, command) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  const errors = [];
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    errors.push(issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier'));
  }
  const workflowDir = errors.length === 0 ? validateTrustedRuntimeLayout(runtimeRoot, workflowId, errors) : null;
  if (!workflowDir || errors.length > 0) {
    emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
    return null;
  }
  return { projectRoot, runtimeRoot, workflowId, workflowDir };
}

function emitDispatchCommandError(command, workflowId, error, fallbackPath) {
  const code = String(error.code ?? '').startsWith('DISPATCH_') || error.code === 'WORKFLOW_LOCK_CONFLICT'
    ? error.code
    : 'DISPATCH_LEDGER_ERROR';
  emit({
    ok: false,
    command,
    workflow_id: workflowId,
    effective_status: 'HOLD',
    errors: [error.guardIssue ?? issue(code, error.path ?? fallbackPath, error.message)],
  }, 1);
}

function requireSafeDispatchId(options) {
  const dispatchId = requireOption(options, 'dispatch-id');
  if (!/^DSP-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(dispatchId)) {
    throw transactionError('DISPATCH_ID_INVALID', '$.dispatch-id', 'dispatch-id must be a complete safe DSP identifier');
  }
  return dispatchId;
}

function dispatchContractErrors(record, projectRoot) {
  const errors = [];
  const mappings = [
    [record.intent, 'dispatch-intent.schema.json', join(record.directory, 'intent.json')],
    ...record.receipts.map((receipt, index) => [receipt, 'dispatch-receipt.schema.json', `${join(record.directory, 'receipts.jsonl')}:${index + 1}`]),
    ...(record.completion ? [[record.completion, 'completion-receipt.schema.json', join(record.directory, 'completion-receipt.json')]] : []),
    ...(record.dead_letter ? [[record.dead_letter, 'dead-letter.schema.json', join(record.directory, 'dead-letter.json')]] : []),
  ];
  for (const [value, schemaName, source] of mappings) {
    addSchemaErrors(errors, value, readJson(join(projectRoot, 'contracts', schemaName)), source);
  }
  return errors;
}

function emitDispatchContractFailure(command, workflowId, dispatchId, errors) {
  emit({ ok: false, command, workflow_id: workflowId, dispatch_id: dispatchId, effective_status: 'HOLD', errors }, 1);
}

function prepareDispatchCommand(options) {
  const layout = dispatchCommandLayout(options, 'prepare-dispatch');
  if (!layout) return;
  const { projectRoot, runtimeRoot, workflowId, workflowDir } = layout;
  const taskId = requireOption(options, 'task-id');
  const runId = requireOption(options, 'run-id');
  const agentId = requireOption(options, 'agent-id');
  const taskFile = resolve(requireOption(options, 'task-file'));
  const sessionKey = requireOption(options, 'session-key');
  const requestedAttempt = parseIntegerOption(options, 'attempt', { minimum: 1 });
  const leaseSeconds = parseIntegerOption(options, 'lease-seconds', { defaultValue: 900, minimum: 30, maximum: 86400 });
  let lock;
  try {
    lock = acquireWorkflowLock(join(workflowDir, '.workflow.lock'), { purpose: 'prepare-dispatch' });
    const recoveredTransactions = recoverTransactions(workflowDir);
    const errors = [];
    const workflowPath = join(workflowDir, 'workflow.json');
    const expectedTaskFile = join(workflowDir, 'tasks', `${taskId}.json`);
    if (!isSameRealPath(taskFile, expectedTaskFile)) errors.push(issue('TASK_CONTROL_PATH_MISMATCH', taskFile, 'task-file must be the canonical current task snapshot'));
    const workflow = readJsonForCheck(workflowPath, errors);
    const task = readJsonForCheck(taskFile, errors);
    if (!workflow || !task) {
      emit({ ok: false, command: 'prepare-dispatch', workflow_id: workflowId, task_id: taskId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    const workflowSchema = readJson(join(projectRoot, 'contracts', 'workflow.schema.json'));
    const taskSchema = readJson(join(projectRoot, 'contracts', 'task.schema.json'));
    const contextSchema = readJson(join(projectRoot, 'contracts', 'context-manifest.schema.json'));
    const workflowValid = addSchemaErrors(errors, workflow, workflowSchema, workflowPath);
    const taskValid = addSchemaErrors(errors, task, taskSchema, taskFile);
    if (!workflowValid || !taskValid) {
      emit({ ok: false, command: 'prepare-dispatch', workflow_id: workflowId, task_id: taskId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    for (const [field, expected, actual] of [
      ['workflow_id', workflowId, task.workflow_id],
      ['task_id', taskId, task.task_id],
      ['run_id', runId, task.run_id],
      ['assigned_agent', agentId, task.assigned_agent],
      ['attempt', requestedAttempt, task.attempt],
    ]) {
      if (!equalJson(expected, actual)) errors.push(issue('DISPATCH_TASK_SCOPE_MISMATCH', `${taskFile}:${field}`, `requested ${field} does not match task`));
    }
    if (task.status !== 'READY') errors.push(issue('DISPATCH_TASK_NOT_READY', taskFile, `task must be READY before dispatch, found ${task.status}`));
    validateTaskPaths(task, taskFile, workflow, errors);
    validateTaskContext(task, taskFile, contextSchema, errors);
    const inputManifestPath = resolve(options['input-manifest'] ?? task.context_manifest_path_abs);
    if (!isSameRealPath(inputManifestPath, task.context_manifest_path_abs)) {
      errors.push(issue('DISPATCH_INPUT_MANIFEST_MISMATCH', inputManifestPath, 'dispatch input manifest must equal task context_manifest_path_abs'));
    }
    const retryCount = parseIntegerOption(options, 'retry-count', { defaultValue: Math.max(task.attempt - 1, 0), minimum: 0 });
    const maxRetries = parseIntegerOption(options, 'max-retries', { defaultValue: Math.max(task.max_attempts - 1, 0), minimum: 0 });
    if (retryCount > maxRetries) errors.push(issue('DISPATCH_RETRY_LIMIT', '$.retry-count', 'retry_count cannot exceed max_retries'));
    const dispatchId = options['dispatch-id'] ?? undefined;
    if (dispatchId && !/^DSP-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(dispatchId)) errors.push(issue('INVALID_DISPATCH_ID', '$.dispatch-id', 'dispatch-id must be a complete safe DSP identifier'));
    if (errors.length > 0) {
      emit({ ok: false, command: 'prepare-dispatch', workflow_id: workflowId, task_id: taskId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    const ledgerContractErrors = scanDispatches(workflowDir)
      .flatMap((record) => dispatchContractErrors(record, projectRoot));
    if (ledgerContractErrors.length > 0) {
      emitDispatchContractFailure('prepare-dispatch', workflowId, null, ledgerContractErrors);
      return;
    }
    const created = createDispatchIntent({
      workflowDir,
      workflowId,
      task,
      taskFile,
      inputManifestPath,
      sessionKey,
      leaseSeconds,
      retryCount,
      maxRetries,
      dispatchId,
    });
    const intentSchema = readJson(join(projectRoot, 'contracts', 'dispatch-intent.schema.json'));
    const intentErrors = validateInstance(created.intent, intentSchema);
    if (intentErrors.length > 0) throw transactionError('DISPATCH_INTENT_INVALID', created.intent.dispatch_id, 'created dispatch intent failed its contract');
    emit({
      ok: true,
      command: 'prepare-dispatch',
      workflow_id: workflowId,
      task_id: taskId,
      run_id: runId,
      dispatch_id: created.intent.dispatch_id,
      idempotent: created.idempotent,
      intent: created.intent,
      recovered_transactions: recoveredTransactions,
    });
  } catch (error) {
    emitDispatchCommandError('prepare-dispatch', workflowId, error, taskFile);
  } finally {
    lock?.release();
  }
}

function recordDispatchReceiptCommand(options) {
  const layout = dispatchCommandLayout(options, 'record-dispatch-receipt');
  if (!layout) return;
  const { projectRoot, workflowId, workflowDir } = layout;
  let dispatchId;
  try {
    dispatchId = requireSafeDispatchId(options);
  } catch (error) {
    emitDispatchCommandError('record-dispatch-receipt', workflowId, error, workflowDir);
    return;
  }
  const status = requireOption(options, 'status');
  const sessionKey = requireOption(options, 'session-key');
  const sessionId = requireOption(options, 'session-id');
  if (!['SENT', 'ACKNOWLEDGED', 'RUNNING'].includes(status)) {
    emit({ ok: false, command: 'record-dispatch-receipt', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('DISPATCH_RECEIPT_STATUS', '$.status', 'status must be SENT, ACKNOWLEDGED, or RUNNING')] }, 1);
    return;
  }
  try {
    const contractErrors = dispatchContractErrors(loadDispatch(workflowDir, dispatchId), projectRoot);
    if (contractErrors.length > 0) {
      emitDispatchContractFailure('record-dispatch-receipt', workflowId, dispatchId, contractErrors);
      return;
    }
    const receipt = recordDispatchReceipt({ workflowDir, dispatchId, status, sessionKey, sessionId });
    const schema = readJson(join(projectRoot, 'contracts', 'dispatch-receipt.schema.json'));
    const errors = validateInstance(receipt, schema);
    if (errors.length > 0) throw transactionError('DISPATCH_RECEIPT_INVALID', dispatchId, 'created dispatch receipt failed its contract');
    emit({ ok: true, command: 'record-dispatch-receipt', workflow_id: workflowId, dispatch_id: dispatchId, receipt });
  } catch (error) {
    emitDispatchCommandError('record-dispatch-receipt', workflowId, error, dispatchDirectory(workflowDir, dispatchId));
  }
}

function recordCompletionReceiptCommand(options) {
  const layout = dispatchCommandLayout(options, 'record-completion-receipt');
  if (!layout) return;
  const { projectRoot, workflowId, workflowDir } = layout;
  let dispatchId;
  try {
    dispatchId = requireSafeDispatchId(options);
  } catch (error) {
    emitDispatchCommandError('record-completion-receipt', workflowId, error, workflowDir);
    return;
  }
  const status = requireOption(options, 'status');
  const sessionKey = requireOption(options, 'session-key');
  const sessionId = requireOption(options, 'session-id');
  if (!['SUCCEEDED', 'FAILED', 'LOST'].includes(status)) {
    emit({ ok: false, command: 'record-completion-receipt', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('DISPATCH_COMPLETION_STATUS', '$.status', 'status must be SUCCEEDED, FAILED, or LOST')] }, 1);
    return;
  }
  try {
    const contractErrors = dispatchContractErrors(loadDispatch(workflowDir, dispatchId), projectRoot);
    if (contractErrors.length > 0) {
      emitDispatchContractFailure('record-completion-receipt', workflowId, dispatchId, contractErrors);
      return;
    }
    const result = recordCompletionReceipt({
      workflowDir,
      dispatchId,
      status,
      sessionKey,
      sessionId,
      resultPath: options['result-file'] ? resolve(options['result-file']) : null,
      errorCode: options['error-code'] ?? null,
      errorMessage: options['error-message'] ?? null,
    });
    const schema = readJson(join(projectRoot, 'contracts', 'completion-receipt.schema.json'));
    const errors = validateInstance(result.completion, schema);
    if (errors.length > 0) throw transactionError('DISPATCH_COMPLETION_INVALID', dispatchId, 'created completion receipt failed its contract');
    emit({ ok: true, command: 'record-completion-receipt', workflow_id: workflowId, dispatch_id: dispatchId, idempotent: result.idempotent, completion: result.completion });
  } catch (error) {
    emitDispatchCommandError('record-completion-receipt', workflowId, error, dispatchDirectory(workflowDir, dispatchId));
  }
}

function deadLetterDispatchCommand(options) {
  const layout = dispatchCommandLayout(options, 'dead-letter-dispatch');
  if (!layout) return;
  const { projectRoot, workflowId, workflowDir } = layout;
  let dispatchId;
  try {
    dispatchId = requireSafeDispatchId(options);
  } catch (error) {
    emitDispatchCommandError('dead-letter-dispatch', workflowId, error, workflowDir);
    return;
  }
  const reason = requireOption(options, 'reason');
  try {
    const contractErrors = dispatchContractErrors(loadDispatch(workflowDir, dispatchId), projectRoot);
    if (contractErrors.length > 0) {
      emitDispatchContractFailure('dead-letter-dispatch', workflowId, dispatchId, contractErrors);
      return;
    }
    const result = recordDeadLetter({
      workflowDir,
      dispatchId,
      reason,
      lastError: options['last-error'] ?? null,
    });
    const schema = readJson(join(projectRoot, 'contracts', 'dead-letter.schema.json'));
    const errors = validateInstance(result.dead_letter, schema);
    if (errors.length > 0) throw transactionError('DISPATCH_DEAD_LETTER_INVALID', dispatchId, 'created dead letter failed its contract');
    emit({ ok: true, command: 'dead-letter-dispatch', workflow_id: workflowId, dispatch_id: dispatchId, idempotent: result.idempotent, dead_letter: result.dead_letter });
  } catch (error) {
    emitDispatchCommandError('dead-letter-dispatch', workflowId, error, dispatchDirectory(workflowDir, dispatchId));
  }
}

function reconcileDispatchCommand(options) {
  const layout = dispatchCommandLayout(options, 'reconcile-dispatch');
  if (!layout) return;
  const { projectRoot, workflowId, workflowDir } = layout;
  try {
    const selectedDispatchId = options['dispatch-id'] ? requireSafeDispatchId(options) : null;
    const records = selectedDispatchId
      ? [loadDispatch(workflowDir, selectedDispatchId)]
      : scanDispatches(workflowDir);
    const errors = records.flatMap((record) => dispatchContractErrors(record, projectRoot));
    if (errors.length > 0) {
      emitDispatchContractFailure('reconcile-dispatch', workflowId, selectedDispatchId, errors);
      return;
    }
    emit({
      ok: true,
      command: 'reconcile-dispatch',
      workflow_id: workflowId,
      dispatches: records.map((record) => reconcileDispatch(record)),
    });
  } catch (error) {
    emitDispatchCommandError('reconcile-dispatch', workflowId, error, workflowDir);
  }
}

function validateStateMachine(machine, errors) {
  if (machine?.schema_version !== 1) {
    errors.push(issue('STATE_MACHINE_VERSION', '$.schema_version', 'workflow state machine schema_version must be 1'));
    return;
  }
  for (const domain of ['workflow', 'task']) {
    const transitions = machine[domain]?.transitions;
    if (!isObject(transitions)) {
      errors.push(issue('STATE_MACHINE_SHAPE', `$.${domain}.transitions`, 'transition map is required'));
      continue;
    }
    const states = new Set(Object.keys(transitions));
    for (const [from, destinations] of Object.entries(transitions)) {
      if (!Array.isArray(destinations)) {
        errors.push(issue('STATE_MACHINE_SHAPE', `$.${domain}.transitions.${from}`, 'destinations must be an array'));
        continue;
      }
      for (const destination of destinations) {
        if (!states.has(destination)) {
          errors.push(issue('STATE_MACHINE_UNKNOWN_STATE', `$.${domain}.transitions.${from}`, `unknown destination: ${destination}`));
        }
      }
    }
  }
  const workflowStates = new Set(Object.keys(machine.workflow?.transitions ?? {}));
  for (const [phase, statuses] of Object.entries(machine.workflow?.phase_statuses ?? {})) {
    for (const status of statuses) {
      if (!workflowStates.has(status)) {
        errors.push(issue('STATE_MACHINE_UNKNOWN_STATE', `$.workflow.phase_statuses.${phase}`, `unknown status: ${status}`));
      }
    }
  }
}

function validateEventChain(events, workflow, machine, eventSchema, errors) {
  if (events.length === 0) {
    errors.push(issue('EVENT_CHAIN_EMPTY', '$.events', 'events.jsonl must contain at least one event'));
    return;
  }
  let previous = null;
  const taskStatusByRun = new Map();
  const eventIds = new Set();
  let previousTimestamp = null;
  for (const [index, event] of events.entries()) {
    const eventSchemaValid = addSchemaErrors(errors, event, eventSchema, `events.jsonl:${index + 1}`);
    if (!eventSchemaValid) {
      previous = event;
      continue;
    }
    if (eventIds.has(event.event_id)) {
      errors.push(issue('DUPLICATE_EVENT_ID', `events.jsonl:${index + 1}`, `event_id is repeated: ${event.event_id}`));
    }
    eventIds.add(event.event_id);
    const eventTimestamp = Date.parse(event.timestamp);
    if (previousTimestamp !== null && eventTimestamp < previousTimestamp) {
      errors.push(issue('EVENT_TIMESTAMP_REGRESSION', `events.jsonl:${index + 1}`, 'event timestamp is earlier than the preceding event'));
    }
    previousTimestamp = eventTimestamp;
    const expectedSequence = index + 1;
    if (event.seq !== expectedSequence || event.state_revision !== expectedSequence) {
      errors.push(issue('EVENT_SEQUENCE_MISMATCH', `events.jsonl:${index + 1}`, `expected seq and state_revision ${expectedSequence}`));
    }
    const expectedPreviousHash = previous?.event_hash ?? '0'.repeat(64);
    if (event.previous_event_hash !== expectedPreviousHash) {
      errors.push(issue('EVENT_PREVIOUS_HASH_MISMATCH', `events.jsonl:${index + 1}`, 'previous_event_hash does not match prior event'));
    }
    if (event.event_hash !== eventHash(event)) {
      errors.push(issue('EVENT_HASH_MISMATCH', `events.jsonl:${index + 1}`, 'event_hash does not match canonical event content'));
    }
    if (event.workflow_id !== workflow.workflow_id) {
      errors.push(issue('EVENT_WORKFLOW_MISMATCH', `events.jsonl:${index + 1}`, 'event workflow_id does not match workflow.json'));
    }
    if (!previous) {
      if (event.from_status !== null || event.from_phase !== null) {
        errors.push(issue('INVALID_INITIAL_EVENT', 'events.jsonl:1', 'first event must have null from_status and from_phase'));
      }
    } else {
      if (event.from_status !== previous.to_status || event.from_phase !== previous.to_phase) {
        errors.push(issue('EVENT_STATE_DISCONTINUITY', `events.jsonl:${index + 1}`, 'from state does not match previous event'));
      }
      if (event.to_status !== event.from_status) {
        const allowed = machine.workflow.transitions[event.from_status] ?? [];
        if (!allowed.includes(event.to_status)) {
          errors.push(issue('INVALID_WORKFLOW_TRANSITION', `events.jsonl:${index + 1}`, `${event.from_status} -> ${event.to_status} is not allowed`));
        }
      }
    }
    const phaseStatuses = machine.workflow.phase_statuses[event.to_phase] ?? [];
    if (!phaseStatuses.includes(event.to_status)) {
      errors.push(issue('INVALID_PHASE_STATUS', `events.jsonl:${index + 1}`, `${event.to_status} is not valid in phase ${event.to_phase}`));
    }
    const hasTaskTransition = event.task_status_before !== null || event.task_status_after !== null;
    if (hasTaskTransition) {
      if (!event.task_id || !event.run_id || !event.task_status_before || !event.task_status_after) {
        errors.push(issue('INCOMPLETE_TASK_TRANSITION', `events.jsonl:${index + 1}`, 'task transition requires task_id, run_id, before and after status'));
      } else {
        const taskKey = `${event.task_id}\u0000${event.run_id}`;
        const priorTaskStatus = taskStatusByRun.get(taskKey);
        if (priorTaskStatus !== undefined && event.task_status_before !== priorTaskStatus) {
          errors.push(issue('TASK_EVENT_DISCONTINUITY', `events.jsonl:${index + 1}`, 'task_status_before does not match the prior task event'));
        }
        if (priorTaskStatus === undefined && event.task_status_before !== 'CREATED') {
          errors.push(issue('INVALID_INITIAL_TASK_TRANSITION', `events.jsonl:${index + 1}`, 'first task event must begin at CREATED'));
        }
        if (event.task_status_before !== event.task_status_after) {
          const allowed = machine.task.transitions[event.task_status_before] ?? [];
          if (!allowed.includes(event.task_status_after)) {
            errors.push(issue('INVALID_TASK_TRANSITION', `events.jsonl:${index + 1}`, `${event.task_status_before} -> ${event.task_status_after} is not allowed`));
          }
        }
        taskStatusByRun.set(taskKey, event.task_status_after);
      }
    }
    previous = event;
  }
  const latest = events.at(-1);
  const comparisons = [
    ['status', latest.to_status, workflow.status],
    ['current_phase', latest.to_phase, workflow.current_phase],
    ['current_candidate_commit', latest.candidate_commit, workflow.current_candidate_commit],
    ['state_revision', latest.state_revision, workflow.state_revision],
  ];
  for (const [field, eventValue, workflowValue] of comparisons) {
    if (!equalJson(eventValue, workflowValue)) {
      errors.push(issue('WORKFLOW_EVENT_MISMATCH', `$.${field}`, `latest event does not match workflow ${field}`));
    }
  }
}

function validateArchivedTaskArtifacts(task, archivePath, workflow, projectRoot, contextSchema, resultSchema, errors) {
  validateTaskPaths(task, archivePath, workflow, errors);
  if (taskRequiresArtifact(task)) validateTaskContext(task, archivePath, contextSchema, errors);
  const resultPath = join(task.artifact_root_abs, 'output', 'result.json');
  if (existsSync(resultPath)) {
    const result = readJsonForCheck(resultPath, errors);
    if (result) {
      addSchemaErrors(errors, result, resultSchema, resultPath);
      for (const field of ['workflow_id', 'task_id', 'run_id']) {
        if (result[field] !== task[field]) errors.push(issue('RESULT_ID_MISMATCH', `${resultPath}:${field}`, `historical result ${field} does not match task archive`));
      }
      if (result.agent_id !== task.assigned_agent) errors.push(issue('RESULT_AGENT_MISMATCH', `${resultPath}:agent_id`, 'historical result agent_id does not match assigned_agent'));
    }
  } else if (task.status === 'COMPLETED') {
    errors.push(issue('RESULT_REQUIRED', resultPath, 'completed historical task run is missing output/result.json'));
  }
  if (task.status === 'COMPLETED') {
    for (const summaryName of ['user-summary.md', 'manager-summary.md']) {
      const summaryPath = join(task.artifact_root_abs, 'output', summaryName);
      if (!nonEmptyFile(summaryPath)) errors.push(issue('TASK_SUMMARY_REQUIRED', summaryPath, `completed historical task run is missing ${summaryName}`));
    }
  }
  validateStructuredOutputs(task, archivePath, projectRoot, errors);
}

function validateTaskRunArchives({ workflow, workflowDir, projectRoot, taskSchema, contextSchema, resultSchema, errors }) {
  const archivesRoot = join(workflowDir, 'task-runs');
  const archiveSchema = readJson(join(projectRoot, 'contracts', 'task-run.schema.json'));
  const archives = new Map();
  if (!existsSync(archivesRoot)) return archives;
  for (const taskEntry of readdirSync(archivesRoot, { withFileTypes: true })) {
    const taskDir = join(archivesRoot, taskEntry.name);
    if (taskEntry.isSymbolicLink()) {
      errors.push(issue('TASK_RUN_ARCHIVE_SYMLINK', taskDir, 'task run archive directories must not be symbolic links'));
      continue;
    }
    if (!taskEntry.isDirectory()) {
      errors.push(issue('TASK_RUN_ARCHIVE_LAYOUT', taskDir, 'task-runs entries must be task directories'));
      continue;
    }
    for (const archivePath of jsonFiles(taskDir, '.json', errors)) {
      const archive = readJsonForCheck(archivePath, errors);
      if (!archive) continue;
      const archiveValid = addSchemaErrors(errors, archive, archiveSchema, archivePath);
      const taskValid = isObject(archive.task_snapshot)
        ? addSchemaErrors(errors, archive.task_snapshot, taskSchema, `${archivePath}:task_snapshot`)
        : false;
      if (!archiveValid || !taskValid) continue;
      const task = archive.task_snapshot;
      const expectedPath = taskRunArchivePath(workflowDir, archive.task_id, archive.run_id);
      if (resolve(archivePath) !== resolve(expectedPath)) errors.push(issue('TASK_RUN_ARCHIVE_PATH_MISMATCH', archivePath, 'archive path must match task_id and run_id'));
      for (const field of ['workflow_id', 'task_id', 'run_id']) {
        if (archive[field] !== task[field]) errors.push(issue('TASK_RUN_ARCHIVE_SCOPE_MISMATCH', `${archivePath}:${field}`, `archive ${field} does not match task snapshot`));
      }
      if (archive.workflow_id !== workflow.workflow_id) errors.push(issue('TASK_RUN_ARCHIVE_SCOPE_MISMATCH', archivePath, 'archive belongs to a different workflow'));
      if (archive.archived_state_revision > workflow.state_revision) errors.push(issue('TASK_RUN_ARCHIVE_FUTURE_REVISION', archivePath, 'archive revision is newer than workflow state'));
      const expectedHash = createHash('sha256').update(canonicalJson(task), 'utf8').digest('hex');
      if (archive.task_snapshot_sha256 !== expectedHash) errors.push(issue('TASK_RUN_ARCHIVE_HASH_MISMATCH', archivePath, 'task snapshot hash does not match archive content'));
      const key = scopeKey(task.task_id, task.run_id);
      if (archives.has(key)) errors.push(issue('DUPLICATE_TASK_RUN_ARCHIVE', archivePath, 'task_id and run_id archive must be unique'));
      archives.set(key, archive);
      validateArchivedTaskArtifacts(task, archivePath, workflow, projectRoot, contextSchema, resultSchema, errors);
    }
  }
  return archives;
}

function validateTasks({ workflow, workflowDir, projectRoot, eventRecords, errors }) {
  const taskSchema = readJson(join(projectRoot, 'contracts', 'task.schema.json'));
  const resultSchema = readJson(join(projectRoot, 'contracts', 'result.schema.json'));
  const evidenceSchema = readJson(join(projectRoot, 'contracts', 'evidence.schema.json'));
  const commandSchema = readJson(join(projectRoot, 'contracts', 'command-record.schema.json'));
  const reviewSchema = readJson(join(projectRoot, 'contracts', 'review-findings.schema.json'));
  const releaseSchema = readJson(join(projectRoot, 'contracts', 'release-decision.schema.json'));
  const contextSchema = readJson(join(projectRoot, 'contracts', 'context-manifest.schema.json'));
  const taskFiles = jsonFiles(join(workflowDir, 'tasks'), '.json', errors);
  const tasks = [];
  const blockingFindings = [];
  const currentCandidateFindings = [];
  const currentCandidateReviewEvidenceIds = new Set();
  const releaseDecisions = [];
  let currentReleaseTaskKey = null;
  let currentReleaseTaskSeq = -1;
  const evidenceByScope = new Map();
  const allEvidenceIds = new Set();
  const taskKeys = new Set();
  const taskIds = new Map();
  const taskRunArchives = validateTaskRunArchives({
    workflow,
    workflowDir,
    projectRoot,
    taskSchema,
    contextSchema,
    resultSchema,
    errors,
  });
  for (const taskFile of taskFiles) {
    const task = readJsonForCheck(taskFile, errors);
    if (!task) continue;
    tasks.push(task);
    const taskSchemaValid = addSchemaErrors(errors, task, taskSchema, taskFile);
    if (!taskSchemaValid) continue;
    if (!taskFile.endsWith(`${sep}${task.task_id}.json`)) {
      errors.push(issue('TASK_FILENAME_MISMATCH', taskFile, 'task file name must equal task_id.json'));
    }
    const taskKey = scopeKey(task.task_id, task.run_id);
    if (taskKeys.has(taskKey)) {
      errors.push(issue('DUPLICATE_TASK_RUN', taskFile, 'task_id and run_id must be unique in control tasks'));
    }
    taskKeys.add(taskKey);
    const archivedCurrent = taskRunArchives.get(taskKey);
    if (archivedCurrent && archivedCurrent.task_snapshot_sha256 !== createHash('sha256').update(canonicalJson(task), 'utf8').digest('hex')) {
      errors.push(issue('TASK_RUN_ARCHIVE_IMMUTABLE', taskFile, 'current task differs from its immutable archived run snapshot'));
    }
    if (taskIds.has(task.task_id)) {
      errors.push(issue('DUPLICATE_TASK_ID', taskFile, 'task_id must have exactly one control snapshot'));
    }
    taskIds.set(task.task_id, task);
    if (task.attempt > task.max_attempts) {
      errors.push(issue('TASK_MAX_ATTEMPTS_EXCEEDED', taskFile, 'task attempt exceeds max_attempts and requires a human approval'));
    }
    if (task.workflow_id !== workflow.workflow_id) {
      errors.push(issue('TASK_WORKFLOW_MISMATCH', taskFile, 'task workflow_id does not match workflow'));
    }
    validateTaskPaths(task, taskFile, workflow, errors);
    if (taskRequiresArtifact(task)) {
      validateTaskContext(task, taskFile, contextSchema, errors);
    }
    const latestTaskEventForTask = [...eventRecords]
      .reverse()
      .find((event) => event.task_id === task.task_id && event.task_status_after !== null);
    const latestTaskEvent = [...eventRecords]
      .reverse()
      .find((event) => event.task_id === task.task_id && event.run_id === task.run_id && event.task_status_after !== null);
    if (!latestTaskEvent) {
      errors.push(issue('TASK_EVENT_REQUIRED', taskFile, 'task snapshot has no task state event'));
    } else if (latestTaskEventForTask !== latestTaskEvent || latestTaskEvent.task_status_after !== task.status) {
      errors.push(issue('TASK_EVENT_MISMATCH', taskFile, 'latest task event does not match task snapshot'));
    }

    const outputDir = join(task.artifact_root_abs, 'output');
    const resultPath = join(outputDir, 'result.json');
    let result;
    if (existsSync(resultPath)) {
      result = readJsonForCheck(resultPath, errors);
      if (result) {
        addSchemaErrors(errors, result, resultSchema, resultPath);
        for (const field of ['workflow_id', 'task_id', 'run_id']) {
          if (result[field] !== task[field]) {
            errors.push(issue('RESULT_ID_MISMATCH', `${resultPath}:${field}`, `result ${field} does not match task`));
          }
        }
        if (result.agent_id !== task.assigned_agent) {
          errors.push(issue('RESULT_AGENT_MISMATCH', `${resultPath}:agent_id`, 'result agent_id does not match assigned_agent'));
        }
        for (const field of ['worktree_path_abs', 'artifact_root_abs']) {
          if (!isAbsolute(result[field]) || !isSameRealPath(result[field], task[field])) {
            errors.push(issue('RESULT_PATH_MISMATCH', `${resultPath}:${field}`, `result ${field} does not match task`));
          }
        }
      }
    } else if (task.status === 'COMPLETED') {
      errors.push(issue('RESULT_REQUIRED', resultPath, 'completed task is missing output/result.json'));
    }

    const evidenceIds = new Set();
    const commandIds = new Set();
    for (const [name, schema] of [['evidence.jsonl', evidenceSchema], ['command-records.jsonl', commandSchema]]) {
      const path = join(outputDir, name);
      if (!existsSync(path)) continue;
      for (const record of readJsonLinesForCheck(path, errors)) {
        addSchemaErrors(errors, record.value, schema, `${path}:${record.line}`);
        if (name === 'command-records.jsonl'
          && (record.value.task_id !== task.task_id || record.value.run_id !== task.run_id)) {
          errors.push(issue('COMMAND_RECORD_SCOPE_MISMATCH', `${path}:${record.line}`, 'command record task_id or run_id does not match task'));
        }
        if (name === 'evidence.jsonl') {
          if (allEvidenceIds.has(record.value.evidence_id)) errors.push(issue('DUPLICATE_EVIDENCE_ID', `${path}:${record.line}`, 'evidence_id must be unique in workflow'));
          allEvidenceIds.add(record.value.evidence_id);
          evidenceIds.add(record.value.evidence_id);
        } else {
          commandIds.add(record.value.command_record_id);
        }
      }
    }
    evidenceByScope.set(scopeKey(task.task_id, task.run_id), evidenceIds);
    if (result) {
      validateEvidenceRefs(result.evidence_refs, evidenceIds, resultPath, errors);
      for (const claim of result.claims ?? []) validateEvidenceRefs(claim.evidence_refs, evidenceIds, resultPath, errors);
      for (const reference of result.command_record_refs ?? []) {
        if (!commandIds.has(reference)) errors.push(issue('COMMAND_REFERENCE_NOT_FOUND', resultPath, `command record reference is not available in task scope: ${reference}`));
      }
    }
    if (task.status === 'COMPLETED') {
      for (const requiredOutput of task.required_outputs ?? []) {
        if (!existsSync(requiredOutput) || !isRealPathWithin(task.artifact_root_abs, requiredOutput)) {
          errors.push(issue('REQUIRED_OUTPUT_MISSING', taskFile, `required output is missing or outside artifact root: ${requiredOutput}`));
        }
      }
      for (const summaryName of ['user-summary.md', 'manager-summary.md']) {
        const summaryPath = join(outputDir, summaryName);
        if (!nonEmptyFile(summaryPath)) {
          errors.push(issue('TASK_SUMMARY_REQUIRED', summaryPath, `completed task is missing a non-empty ${summaryName}`));
        }
      }
    }
    validateStructuredOutputs(task, taskFile, projectRoot, errors);
    if (task.task_type === 'RELEASE_VERIFICATION'
      && task.assigned_agent === 'release-agent'
      && task.input_commit === workflow.current_candidate_commit
      && Number.isInteger(latestTaskEvent?.seq)
      && latestTaskEvent.seq > currentReleaseTaskSeq) {
      currentReleaseTaskSeq = latestTaskEvent.seq;
      currentReleaseTaskKey = scopeKey(task.task_id, task.run_id);
    }

    const reviewPath = join(outputDir, 'review-findings.json');
    if (existsSync(reviewPath)) {
      const review = readJsonForCheck(reviewPath, errors);
      if (review) {
        addSchemaErrors(errors, review, reviewSchema, reviewPath);
        const reviewScopeMatches = review.workflow_id === workflow.workflow_id
          && review.task_id === task.task_id
          && ['CODE_REVIEW', 'TEST_CODE_REVIEW'].includes(task.task_type)
          && task.assigned_agent === 'review-agent'
          && review.reviewed_commit === task.input_commit;
        if (!reviewScopeMatches) {
          errors.push(issue('REVIEW_SCOPE_MISMATCH', reviewPath, 'review must bind its review-agent task, workflow, and task input commit'));
        }
        const isCurrentCandidateReview = reviewScopeMatches && review.reviewed_commit === workflow.current_candidate_commit;
        if (isCurrentCandidateReview) {
          for (const evidenceId of evidenceIds) currentCandidateReviewEvidenceIds.add(evidenceId);
        }
        for (const finding of review.findings ?? []) {
          validateEvidenceRefs(finding.evidence, evidenceIds, reviewPath, errors);
          if (isCurrentCandidateReview) {
            currentCandidateFindings.push({
              task_id: task.task_id,
              run_id: task.run_id,
              event_seq: latestTaskEvent?.seq ?? null,
              finding_id: finding.finding_id,
              severity: finding.severity,
              status: finding.status,
              source: reviewPath,
            });
          }
        }
      }
    }

    const releasePath = join(outputDir, 'release-decision.json');
    if (existsSync(releasePath)) {
      const release = readJsonForCheck(releasePath, errors);
      if (release) {
        addSchemaErrors(errors, release, releaseSchema, releasePath);
        const releaseTaskScopeMatches = task.task_type === 'RELEASE_VERIFICATION'
          && task.assigned_agent === 'release-agent'
          && release.task_id === task.task_id
          && release.run_id === task.run_id;
        if (!releaseTaskScopeMatches) {
          errors.push(issue('RELEASE_TASK_SCOPE_MISMATCH', releasePath, 'release decision must bind the current release verification task and run'));
        }
        if (release.workflow_id !== workflow.workflow_id) {
          errors.push(issue('RELEASE_WORKFLOW_MISMATCH', releasePath, 'release decision workflow_id does not match workflow'));
        }
        if (release.candidate_commit !== task.input_commit) {
          errors.push(issue('RELEASE_CANDIDATE_MISMATCH', releasePath, 'release decision candidate must match the bound release task input commit'));
        }
        validateEvidenceRefs(release.evidence_refs, evidenceIds, releasePath, errors);
        for (const check of release.checks ?? []) {
          validateEvidenceRefs(check.evidence_refs, evidenceIds, releasePath, errors);
        }
        const statuses = (release.checks ?? []).map((check) => check.status);
        const computedVerdict = statuses.some((status) => ['HOLD', 'UNKNOWN', 'NOT_APPLICABLE'].includes(status)) ? 'HOLD'
          : statuses.some((status) => status === 'FAIL') ? 'NO_GO'
            : statuses.length > 0 && statuses.every((status) => status === 'PASS') ? 'GO' : 'HOLD';
        if (release.verdict !== computedVerdict) {
          errors.push(issue('RELEASE_VERDICT_RECOMPUTE_MISMATCH', releasePath, `checks require ${computedVerdict}, found ${release.verdict}`));
        }
        releaseDecisions.push({
          decision: release,
          task_id: task.task_id,
          run_id: task.run_id,
          source: releasePath,
        });
      }
    }
  }
  const artifactRuns = artifactRunKeys(workflow.runtime_root_abs, workflow.workflow_id);
  const artifactKeys = new Set(artifactRuns.map((run) => scopeKey(run.task_id, run.run_id)));
  for (const run of artifactRuns) {
    const runKey = scopeKey(run.task_id, run.run_id);
    if (!taskKeys.has(runKey) && !taskRunArchives.has(runKey)) {
      errors.push(issue('ORPHAN_ARTIFACT_RUN', run.path, 'artifact task/run has no matching control task snapshot'));
    }
  }
  for (const task of tasks) {
    if (taskRequiresArtifact(task) && !artifactKeys.has(scopeKey(task.task_id, task.run_id))) {
      errors.push(issue('TASK_ARTIFACT_RUN_REQUIRED', task.artifact_root_abs, 'task status requires its canonical artifact task/run directory'));
    }
  }
  const dependencyStates = new Map(tasks.map((task) => [task.task_id, task.status]));
  for (const task of tasks) {
    for (const dependencyId of task.dependencies ?? []) {
      if (dependencyId === task.task_id || !taskIds.has(dependencyId)) {
        errors.push(issue('TASK_DEPENDENCY_NOT_FOUND', task.task_id, `task dependency is unavailable: ${dependencyId}`));
      } else if (['READY', 'DISPATCHED', 'RUNNING', 'WAITING_HUMAN', 'COMPLETED'].includes(task.status)
        && dependencyStates.get(dependencyId) !== 'COMPLETED') {
        errors.push(issue('TASK_DEPENDENCY_NOT_COMPLETED', task.task_id, `task dependency is not completed: ${dependencyId}`));
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    for (const dependencyId of taskIds.get(taskId)?.dependencies ?? []) {
      if (taskIds.has(dependencyId) && visit(dependencyId)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };
  for (const taskId of taskIds.keys()) {
    if (visit(taskId)) {
      errors.push(issue('TASK_DEPENDENCY_CYCLE', '$.tasks', 'control task dependencies must be acyclic'));
      break;
    }
  }
  if (new Set(workflow.task_ids).size !== workflow.task_ids.length) {
    errors.push(issue('DUPLICATE_WORKFLOW_TASK_ID', '$.task_ids', 'workflow task_ids must be unique'));
  }
  const findingsById = new Map();
  for (const finding of currentCandidateFindings) {
    if (!findingsById.has(finding.finding_id)) findingsById.set(finding.finding_id, []);
    findingsById.get(finding.finding_id).push(finding);
  }
  for (const [findingId, findings] of findingsById) {
    const seenScopes = new Set();
    const seenSequences = new Set();
    let ambiguous = false;
    for (const finding of findings) {
      const findingScope = scopeKey(finding.task_id, finding.run_id);
      if (!Number.isInteger(finding.event_seq)
        || seenScopes.has(findingScope)
        || seenSequences.has(finding.event_seq)) {
        ambiguous = true;
      }
      seenScopes.add(findingScope);
      if (Number.isInteger(finding.event_seq)) seenSequences.add(finding.event_seq);
    }
    if (ambiguous) {
      errors.push(issue('REVIEW_FINDING_LINEAGE_AMBIGUOUS', findings[0]?.source ?? '$.findings', `finding ${findingId} cannot be ordered uniquely by review task event seq`));
      continue;
    }
    const latest = findings.reduce((selected, finding) => (
      selected === null || finding.event_seq > selected.event_seq ? finding : selected
    ), null);
    if (latest && ['BLOCKER', 'CRITICAL', 'HIGH'].includes(latest.severity) && latest.status === 'OPEN') {
      blockingFindings.push({
        task_id: latest.task_id,
        run_id: latest.run_id,
        finding_id: latest.finding_id,
        severity: latest.severity,
      });
    }
  }
  if (!sameStringSet(tasks.map((task) => task.task_id), workflow.task_ids)) {
    errors.push(issue('WORKFLOW_TASK_INDEX_MISMATCH', '$.task_ids', 'workflow task_ids do not match control task files'));
  }
  const knownTaskScopes = new Map(tasks.map((task) => [scopeKey(task.task_id, task.run_id), task]));
  for (const archive of taskRunArchives.values()) {
    knownTaskScopes.set(scopeKey(archive.task_id, archive.run_id), archive.task_snapshot);
  }
  return { tasks, blockingFindings, currentCandidateReviewEvidenceIds, currentReleaseTaskKey, releaseDecisions, evidenceByScope, allEvidenceIds, knownTaskScopes };
}

function dispatchIdentityMatches(record, intent) {
  return ['dispatch_id', 'idempotency_key', 'workflow_id', 'task_id', 'run_id', 'agent_id', 'attempt']
    .every((field) => equalJson(record[field], intent[field]));
}

function validateDispatchLedgers({ workflow, workflowDir, projectRoot, taskState, errors }) {
  const root = join(workflowDir, 'dispatch');
  if (!existsSync(root)) return;
  const schemas = {
    intent: readJson(join(projectRoot, 'contracts', 'dispatch-intent.schema.json')),
    receipt: readJson(join(projectRoot, 'contracts', 'dispatch-receipt.schema.json')),
    completion: readJson(join(projectRoot, 'contracts', 'completion-receipt.schema.json')),
    deadLetter: readJson(join(projectRoot, 'contracts', 'dead-letter.schema.json')),
  };
  const records = [];
  const dispatchIds = new Set();
  const idempotencyKeys = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const directory = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(issue('DISPATCH_DIR_SYMLINK', directory, 'dispatch directories must not be symbolic links'));
      continue;
    }
    if (!entry.isDirectory() || !/^DSP-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(entry.name)) {
      errors.push(issue('DISPATCH_LAYOUT_INVALID', directory, 'dispatch entries must be DSP-* directories'));
      continue;
    }
    for (const fileName of ['intent.json', 'receipts.jsonl', 'completion-receipt.json', 'dead-letter.json']) {
      const path = join(directory, fileName);
      if (existsSync(path)) rejectSymlink(path, errors, 'DISPATCH_RECORD_SYMLINK');
    }
    let record;
    try {
      record = loadDispatch(workflowDir, entry.name);
    } catch (error) {
      errors.push(issue('DISPATCH_LEDGER_READ_ERROR', directory, error.message));
      continue;
    }
    const intentPath = join(directory, 'intent.json');
    const intentValid = addSchemaErrors(errors, record.intent, schemas.intent, intentPath);
    if (!intentValid) continue;
    records.push(record);
    const intent = record.intent;
    if (intent.dispatch_id !== entry.name) errors.push(issue('DISPATCH_ID_MISMATCH', intentPath, 'dispatch directory does not match intent dispatch_id'));
    if (dispatchIds.has(intent.dispatch_id)) errors.push(issue('DUPLICATE_DISPATCH_ID', intentPath, `dispatch_id is repeated: ${intent.dispatch_id}`));
    dispatchIds.add(intent.dispatch_id);
    if (idempotencyKeys.has(intent.idempotency_key)) errors.push(issue('DUPLICATE_DISPATCH_IDEMPOTENCY_KEY', intentPath, `idempotency key is repeated: ${intent.idempotency_key}`));
    idempotencyKeys.add(intent.idempotency_key);
    if (intent.idempotency_key !== dispatchIdempotencyKey(intent)) errors.push(issue('DISPATCH_IDEMPOTENCY_KEY_MISMATCH', intentPath, 'idempotency key does not match workflow/task/run/agent/attempt'));
    if (intent.workflow_id !== workflow.workflow_id) errors.push(issue('DISPATCH_WORKFLOW_MISMATCH', intentPath, 'dispatch belongs to a different workflow'));
    const task = taskState.knownTaskScopes.get(scopeKey(intent.task_id, intent.run_id));
    if (!task) {
      errors.push(issue('DISPATCH_TASK_NOT_FOUND', intentPath, 'dispatch task/run has no current or archived task snapshot'));
    } else {
      if (task.assigned_agent !== intent.agent_id || task.attempt !== intent.attempt) {
        errors.push(issue('DISPATCH_TASK_SCOPE_MISMATCH', intentPath, 'dispatch agent or attempt does not match task snapshot'));
      }
      const expectedTaskPath = join(workflowDir, 'tasks', `${intent.task_id}.json`);
      if (resolve(intent.task_file_abs) !== resolve(expectedTaskPath)) errors.push(issue('DISPATCH_TASK_PATH_MISMATCH', intentPath, 'dispatch task_file_abs is not canonical'));
      if (!isSameRealPath(intent.input_manifest_path_abs, task.context_manifest_path_abs)) {
        errors.push(issue('DISPATCH_INPUT_MANIFEST_MISMATCH', intentPath, 'dispatch input manifest does not match task snapshot'));
      } else if (sha256File(intent.input_manifest_path_abs) !== intent.input_manifest_sha256) {
        errors.push(issue('DISPATCH_INPUT_MANIFEST_HASH_MISMATCH', intentPath, 'dispatch input manifest hash changed after prepare'));
      }
    }
    if (Date.parse(intent.lease_deadline) <= Date.parse(intent.lease_started_at)) errors.push(issue('DISPATCH_LEASE_INVALID', intentPath, 'lease_deadline must be later than lease_started_at'));
    if (intent.retry_count > intent.max_retries) errors.push(issue('DISPATCH_RETRY_LIMIT', intentPath, 'retry_count cannot exceed max_retries'));
    const receiptIds = new Set();
    const sessionIds = new Set();
    let priorOrder = 0;
    let priorReceiptTime = Date.parse(intent.created_at);
    for (const [index, receipt] of record.receipts.entries()) {
      const source = `${join(directory, 'receipts.jsonl')}:${index + 1}`;
      if (!addSchemaErrors(errors, receipt, schemas.receipt, source)) continue;
      if (receiptIds.has(receipt.receipt_id)) errors.push(issue('DUPLICATE_DISPATCH_RECEIPT_ID', source, `receipt_id is repeated: ${receipt.receipt_id}`));
      receiptIds.add(receipt.receipt_id);
      if (!dispatchIdentityMatches(receipt, intent)) errors.push(issue('DISPATCH_RECEIPT_SCOPE_MISMATCH', source, 'receipt identity does not match intent'));
      if (receipt.session_key !== intent.session_key || receipt.lease_deadline !== intent.lease_deadline
        || receipt.input_manifest_sha256 !== intent.input_manifest_sha256) {
        errors.push(issue('DISPATCH_RECEIPT_BINDING_MISMATCH', source, 'receipt session, lease, or input hash does not match intent'));
      }
      sessionIds.add(receipt.session_id);
      const order = new Map([['SENT', 1], ['ACKNOWLEDGED', 2], ['RUNNING', 3]]).get(receipt.status);
      if (order <= priorOrder) errors.push(issue('DISPATCH_RECEIPT_ORDER', source, 'dispatch receipt statuses must advance monotonically'));
      priorOrder = order;
      const recordedAt = Date.parse(receipt.recorded_at);
      if (recordedAt < priorReceiptTime) errors.push(issue('DISPATCH_RECEIPT_TIME_REGRESSION', source, 'receipt timestamp is earlier than the previous dispatch record'));
      priorReceiptTime = recordedAt;
    }
    if (sessionIds.size > 1) errors.push(issue('DISPATCH_SESSION_ID_MISMATCH', directory, 'one dispatch cannot bind multiple session IDs'));
    if (record.completion) {
      const completionPath = join(directory, 'completion-receipt.json');
      if (addSchemaErrors(errors, record.completion, schemas.completion, completionPath)) {
        if (!dispatchIdentityMatches(record.completion, intent)) errors.push(issue('DISPATCH_COMPLETION_SCOPE_MISMATCH', completionPath, 'completion identity does not match intent'));
        if (record.receipts.length === 0 || !sessionIds.has(record.completion.session_id)
          || record.completion.session_key !== intent.session_key) {
          errors.push(issue('DISPATCH_COMPLETION_SESSION_MISMATCH', completionPath, 'completion does not match the recorded dispatch session'));
        }
        if (Date.parse(record.completion.completed_at) < priorReceiptTime) errors.push(issue('DISPATCH_COMPLETION_TIME_REGRESSION', completionPath, 'completion timestamp is earlier than the latest receipt'));
        if (record.completion.status === 'SUCCEEDED' && task) {
          const expectedResult = join(task.artifact_root_abs, 'output', 'result.json');
          if (!isSameRealPath(record.completion.result_path_abs, expectedResult)) {
            errors.push(issue('DISPATCH_RESULT_PATH_MISMATCH', completionPath, 'successful completion must bind canonical output/result.json'));
          } else if (sha256File(expectedResult) !== record.completion.result_sha256) {
            errors.push(issue('DISPATCH_RESULT_HASH_MISMATCH', completionPath, 'completion result hash does not match output/result.json'));
          }
        }
      }
    }
    if (record.dead_letter) {
      const deadLetterPath = join(directory, 'dead-letter.json');
      if (addSchemaErrors(errors, record.dead_letter, schemas.deadLetter, deadLetterPath)) {
        if (!dispatchIdentityMatches(record.dead_letter, intent)) errors.push(issue('DISPATCH_DEAD_LETTER_SCOPE_MISMATCH', deadLetterPath, 'dead letter identity does not match intent'));
        if (record.dead_letter.retry_count !== intent.retry_count || record.dead_letter.max_retries !== intent.max_retries
          || intent.retry_count < intent.max_retries) {
          errors.push(issue('DISPATCH_DEAD_LETTER_RETRY_MISMATCH', deadLetterPath, 'dead letter retry counters must match an exhausted intent'));
        }
        if (!record.completion || record.completion.status === 'SUCCEEDED') errors.push(issue('DISPATCH_DEAD_LETTER_FAILURE_REQUIRED', deadLetterPath, 'dead letter requires a FAILED or LOST completion'));
      }
    }
    if (!dispatchIsTerminal(record) && Date.now() > Date.parse(intent.lease_deadline)) {
      errors.push(issue('DISPATCH_LEASE_EXPIRED', intentPath, 'dispatch lease expired; query the recorded session before marking LOST or retrying'));
    }
  }
  const unresolvedByScope = new Map();
  for (const record of records) {
    if (dispatchIsTerminal(record)) continue;
    const key = scopeKey(record.intent.task_id, record.intent.run_id);
    if (unresolvedByScope.has(key)) errors.push(issue('DISPATCH_SCOPE_CONFLICT', record.directory, `task/run has multiple unresolved dispatches: ${record.intent.task_id}/${record.intent.run_id}`));
    unresolvedByScope.set(key, record.intent.dispatch_id);
  }
  for (const task of taskState.tasks) {
    const matching = records
      .filter((record) => record.intent.task_id === task.task_id && record.intent.run_id === task.run_id && record.intent.attempt === task.attempt)
      .sort((left, right) => left.intent.created_at.localeCompare(right.intent.created_at));
    if (matching.length === 0) continue;
    const latestState = currentDispatchState(matching.at(-1));
    const allowedStates = {
      READY: ['PREPARED', 'FAILED', 'LOST', 'DEAD_LETTER'],
      DISPATCHED: ['SENT', 'ACKNOWLEDGED', 'RUNNING'],
      RUNNING: ['RUNNING'],
      COMPLETED: ['SUCCEEDED'],
      FAILED: ['FAILED', 'DEAD_LETTER'],
      LOST: ['LOST', 'DEAD_LETTER'],
    }[task.status];
    if (allowedStates && !allowedStates.includes(latestState)) {
      errors.push(issue('DISPATCH_TASK_STATE_MISMATCH', task.task_id, `task status ${task.status} is inconsistent with dispatch state ${latestState}`));
    }
  }
}

function validateApprovals({ workflow, workflowDir, projectRoot, taskState, errors }) {
  const requestSchema = readJson(join(projectRoot, 'contracts', 'approval-request.schema.json'));
  const responseSchema = readJson(join(projectRoot, 'contracts', 'approval-response.schema.json'));
  const decisionDir = join(workflowDir, 'decisions');
  const requestFiles = jsonFiles(decisionDir, '.request.json', errors);
  const pendingIds = [];
  const resolvedApprovals = new Map();
  for (const requestFile of requestFiles) {
    const request = readJsonForCheck(requestFile, errors);
    if (!request) continue;
    addSchemaErrors(errors, request, requestSchema, requestFile);
    if (!isObject(request)) continue;
    if (request.workflow_id !== workflow.workflow_id) {
      errors.push(issue('APPROVAL_WORKFLOW_MISMATCH', `${requestFile}:workflow_id`, 'request workflow_id does not match workflow'));
    }
    const evidenceScope = request.task_id === null ? taskState.allEvidenceIds : taskState.evidenceByScope.get(scopeKey(request.task_id, request.run_id)) ?? new Set();
    validateEvidenceRefs(request.evidence_refs, evidenceScope, requestFile, errors);
    const responsePath = requestFile.replace(/\.request\.json$/u, '.response.json');
    const hasResponse = existsSync(responsePath);
    if (request.status === 'PENDING') {
      pendingIds.push(request.decision_id);
      if (hasResponse) {
        errors.push(issue('PENDING_APPROVAL_HAS_RESPONSE', responsePath, 'pending request must not have a response'));
      }
      continue;
    }
    if (request.status === 'CANCELLED') {
      if (hasResponse) errors.push(issue('CANCELLED_APPROVAL_HAS_RESPONSE', responsePath, 'cancelled request must not have a response'));
      continue;
    }
    if (request.status === 'RESOLVED' && !hasResponse) {
      errors.push(issue('APPROVAL_RESPONSE_REQUIRED', responsePath, 'resolved request is missing a response'));
      continue;
    }
    if (request.status !== 'RESOLVED' || !hasResponse) continue;
    const response = readJsonForCheck(responsePath, errors);
    if (!response) continue;
    addSchemaErrors(errors, response, responseSchema, responsePath);
    for (const field of ['decision_id', 'workflow_id', 'task_id', 'run_id']) {
      if (!equalJson(response[field], request[field])) {
        errors.push(issue('APPROVAL_SCOPE_MISMATCH', `${responsePath}:${field}`, `response ${field} does not match request`));
      }
    }
    const optionIds = new Set((request.options ?? []).map((option) => option.option_id));
    if (['APPROVED', 'MODIFIED'].includes(response.outcome) && !optionIds.has(response.chosen_option_id)) {
      errors.push(issue('APPROVAL_OPTION_MISMATCH', `${responsePath}:chosen_option_id`, 'chosen option is not present in request'));
    }
    if (response.outcome === 'REJECTED' && response.chosen_option_id !== null) {
      errors.push(issue('REJECTED_APPROVAL_HAS_OPTION', `${responsePath}:chosen_option_id`, 'rejected approval must not choose an option'));
    }
    resolvedApprovals.set(request.decision_id, { request, response });
  }
  if (!sameStringSet(pendingIds, workflow.pending_decision_ids)) {
    errors.push(issue('PENDING_DECISION_INDEX_MISMATCH', '$.pending_decision_ids', 'workflow pending_decision_ids do not match pending requests'));
  }
  if (pendingIds.length > 0 && ![
    'WAITING_REQUIREMENT_APPROVAL',
    'WAITING_ARCHITECTURE_APPROVAL',
    'WAITING_RELEASE_APPROVAL',
    'WAITING_HUMAN',
    'HOLD',
    'RELEASE_HOLD',
  ].includes(workflow.status)) {
    errors.push(issue('PENDING_APPROVAL_REQUIRES_WAIT', '$.status', 'pending approval requires a waiting or hold workflow status'));
  }
  for (const task of taskState.tasks) {
    for (const decisionId of task.approval_dependencies ?? []) {
      const approval = resolvedApprovals.get(decisionId);
      if (!approval || !['APPROVED', 'MODIFIED'].includes(approval.response.outcome)) {
        errors.push(issue('TASK_APPROVAL_DEPENDENCY_UNRESOLVED', task.task_id, `task approval dependency is not approved: ${decisionId}`));
        continue;
      }
      const request = approval.request;
      if (request.workflow_id !== workflow.workflow_id
        || (request.task_id !== null && (request.task_id !== task.task_id || request.run_id !== task.run_id))) {
        errors.push(issue('TASK_APPROVAL_DEPENDENCY_SCOPE_MISMATCH', task.task_id, `task approval dependency is outside task scope: ${decisionId}`));
      }
    }
  }
  return { pendingIds, resolvedApprovals };
}

function validateApprovalAssessments({ workflow, workflowDir, projectRoot, approvals, taskState, errors }) {
  const schema = readJson(join(projectRoot, 'contracts', 'approval-assessment.schema.json'));
  const assessmentDir = join(workflowDir, 'approval-assessments');
  const assessments = [];
  const seenScopes = new Set();
  for (const file of jsonFiles(assessmentDir, '.json', errors)) {
    const assessment = readJsonForCheck(file, errors);
    if (!assessment) continue;
    assessments.push({ assessment, file });
    addSchemaErrors(errors, assessment, schema, file);
    if (!isObject(assessment) || !Array.isArray(assessment.evaluations)) continue;
    const scopeKeyValue = `${assessment.scope}\u0000${assessment.task_id}\u0000${assessment.run_id}`;
    if (seenScopes.has(scopeKeyValue)) errors.push(issue('DUPLICATE_APPROVAL_ASSESSMENT', file, 'approval assessment scope must be unique'));
    seenScopes.add(scopeKeyValue);
    if (assessment.workflow_id !== workflow.workflow_id) {
      errors.push(issue('APPROVAL_ASSESSMENT_WORKFLOW_MISMATCH', file, 'approval assessment workflow_id does not match workflow'));
    }
    const evaluations = assessment.evaluations ?? [];
    const triggerSet = new Set(evaluations.map((evaluation) => evaluation.trigger));
    if (triggerSet.size !== APPROVAL_TRIGGERS.length
      || !APPROVAL_TRIGGERS.every((trigger) => triggerSet.has(trigger))) {
      errors.push(issue('APPROVAL_TRIGGER_ASSESSMENT_INCOMPLETE', file, 'assessment must evaluate every approval trigger exactly once'));
    }
    if (triggerSet.size !== evaluations.length) {
      errors.push(issue('DUPLICATE_APPROVAL_TRIGGER', file, 'assessment contains duplicate approval triggers'));
    }
    for (const evaluation of evaluations) {
      if (evaluation.status === 'NOT_TRIGGERED' && evaluation.decision_id !== null) {
        errors.push(issue('UNNEEDED_APPROVAL_DECISION', file, `non-triggered assessment cannot bind a decision: ${evaluation.trigger}`));
      }
      if (evaluation.status === 'REQUIRES_APPROVAL') {
        const approval = approvals.resolvedApprovals.get(evaluation.decision_id);
        if (!approval || !['APPROVED', 'MODIFIED'].includes(approval.response.outcome)) {
          errors.push(issue('REQUIRED_APPROVAL_MISSING', file, `trigger requires an approved decision: ${evaluation.trigger}`));
        } else if (approval.request.trigger !== evaluation.trigger) {
          errors.push(issue('APPROVAL_TRIGGER_MISMATCH', file, `decision trigger does not match assessment: ${evaluation.trigger}`));
        }
      }
    }
  }
  const intake = assessments.find(({ assessment }) => assessment.scope === 'INTAKE' && assessment.task_id === null && assessment.run_id === null);
  if (!intake) errors.push(issue('INTAKE_APPROVAL_ASSESSMENT_REQUIRED', assessmentDir, 'workflow requires an intake approval assessment'));
  for (const task of taskState.tasks) {
    if (!taskRequiresArtifact(task)) continue;
    const taskAssessment = assessments.find(({ assessment }) => assessment.scope === 'TASK'
      && assessment.task_id === task.task_id && assessment.run_id === task.run_id);
    if (!taskAssessment) {
      errors.push(issue('TASK_APPROVAL_ASSESSMENT_REQUIRED', task.task_id, 'dispatched task requires an approval assessment'));
    }
  }
  return assessments;
}

function expectedGateOverall(items) {
  if (items.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (items.some((item) => item.status === 'HOLD' || (item.blocking === true && item.status === 'UNKNOWN'))) return 'HOLD';
  return 'PASS';
}

function validateGates({ workflow, workflowDir, projectRoot, machine, approvals, assessments, taskState, errors }) {
  const gateSchema = readJson(join(projectRoot, 'contracts', 'gate-result.schema.json'));
  const gateFiles = jsonFiles(join(workflowDir, 'gates'), '.json', errors);
  let currentReleaseGateCount = 0;
  for (const gateFile of gateFiles) {
    const gate = readJsonForCheck(gateFile, errors);
    if (!gate) continue;
    addSchemaErrors(errors, gate, gateSchema, gateFile);
    if (!isObject(gate) || !Array.isArray(gate.items)) continue;
    if (gate.workflow_id !== workflow.workflow_id) {
      errors.push(issue('GATE_WORKFLOW_MISMATCH', `${gateFile}:workflow_id`, 'gate workflow_id does not match workflow'));
    }
    const expected = expectedGateOverall(gate.items ?? []);
    if (gate.overall !== expected) {
      errors.push(issue('GATE_OVERALL_MISMATCH', gateFile, `items require ${expected}, found ${gate.overall}`));
    }
    if (approvals.pendingIds.length > 0 && gate.overall === 'PASS') {
      errors.push(issue('PENDING_APPROVAL_BLOCKS_GATE', gateFile, 'gate cannot PASS while an approval is pending'));
    }
    const evidenceScope = gate.task_id === null
      ? taskState.allEvidenceIds
      : taskState.evidenceByScope.get(scopeKey(gate.task_id, taskState.tasks.find((task) => task.task_id === gate.task_id)?.run_id)) ?? new Set();
    validateEvidenceRefs(gate.evidence_refs, evidenceScope, gateFile, errors, { required: true });
    for (const item of gate.items ?? []) {
      validateEvidenceRefs(item.evidence_refs, evidenceScope, gateFile, errors, { required: item.status === 'PASS' });
    }
    for (const decisionId of gate.approved_decision_ids ?? []) {
      const approval = approvals.resolvedApprovals.get(decisionId);
      const gateTask = gate.task_id === null ? null : taskState.tasks.find((task) => task.task_id === gate.task_id);
      if (!approval || !['APPROVED', 'MODIFIED'].includes(approval.response.outcome)) {
        errors.push(issue('GATE_APPROVAL_NOT_RESOLVED', gateFile, `approved decision is not resolved: ${decisionId}`));
      } else if (approval.request.workflow_id !== gate.workflow_id
        || (gate.task_id === null && (approval.request.task_id !== null || approval.request.run_id !== null))
        || (gate.task_id !== null && (!gateTask || approval.request.task_id !== gate.task_id || approval.request.run_id !== gateTask.run_id))) {
        errors.push(issue('GATE_APPROVAL_SCOPE_MISMATCH', gateFile, 'approved decision scope does not match gate scope'));
      }
    }
    if (gate.gate_name === 'ArchitectureGate' && gate.overall === 'PASS') {
      const architectureAssessment = assessments.find(({ assessment }) => assessment.scope === 'ARCHITECTURE'
        && assessment.task_id === null && assessment.run_id === null);
      if (!architectureAssessment) {
        errors.push(issue('ARCHITECTURE_APPROVAL_ASSESSMENT_REQUIRED', gateFile, 'PASS ArchitectureGate requires an architecture approval assessment'));
      } else {
        for (const evaluation of architectureAssessment.assessment.evaluations ?? []) {
          if (evaluation.status === 'REQUIRES_APPROVAL' && !(gate.approved_decision_ids ?? []).includes(evaluation.decision_id)) {
            errors.push(issue('ARCHITECTURE_GATE_APPROVAL_REQUIRED', gateFile, `PASS ArchitectureGate must reference approval ${evaluation.decision_id}`));
          }
        }
      }
    }
    if (['ReviewGate', 'SecurityGate', 'ReleaseReadinessGate'].includes(gate.gate_name)
        && taskState.blockingFindings.length > 0
        && gate.overall === 'PASS') {
      errors.push(issue('OPEN_BLOCKING_FINDING', gateFile, 'gate cannot PASS with open BLOCKER, CRITICAL, or HIGH findings'));
    }
    if (['ReviewGate', 'SecurityGate'].includes(gate.gate_name) && gate.overall === 'PASS') {
      const gateEvidenceRefs = new Set(gate.evidence_refs ?? []);
      for (const item of gate.items ?? []) {
        for (const reference of item.evidence_refs ?? []) gateEvidenceRefs.add(reference);
      }
      const hasCurrentReviewEvidence = [...gateEvidenceRefs].some((reference) => (
        taskState.currentCandidateReviewEvidenceIds.has(reference)
      ));
      if (!hasCurrentReviewEvidence) {
        errors.push(issue('CURRENT_REVIEW_EVIDENCE_REQUIRED', gateFile, 'PASS ReviewGate or SecurityGate requires evidence from a current-candidate review-agent task'));
      }
    }
    if (gate.gate_name === 'ReleaseReadinessGate') {
      const gateTasks = gate.task_id === null
        ? []
        : taskState.tasks.filter((task) => task.task_id === gate.task_id);
      const gateTask = gateTasks.length === 1 ? gateTasks[0] : null;
      if (gate.task_id === null) {
        errors.push(issue('RELEASE_GATE_TASK_REQUIRED', gateFile, 'ReleaseReadinessGate must bind a release verification task'));
      } else if (!gateTask
        || gateTask.task_type !== 'RELEASE_VERIFICATION'
        || gateTask.assigned_agent !== 'release-agent') {
        errors.push(issue('RELEASE_GATE_TASK_SCOPE_MISMATCH', gateFile, 'ReleaseReadinessGate task must be the current release-agent verification task'));
      }
      const gateTaskKey = gateTask ? scopeKey(gateTask.task_id, gateTask.run_id) : null;
      const isCurrentReleaseGate = gateTaskKey !== null && taskState.currentReleaseTaskKey === gateTaskKey;
      if (isCurrentReleaseGate) currentReleaseGateCount += 1;
      const matchingDecisions = taskState.releaseDecisions.filter(({ decision }) => gateTask
        && decision.workflow_id === workflow.workflow_id
        && decision.task_id === gateTask.task_id
        && decision.run_id === gateTask.run_id
        && decision.candidate_commit === gateTask.input_commit);
      if (matchingDecisions.length !== 1) {
        errors.push(issue('RELEASE_DECISION_REQUIRED', gateFile, 'release gate requires exactly one decision for its current release task and run'));
      }
      if (matchingDecisions.length > 1) {
        errors.push(issue('AMBIGUOUS_RELEASE_DECISION', gateFile, 'multiple release decisions match the gate current task and run'));
      }
      const verdict = matchingDecisions[0]?.decision.verdict;
      const verdictOverall = { GO: 'PASS', NO_GO: 'FAIL', HOLD: 'HOLD' }[verdict];
      if (verdictOverall && gate.overall !== verdictOverall) {
        errors.push(issue('RELEASE_VERDICT_MISMATCH', gateFile, `release verdict ${verdict} requires ${verdictOverall}`));
      }
      const expectedStatus = { GO: 'READY_FOR_OPERATIONS_HANDOFF', NO_GO: 'RELEASE_NO_GO', HOLD: 'RELEASE_HOLD' }[verdict];
      const isTerminal = new Set(machine.workflow?.terminal_statuses ?? []).has(workflow.status);
      if (isCurrentReleaseGate && isTerminal && expectedStatus && workflow.status !== expectedStatus) {
        errors.push(issue('RELEASE_WORKFLOW_STATUS_MISMATCH', gateFile, `release verdict ${verdict} requires workflow status ${expectedStatus}`));
      }
    }
  }
  if (['READY_FOR_OPERATIONS_HANDOFF', 'RELEASE_NO_GO'].includes(workflow.status)
    && taskState.currentReleaseTaskKey !== null
    && currentReleaseGateCount !== 1) {
    errors.push(issue('RELEASE_CURRENT_GATE_REQUIRED', join(workflowDir, 'gates'), 'release terminal status requires exactly one gate for the latest current-candidate release task/run'));
  }
}

function validateGitCandidate(workflow, errors) {
  if (workflow.current_candidate_commit === null) return;
  const result = spawnSync('git', ['-C', workflow.target_project_root_abs, 'rev-parse', workflow.integration_branch], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    errors.push(issue('GIT_CANDIDATE_UNREADABLE', '$.current_candidate_commit', result.stderr.trim() || 'git rev-parse failed'));
    return;
  }
  if (result.stdout.trim() !== workflow.current_candidate_commit) {
    errors.push(issue('GIT_CANDIDATE_MISMATCH', '$.current_candidate_commit', 'workflow candidate does not match integration branch HEAD'));
  }
}

function validateTransactionJournals(workflow, workflowDir, runtimeRoot, projectRoot, errors) {
  const transactionsRoot = join(workflowDir, 'transactions');
  if (!existsSync(transactionsRoot)) return;
  const schema = readJson(join(projectRoot, 'contracts', 'transaction.schema.json'));
  for (const entry of readdirSync(transactionsRoot, { withFileTypes: true })) {
    const transactionDir = join(transactionsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(issue('TRANSACTION_DIR_SYMLINK', transactionDir, 'transaction directories must not be symbolic links'));
      continue;
    }
    if (!entry.isDirectory() || !entry.name.startsWith('TXN-')) {
      errors.push(issue('TRANSACTION_LAYOUT_INVALID', transactionDir, 'transactions must be stored in TXN-* directories'));
      continue;
    }
    const journalPath = join(transactionDir, 'transaction.json');
    if (!existsSync(journalPath)) {
      errors.push(issue('TRANSACTION_JOURNAL_REQUIRED', journalPath, 'transaction directory is missing transaction.json'));
      continue;
    }
    if (rejectSymlink(journalPath, errors, 'TRANSACTION_JOURNAL_SYMLINK')) continue;
    const journal = readJsonForCheck(journalPath, errors);
    if (!journal || !addSchemaErrors(errors, journal, schema, journalPath)) continue;
    if (journal.transaction_id !== entry.name || journal.workflow_id !== workflow.workflow_id) {
      errors.push(issue('TRANSACTION_SCOPE_MISMATCH', journalPath, 'transaction directory or workflow scope does not match journal'));
    }
    if (journal.target_revision !== journal.expected_revision + 1) {
      errors.push(issue('TRANSACTION_REVISION_MISMATCH', journalPath, 'target_revision must equal expected_revision + 1'));
    }
    if (journal.status !== 'COMMITTED') {
      errors.push(issue('INCOMPLETE_WORKFLOW_TRANSACTION', journalPath, 'incomplete transaction must be recovered before workflow validation'));
    } else if (journal.committed_at === null || journal.operations.some((operation) => !operation.applied || operation.applied_at === null)) {
      errors.push(issue('TRANSACTION_COMMIT_INCOMPLETE', journalPath, 'committed transaction must mark every operation applied'));
    }
    const expectedTargets = {
      'event-chain': join(workflowDir, 'events.jsonl'),
      workflow: join(workflowDir, 'workflow.json'),
      'active-index': join(runtimeRoot, 'control', 'active-workflows.json'),
    };
    const targetPaths = new Set();
    for (const operation of journal.operations) {
      if (targetPaths.has(operation.target_path_abs)) errors.push(issue('TRANSACTION_DUPLICATE_TARGET', journalPath, `transaction target is repeated: ${operation.target_path_abs}`));
      targetPaths.add(operation.target_path_abs);
      if (!isPathLexicallyWithin(transactionDir, operation.staged_path_abs)) {
        errors.push(issue('TRANSACTION_STAGE_PATH_ESCAPE', journalPath, `staged path escapes transaction directory: ${operation.staged_path_abs}`));
      }
      if (expectedTargets[operation.kind] && resolve(operation.target_path_abs) !== resolve(expectedTargets[operation.kind])) {
        errors.push(issue('TRANSACTION_TARGET_MISMATCH', journalPath, `${operation.kind} target is not canonical`));
      } else if (operation.kind === 'task-current'
        && (!isPathLexicallyWithin(join(workflowDir, 'tasks'), operation.target_path_abs) || !operation.target_path_abs.endsWith('.json'))) {
        errors.push(issue('TRANSACTION_TARGET_MISMATCH', journalPath, 'task-current target must be a control task JSON file'));
      } else if (operation.kind === 'task-run-history'
        && (!isPathLexicallyWithin(join(workflowDir, 'task-runs'), operation.target_path_abs) || !operation.target_path_abs.endsWith('.json'))) {
        errors.push(issue('TRANSACTION_TARGET_MISMATCH', journalPath, 'task-run-history target must be an immutable task run JSON file'));
      }
    }
  }
}

function checkWorkflowCommand(options, command = 'check-workflow') {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier')] }, 1);
    return;
  }
  let trustedRuntimeRoot;
  try {
    trustedRuntimeRoot = realpathSync(runtimeRoot);
  } catch (error) {
    emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('RUNTIME_ROOT_UNREADABLE', runtimeRoot, error.message)] }, 1);
    return;
  }
  for (const runtimeSubtree of [['control', 'workflows'], ['artifacts'], ['worktrees']]) {
    const root = join(runtimeRoot, ...runtimeSubtree);
    if (!isRealPathWithin(trustedRuntimeRoot, root)) {
      emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('RUNTIME_ROOT_ESCAPE', root, `${runtimeSubtree.join(sep)} must resolve below the trusted runtime root`)] }, 1);
      return;
    }
  }
  const workflowDir = join(runtimeRoot, 'control', 'workflows', workflowId);
  if (!isRealPathWithin(join(runtimeRoot, 'control', 'workflows'), workflowDir)) {
    emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('WORKFLOW_DIR_ESCAPE', workflowDir, 'workflow directory must resolve inside runtime control/workflows')] }, 1);
    return;
  }
  const errors = [];
  const workflowSchema = readJson(join(projectRoot, 'contracts', 'workflow.schema.json'));
  const activeSchema = readJson(join(projectRoot, 'contracts', 'active-workflows.schema.json'));
  const eventSchema = readJson(join(projectRoot, 'contracts', 'workflow-event.schema.json'));
  const machine = readJson(join(projectRoot, 'config', 'workflow-state-machine.json'));
  validateStateMachine(machine, errors);

  const workflowPath = join(workflowDir, 'workflow.json');
  const activePath = join(runtimeRoot, 'control', 'active-workflows.json');
  const eventsPath = join(workflowDir, 'events.jsonl');
  for (const [path, code] of [[workflowPath, 'WORKFLOW_FILE_SYMLINK'], [activePath, 'ACTIVE_INDEX_SYMLINK'], [eventsPath, 'EVENT_CHAIN_SYMLINK']]) {
    if (existsSync(path)) rejectSymlink(path, errors, code);
  }
  const workflow = readJsonForCheck(workflowPath, errors);
  const active = readJsonForCheck(activePath, errors);
  if (!workflow || !active) {
    emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
    return;
  }
  addSchemaErrors(errors, workflow, workflowSchema, workflowPath);
  addSchemaErrors(errors, active, activeSchema, activePath);
  // Do not dereference snapshot fields until the schema establishes they exist.
  // This keeps malformed or legacy control files diagnosable as HOLD instead of
  // degrading into a generic CLI usage error.
  if (errors.length > 0) {
    appendGuardFailureLog(options, workflowPath, errors);
    emit({
      ok: false,
      command,
      workflow_id: workflowId,
      effective_status: 'HOLD',
      errors,
    }, 1);
    return;
  }
  if (workflow.workflow_id !== workflowId) {
    errors.push(issue('WORKFLOW_ID_MISMATCH', workflowPath, 'workflow_id does not match requested workflow'));
  }
  if (!isSameRealPath(workflow.runtime_root_abs, runtimeRoot)) {
    errors.push(issue('RUNTIME_ROOT_MISMATCH', '$.runtime_root_abs', 'workflow runtime root does not match command runtime root'));
  }
  const activeWorkflowIds = new Set();
  for (const entry of active.workflows ?? []) {
    if (activeWorkflowIds.has(entry.workflow_id)) {
      errors.push(issue('DUPLICATE_ACTIVE_WORKFLOW_ID', activePath, `active workflow is listed more than once: ${entry.workflow_id}`));
    }
    activeWorkflowIds.add(entry.workflow_id);
  }
  const activeEntries = (active.workflows ?? []).filter((entry) => entry.workflow_id === workflowId);
  const isTerminal = new Set(machine.workflow?.terminal_statuses ?? []).has(workflow.status);
  if (isTerminal && activeEntries.length !== 0) {
    errors.push(issue('TERMINAL_ACTIVE_WORKFLOW_ENTRY', activePath, `terminal workflow must have zero active entries, found ${activeEntries.length}`));
  } else if (!isTerminal && activeEntries.length !== 1) {
    errors.push(issue('ACTIVE_WORKFLOW_ENTRY_COUNT', activePath, `nonterminal workflow requires one active entry, found ${activeEntries.length}`));
  } else if (isTerminal) {
    const finalReport = join(workflowDir, 'final-report.md');
    if (!existsSync(finalReport) || !readFileSync(finalReport, 'utf8').trim()) {
      errors.push(issue('FINAL_REPORT_REQUIRED', finalReport, 'terminal workflow requires a non-empty final-report.md'));
    }
    if (workflow.status === 'QUARANTINED') {
      const quarantineReport = join(workflowDir, 'quarantine-report.md');
      if (!existsSync(quarantineReport) || !readFileSync(quarantineReport, 'utf8').trim()) {
        errors.push(issue('QUARANTINE_REPORT_REQUIRED', quarantineReport, 'quarantined workflow requires a non-empty quarantine-report.md'));
      }
    }
  } else {
    const entry = activeEntries[0];
    const fields = ['status', 'current_phase', 'current_candidate_commit', 'state_revision', 'updated_at'];
    for (const field of fields) {
      if (!equalJson(entry[field], workflow[field])) {
        errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:${field}`, `active entry does not match workflow ${field}`));
      }
    }
    if (!isSameRealPath(entry.workflow_json_abs, workflowPath)) {
      errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:workflow_json_abs`, 'active entry points to a different workflow.json'));
    }
  }

  const eventRecords = readJsonLinesForCheck(eventsPath, errors).map((record) => record.value);
  validateEventChain(eventRecords, workflow, machine, eventSchema, errors);
  validateTransactionJournals(workflow, workflowDir, runtimeRoot, projectRoot, errors);
  validateWorkflowSnapshots(workflow, workflowDir, errors);
  // Quarantine is an auditable terminal boundary, not a repair mode. Once the
  // immutable evidence and terminal snapshots are verified, historical task
  // defects must remain preserved rather than preventing its removal from the
  // active recovery index.
  if (workflow.status === 'QUARANTINED') {
    if (errors.length > 0) {
      appendGuardFailureLog(options, workflowPath, errors);
      emit({ ok: false, command, workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
      return;
    }
    emit({
      ok: true,
      command,
      workflow_id: workflowId,
      effective_status: workflow.status,
      state_revision: workflow.state_revision,
      event_count: eventRecords.length,
      quarantined: true,
    });
    return;
  }
  const taskState = validateTasks({ workflow, workflowDir, projectRoot, eventRecords, errors });
  validateDispatchLedgers({ workflow, workflowDir, projectRoot, taskState, errors });
  const approvals = validateApprovals({ workflow, workflowDir, projectRoot, taskState, errors });
  const assessments = validateApprovalAssessments({ workflow, workflowDir, projectRoot, approvals, taskState, errors });
  validateGates({ workflow, workflowDir, projectRoot, machine, approvals, assessments, taskState, errors });
  validateGitCandidate(workflow, errors);

  if (errors.length > 0) {
    appendGuardFailureLog(options, workflowPath, errors);
    emit({
      ok: false,
      command,
      workflow_id: workflowId,
      effective_status: 'HOLD',
      errors,
    }, 1);
    return;
  }
  emit({
    ok: true,
    command,
    workflow_id: workflowId,
    effective_status: workflow.status,
    state_revision: workflow.state_revision,
    event_count: eventRecords.length,
    task_count: taskState.tasks.length,
    pending_decision_count: approvals.pendingIds.length,
  });
}

function checkTaskPackageCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  const taskId = requireOption(options, 'task-id');
  const taskFile = resolve(requireOption(options, 'task-file'));
  const errors = [];
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    errors.push(issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier'));
  }
  if (!/^TASK-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(taskId)) {
    errors.push(issue('INVALID_TASK_ID', '$.task-id', 'task-id must be a complete safe TASK identifier'));
  }
  const workflowDir = validateTrustedRuntimeLayout(runtimeRoot, workflowId, errors)
    ?? join(runtimeRoot, 'control', 'workflows', workflowId);
  const expectedTaskFile = join(workflowDir, 'tasks', `${taskId}.json`);
  if (existsSync(expectedTaskFile)) rejectSymlink(expectedTaskFile, errors, 'TASK_CONTROL_FILE_SYMLINK');
  if (!isRealPathWithin(join(workflowDir, 'tasks'), expectedTaskFile)
    || !isSameRealPath(taskFile, expectedTaskFile)) {
    errors.push(issue('TASK_CONTROL_PATH_MISMATCH', taskFile, 'task-file must be the canonical control/workflows/<workflow>/tasks/<task>.json path'));
  }
  const workflow = readJsonForCheck(join(workflowDir, 'workflow.json'), errors);
  const task = readJsonForCheck(taskFile, errors);
  if (workflow) {
    const workflowSchema = readJson(join(projectRoot, 'contracts', 'workflow.schema.json'));
    const workflowSchemaValid = addSchemaErrors(errors, workflow, workflowSchema, join(workflowDir, 'workflow.json'));
    if (workflowSchemaValid && !isSameRealPath(workflow.runtime_root_abs, runtimeRoot)) {
      errors.push(issue('RUNTIME_ROOT_MISMATCH', '$.runtime_root_abs', 'workflow runtime root does not match command runtime root'));
    }
  }
  if (task) {
    const taskSchema = readJson(join(projectRoot, 'contracts', 'task.schema.json'));
    const contextSchema = readJson(join(projectRoot, 'contracts', 'context-manifest.schema.json'));
    const taskSchemaValid = addSchemaErrors(errors, task, taskSchema, taskFile);
    if (taskSchemaValid && task.task_id !== taskId) {
      errors.push(issue('TASK_ID_MISMATCH', taskFile, 'task task_id does not match requested task-id'));
    }
    if (taskSchemaValid && workflow && task.workflow_id !== workflow.workflow_id) {
      errors.push(issue('TASK_WORKFLOW_MISMATCH', taskFile, 'task workflow_id does not match workflow'));
    }
    if (taskSchemaValid && workflow) validateTaskPaths(task, taskFile, workflow, errors);
    // A dispatch preflight always requires the complete immutable input package,
    // even while the control task is still in CREATED or READY state.
    if (taskSchemaValid) validateTaskContext(task, taskFile, contextSchema, errors);
  }
  if (errors.length > 0) {
    appendGuardFailureLog(options, taskFile, errors);
    emit({ ok: false, command: 'check-task-package', workflow_id: workflowId, task_id: taskId, effective_status: 'HOLD', errors }, 1);
    return;
  }
  emit({ ok: true, command: 'check-task-package', workflow_id: workflowId, task_id: taskId });
}

function recoveryCheckCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const activePath = join(runtimeRoot, 'control', 'active-workflows.json');
  const errors = [];
  const active = readJsonForCheck(activePath, errors);
  if (active) {
    const activeSchema = readJson(join(projectRoot, 'contracts', 'active-workflows.schema.json'));
    addSchemaErrors(errors, active, activeSchema, activePath);
  }
  if (!active || !Array.isArray(active.workflows)) {
    emit({ ok: false, command: 'recovery-check', effective_status: 'HOLD', errors: errors.length > 0 ? errors : [issue('ACTIVE_WORKFLOW_INDEX_INVALID', activePath, 'active workflow index is invalid')] }, 1);
    return;
  }
  let workflowId = options['workflow-id'];
  if (!workflowId) {
    if (active.workflows.length === 0) {
      emit({ ok: false, command: 'recovery-check', effective_status: 'HOLD', errors: [issue('NO_ACTIVE_WORKFLOW', activePath, 'no active workflow is available for recovery')] }, 1);
      return;
    }
    if (active.workflows.length > 1) {
      emit({ ok: false, command: 'recovery-check', effective_status: 'HOLD', active_workflow_ids: active.workflows.map((entry) => entry.workflow_id), errors: [issue('RECOVERY_SELECTION_REQUIRED', activePath, 'multiple active workflows require an explicit --workflow-id')] }, 1);
      return;
    }
    workflowId = active.workflows[0].workflow_id;
  }
  checkWorkflowCommand({ ...options, 'workflow-id': workflowId }, 'recovery-check');
}

function selfCheckCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const errors = [];
  const contractsDir = join(projectRoot, 'contracts');
  for (const schemaPath of jsonFiles(contractsDir, '.schema.json')) {
    const schema = readJsonForCheck(schemaPath, errors);
    if (schema) {
      try {
        createAjv(schema).compile(schema);
      } catch (error) {
        errors.push({ ...issue('SCHEMA_COMPILE_ERROR', '$', error.message), source: schemaPath });
      }
    }
  }
  const machine = readJsonForCheck(join(projectRoot, 'config', 'workflow-state-machine.json'), errors);
  if (machine) validateStateMachine(machine, errors);
  const templateMappings = [
    ['active-workflows.json', 'active-workflows.schema.json', false],
    ['workflow-event.json', 'workflow-event.schema.json', false],
    ['workflow.json', 'workflow.schema.json', true],
    ['task.json', 'task.schema.json', true],
    ['result.json', 'result.schema.json', true],
    ['context-manifest.json', 'context-manifest.schema.json', true],
    ['component-request.json', 'component-request.schema.json', true],
    ['gate-result.json', 'gate-result.schema.json', true],
    ['approval-request.json', 'approval-request.schema.json', true],
    ['approval-response.json', 'approval-response.schema.json', true],
    ['approval-assessment.json', 'approval-assessment.schema.json', true],
  ];
  for (const [templateName, schemaName, allowPlaceholders] of templateMappings) {
    const templatePath = join(projectRoot, 'templates', templateName);
    const schemaPath = join(projectRoot, 'contracts', schemaName);
    const template = readJsonForCheck(templatePath, errors);
    const schema = readJsonForCheck(schemaPath, errors);
    if (template && schema) addSchemaErrors(errors, template, schema, templatePath, { allowPlaceholders });
  }
  if (errors.length > 0) {
    appendGuardFailureLog(options, projectRoot, errors);
    emit({ ok: false, command: 'self-check', effective_status: 'HOLD', errors }, 1);
    return;
  }
  emit({ ok: true, command: 'self-check', contracts: jsonFiles(contractsDir, '.schema.json').length, templates: templateMappings.length });
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'validate-file') {
      validateFileCommand(options);
      return;
    }
    if (command === 'append-event') {
      appendEventCommand(options);
      return;
    }
    if (command === 'commit-transition') {
      commitTransitionCommand(options);
      return;
    }
    if (command === 'recover-transactions') {
      recoverTransactionsCommand(options);
      return;
    }
    if (command === 'prepare-dispatch') {
      prepareDispatchCommand(options);
      return;
    }
    if (command === 'record-dispatch-receipt') {
      recordDispatchReceiptCommand(options);
      return;
    }
    if (command === 'record-completion-receipt') {
      recordCompletionReceiptCommand(options);
      return;
    }
    if (command === 'dead-letter-dispatch') {
      deadLetterDispatchCommand(options);
      return;
    }
    if (command === 'reconcile-dispatch') {
      reconcileDispatchCommand(options);
      return;
    }
    if (command === 'check-workflow') {
      checkWorkflowCommand(options);
      return;
    }
    if (command === 'check-task-package') {
      checkTaskPackageCommand(options);
      return;
    }
    if (command === 'recovery-check') {
      recoveryCheckCommand(options);
      return;
    }
    if (command === 'self-check') {
      selfCheckCommand(options);
      return;
    }
    throw new Error(`unknown command: ${command ?? '<missing>'}`);
  } catch (error) {
    const errors = [error.guardIssue ?? issue('GUARD_USAGE_ERROR', '$', error.message)];
    emit({ ok: false, effective_status: 'HOLD', errors }, 1);
  }
}

main();
