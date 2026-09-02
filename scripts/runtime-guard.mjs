#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Runtime Guard remains the stable CLI name used by Agent workspaces. Its
// current responsibility is deliberately narrow: validate structured JSON/
// JSONL artifacts and compile the current contract/template set. The
// SQLite Control Kernel and Orchestrator own workflow facts and approvals;
// dispatch and recovery.

const VALIDATOR_NAME = 'ajv';
const JSONL_MAX_BYTES = 5 * 1024 * 1024;
const JSONL_MAX_LINE_BYTES = 1024 * 1024;
const LOG_EXCERPT_LIMIT = 16 * 1024;
const VALIDATOR_CACHE = new Map();

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const valueOptions = new Set([
    'schema', 'file', 'project-root', 'log-file', 'stage', 'agent-id',
    'workflow-id', 'task-id', 'run-id', 'attempt', 'retry-count',
    'retry-prompt',
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === '--jsonl' || token === '--allow-placeholders') {
      options[token.slice(2)] = true;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const name = token.slice(2);
    if (!valueOptions.has(name)) throw new Error(`unknown option: --${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`);
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

function createAjv(schema) {
  const AjvClass = String(schema?.$schema ?? '').includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new AjvClass({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

function compiledValidator(schema) {
  const cacheKey = createHash('sha256').update(JSON.stringify(schema), 'utf8').digest('hex');
  if (!VALIDATOR_CACHE.has(cacheKey)) VALIDATOR_CACHE.set(cacheKey, createAjv(schema).compile(schema));
  return VALIDATOR_CACHE.get(cacheKey);
}

function schemaErrorCode(keyword) {
  const map = {
    additionalProperties: 'SCHEMA_ADDITIONAL_PROPERTY',
    const: 'SCHEMA_CONST',
    enum: 'SCHEMA_ENUM',
    format: 'SCHEMA_FORMAT',
    minItems: 'SCHEMA_MIN_ITEMS',
    minLength: 'SCHEMA_MIN_LENGTH',
    minimum: 'SCHEMA_MINIMUM',
    pattern: 'SCHEMA_PATTERN',
    required: 'SCHEMA_REQUIRED',
    type: 'SCHEMA_TYPE',
    uniqueItems: 'SCHEMA_UNIQUE_ITEMS',
  };
  return map[keyword] ?? `SCHEMA_${String(keyword).replaceAll(/[^A-Za-z0-9]+/gu, '_').toUpperCase()}`;
}

function instancePath(path) {
  if (!path) return '$';
  return path.split('/').slice(1).reduce((result, part) => {
    const decoded = part.replaceAll('~1', '/').replaceAll('~0', '~');
    return /^(0|[1-9]\d*)$/u.test(decoded) ? `${result}[${decoded}]` : `${result}.${decoded}`;
  }, '$');
}

function validateInstance(value, schema, { allowPlaceholders = false } = {}) {
  const errors = [];
  try {
    const validate = compiledValidator(schema);
    if (!validate(value)) {
      for (const error of validate.errors ?? []) {
        errors.push({
          code: schemaErrorCode(error.keyword),
          path: instancePath(error.instancePath),
          message: error.message ?? `schema validation failed: ${error.keyword}`,
          schema_keyword: error.keyword,
          schema_path: error.schemaPath,
          params: error.params ?? {},
        });
      }
    }
  } catch (error) {
    errors.push(issue('SCHEMA_COMPILE_ERROR', '$', error.message));
  }
  if (!allowPlaceholders) findPlaceholders(value, '$', errors);
  return errors;
}

function findPlaceholders(value, path, errors) {
  if (typeof value === 'string' && value.includes('<PLACEHOLDER:')) {
    errors.push(issue('RUNTIME_PLACEHOLDER', path, 'runtime artifact contains an unresolved placeholder'));
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => findPlaceholders(item, `${path}[${index}]`, errors));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) findPlaceholders(child, `${path}.${key}`, errors);
  }
}

function redactSensitiveExcerpt(content) {
  return content
    .replaceAll(/((?:"?(?:api[_-]?key|authorization|password|secret|token)"?\s*[=:]\s*["']?))[^\s,;"']+/giu, '$1<REDACTED>')
    .replaceAll(/(bearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1<REDACTED>')
    .slice(0, LOG_EXCERPT_LIMIT);
}

function validationFailureRecord({ options, schemaPath, filePath, errors }) {
  let rawContent = '';
  try { rawContent = existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''; } catch { /* best effort */ }
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
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(validationFailureRecord({ options, schemaPath, filePath, errors }))}\n`, 'utf8');
}

function requireOption(options, name) {
  if (!options[name]) throw new Error(`missing required option --${name}`);
  return options[name];
}

function validateRecords(records, schema, source, errors, { allowPlaceholders = false } = {}) {
  for (const record of records) {
    const recordErrors = validateInstance(record.value, schema, { allowPlaceholders });
    for (const error of recordErrors) {
      errors.push({
        ...error,
        path: record.line ? `${source}:${record.line}${error.path.slice(1)}` : error.path,
        source,
      });
    }
  }
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
  if (options.jsonl && records.length === 0) errors.push(issue('JSONL_EMPTY', filePath, 'JSONL input must contain at least one record'));
  const idField = schemaPath.endsWith('evidence.schema.json') ? 'evidence_id'
    : schemaPath.endsWith('command-record.schema.json') ? 'command_record_id' : null;
  const ids = new Set();
  for (const record of records) {
    const recordErrors = validateInstance(record.value, schema, { allowPlaceholders: Boolean(options['allow-placeholders']) });
    for (const error of recordErrors) {
      errors.push({ ...error, path: record.line ? `${filePath}:${record.line}${error.path.slice(1)}` : error.path });
    }
    if (idField && typeof record.value?.[idField] === 'string') {
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

function readJsonForCheck(path, errors) {
  try { return readJson(path); }
  catch (error) { errors.push(error.guardIssue ?? issue('JSON_READ_ERROR', path, error.message)); return null; }
}

function selfCheckCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const errors = [];
  const contractsDir = join(projectRoot, 'contracts');
  const contractFiles = existsSync(contractsDir)
    ? readdirSync(contractsDir).filter((name) => name.endsWith('.schema.json')).sort().map((name) => join(contractsDir, name))
    : [];
  for (const schemaPath of contractFiles) {
    const schema = readJsonForCheck(schemaPath, errors);
    if (schema) {
      try { createAjv(schema).compile(schema); }
      catch (error) { errors.push({ ...issue('SCHEMA_COMPILE_ERROR', '$', error.message), source: schemaPath }); }
    }
  }
  const mappings = [
    ['approval-assessment.json', 'approval-assessment.schema.json', 'json'],
    ['approval-request.json', 'approval-request.schema.json', 'json'],
    ['approval-response.json', 'approval-response.schema.json', 'json'],
    ['command-records.jsonl', 'command-record.schema.json', 'jsonl'],
    ['component-request.json', 'component-request.schema.json', 'json'],
    ['context-manifest.json', 'context-manifest.schema.json', 'json'],
    ['evidence.jsonl', 'evidence.schema.json', 'jsonl'],
    ['gate-result.json', 'gate-result.schema.json', 'json'],
    ['result.json', 'result.schema.json', 'json'],
    ['task.json', 'task.schema.json', 'json'],
  ];
  for (const [templateName, schemaName, format] of mappings) {
    const templatePath = join(projectRoot, 'templates', templateName);
    const schemaPath = join(contractsDir, schemaName);
    const schema = readJsonForCheck(schemaPath, errors);
    if (!schema) continue;
    try {
      const records = format === 'jsonl'
        ? readJsonLines(templatePath)
        : [{ line: null, value: readJson(templatePath) }];
      validateRecords(records, schema, templatePath, errors, { allowPlaceholders: true });
    } catch (error) {
      errors.push(error.guardIssue ?? issue('JSON_READ_ERROR', templatePath, error.message));
    }
  }
  if (errors.length > 0) {
    appendValidationFailureLog({ ...options, stage: options.stage ?? 'self_check', 'log-file': options['log-file'] }, projectRoot, projectRoot, errors);
    emit({ ok: false, command: 'self-check', effective_status: 'HOLD', errors }, 1);
    return;
  }
  emit({ ok: true, command: 'self-check', contracts: contractFiles.length, templates: mappings.length });
}

function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));
    if (command === 'validate-file') return validateFileCommand(options);
    if (command === 'self-check') return selfCheckCommand(options);
    throw new Error(`unknown command: ${command ?? '<missing>'}; supported commands: validate-file, self-check`);
  } catch (error) {
    emit({ ok: false, effective_status: 'HOLD', errors: [error.guardIssue ?? issue('GUARD_USAGE_ERROR', '$', error.message)] }, 1);
  }
}

main();
