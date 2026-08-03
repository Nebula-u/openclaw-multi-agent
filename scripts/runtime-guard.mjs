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
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const VALIDATOR_NAME = 'ajv';
const LOG_EXCERPT_LIMIT = 16 * 1024;

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
      'run-id',
      'attempt',
      'retry-count',
      'retry-prompt',
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
  const values = [];
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    if (!rawLine.trim()) continue;
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
    const validate = createAjv(schema).compile(schema);
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

function jsonFiles(path, suffix = '.json') {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(path, name));
}

function addSchemaErrors(errors, value, schema, source, options = {}) {
  for (const error of validateInstance(value, schema, options)) {
    errors.push({ ...error, source });
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
    invalid_content_excerpt: rawContent.slice(0, LOG_EXCERPT_LIMIT),
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
  let acquired = false;
  try {
    try {
      lock = openSync(lockPath, 'wx');
      acquired = true;
    } catch (error) {
      error.guardIssue = issue('EVENT_LOCK_CONFLICT', lockPath, 'events chain is already locked');
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
    if (lock !== undefined) closeSync(lock);
    if (acquired && existsSync(lockPath)) unlinkSync(lockPath);
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
  for (const [index, event] of events.entries()) {
    addSchemaErrors(errors, event, eventSchema, `events.jsonl:${index + 1}`);
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

function validateTasks({ workflow, workflowDir, projectRoot, eventRecords, errors }) {
  const taskSchema = readJson(join(projectRoot, 'contracts', 'task.schema.json'));
  const resultSchema = readJson(join(projectRoot, 'contracts', 'result.schema.json'));
  const evidenceSchema = readJson(join(projectRoot, 'contracts', 'evidence.schema.json'));
  const commandSchema = readJson(join(projectRoot, 'contracts', 'command-record.schema.json'));
  const reviewSchema = readJson(join(projectRoot, 'contracts', 'review-findings.schema.json'));
  const releaseSchema = readJson(join(projectRoot, 'contracts', 'release-decision.schema.json'));
  const taskFiles = jsonFiles(join(workflowDir, 'tasks'));
  const tasks = [];
  const blockingFindings = [];
  const currentCandidateFindings = [];
  const currentCandidateReviewEvidenceIds = new Set();
  const releaseDecisions = [];
  let currentReleaseTaskKey = null;
  let currentReleaseTaskSeq = -1;
  const evidenceByScope = new Map();
  const allEvidenceIds = new Set();
  for (const taskFile of taskFiles) {
    const task = readJsonForCheck(taskFile, errors);
    if (!task) continue;
    tasks.push(task);
    addSchemaErrors(errors, task, taskSchema, taskFile);
    if (task.workflow_id !== workflow.workflow_id) {
      errors.push(issue('TASK_WORKFLOW_MISMATCH', taskFile, 'task workflow_id does not match workflow'));
    }
    const runtimeArtifactsRoot = join(workflow.runtime_root_abs, 'artifacts');
    const workflowArtifactsRoot = join(runtimeArtifactsRoot, workflow.workflow_id);
    const expectedArtifactRoot = join(workflowArtifactsRoot, task.task_id, task.run_id);
    if (!isRealPathWithin(runtimeArtifactsRoot, workflowArtifactsRoot)
      || !isRealPathWithin(workflowArtifactsRoot, expectedArtifactRoot)
      || !isSameRealPath(expectedArtifactRoot, task.artifact_root_abs)) {
      errors.push(issue('ARTIFACT_PATH_ESCAPE', taskFile, 'artifact_root_abs must exactly resolve to this workflow/task/run artifact directory'));
    }
    if (!isRealPathWithin(join(workflow.runtime_root_abs, 'worktrees'), task.worktree_path_abs)) {
      errors.push(issue('WORKTREE_PATH_ESCAPE', taskFile, 'worktree_path_abs must exist under runtime worktrees without symlink escape'));
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
          if (!isAbsolute(result[field]) || resolve(result[field]) !== resolve(task[field])) {
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
    }
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
  return { tasks, blockingFindings, currentCandidateReviewEvidenceIds, currentReleaseTaskKey, releaseDecisions, evidenceByScope, allEvidenceIds };
}

function validateApprovals({ workflow, workflowDir, projectRoot, taskState, errors }) {
  const requestSchema = readJson(join(projectRoot, 'contracts', 'approval-request.schema.json'));
  const responseSchema = readJson(join(projectRoot, 'contracts', 'approval-response.schema.json'));
  const decisionDir = join(workflowDir, 'decisions');
  const requestFiles = jsonFiles(decisionDir, '.request.json');
  const pendingIds = [];
  const resolvedApprovals = new Map();
  for (const requestFile of requestFiles) {
    const request = readJsonForCheck(requestFile, errors);
    if (!request) continue;
    addSchemaErrors(errors, request, requestSchema, requestFile);
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
  return { pendingIds, resolvedApprovals };
}

function expectedGateOverall(items) {
  if (items.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (items.some((item) => item.status === 'HOLD' || (item.blocking === true && item.status === 'UNKNOWN'))) return 'HOLD';
  return 'PASS';
}

function validateGates({ workflow, workflowDir, projectRoot, machine, approvals, taskState, errors }) {
  const gateSchema = readJson(join(projectRoot, 'contracts', 'gate-result.schema.json'));
  const gateFiles = jsonFiles(join(workflowDir, 'gates'));
  let currentReleaseGateCount = 0;
  for (const gateFile of gateFiles) {
    const gate = readJsonForCheck(gateFile, errors);
    if (!gate) continue;
    addSchemaErrors(errors, gate, gateSchema, gateFile);
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

function checkWorkflowCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const runtimeRoot = resolve(requireOption(options, 'runtime-root'));
  const workflowId = requireOption(options, 'workflow-id');
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId)) {
    emit({ ok: false, command: 'check-workflow', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('INVALID_WORKFLOW_ID', '$.workflow-id', 'workflow-id must be a complete safe WF identifier')] }, 1);
    return;
  }
  let trustedRuntimeRoot;
  try {
    trustedRuntimeRoot = realpathSync(runtimeRoot);
  } catch (error) {
    emit({ ok: false, command: 'check-workflow', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('RUNTIME_ROOT_UNREADABLE', runtimeRoot, error.message)] }, 1);
    return;
  }
  for (const runtimeSubtree of [['control', 'workflows'], ['artifacts'], ['worktrees']]) {
    const root = join(runtimeRoot, ...runtimeSubtree);
    if (!isRealPathWithin(trustedRuntimeRoot, root)) {
      emit({ ok: false, command: 'check-workflow', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('RUNTIME_ROOT_ESCAPE', root, `${runtimeSubtree.join(sep)} must resolve below the trusted runtime root`)] }, 1);
      return;
    }
  }
  const workflowDir = join(runtimeRoot, 'control', 'workflows', workflowId);
  if (!isRealPathWithin(join(runtimeRoot, 'control', 'workflows'), workflowDir)) {
    emit({ ok: false, command: 'check-workflow', workflow_id: workflowId, effective_status: 'HOLD', errors: [issue('WORKFLOW_DIR_ESCAPE', workflowDir, 'workflow directory must resolve inside runtime control/workflows')] }, 1);
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
  const workflow = readJsonForCheck(workflowPath, errors);
  const active = readJsonForCheck(activePath, errors);
  if (!workflow || !active) {
    emit({ ok: false, command: 'check-workflow', workflow_id: workflowId, effective_status: 'HOLD', errors }, 1);
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
      command: 'check-workflow',
      workflow_id: workflowId,
      effective_status: 'HOLD',
      errors,
    }, 1);
    return;
  }
  if (workflow.workflow_id !== workflowId) {
    errors.push(issue('WORKFLOW_ID_MISMATCH', workflowPath, 'workflow_id does not match requested workflow'));
  }
  if (resolve(workflow.runtime_root_abs) !== runtimeRoot) {
    errors.push(issue('RUNTIME_ROOT_MISMATCH', '$.runtime_root_abs', 'workflow runtime root does not match command runtime root'));
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
  } else {
    const entry = activeEntries[0];
    const fields = ['status', 'current_phase', 'current_candidate_commit', 'state_revision', 'updated_at'];
    for (const field of fields) {
      if (!equalJson(entry[field], workflow[field])) {
        errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:${field}`, `active entry does not match workflow ${field}`));
      }
    }
    if (resolve(entry.workflow_json_abs) !== resolve(workflowPath)) {
      errors.push(issue('ACTIVE_WORKFLOW_MISMATCH', `${activePath}:workflow_json_abs`, 'active entry points to a different workflow.json'));
    }
  }

  const eventRecords = readJsonLinesForCheck(eventsPath, errors).map((record) => record.value);
  validateEventChain(eventRecords, workflow, machine, eventSchema, errors);
  const taskState = validateTasks({ workflow, workflowDir, projectRoot, eventRecords, errors });
  const approvals = validateApprovals({ workflow, workflowDir, projectRoot, taskState, errors });
  validateGates({ workflow, workflowDir, projectRoot, machine, approvals, taskState, errors });
  validateGitCandidate(workflow, errors);

  if (errors.length > 0) {
    appendGuardFailureLog(options, workflowPath, errors);
    emit({
      ok: false,
      command: 'check-workflow',
      workflow_id: workflowId,
      effective_status: 'HOLD',
      errors,
    }, 1);
    return;
  }
  emit({
    ok: true,
    command: 'check-workflow',
    workflow_id: workflowId,
    effective_status: workflow.status,
    state_revision: workflow.state_revision,
    event_count: eventRecords.length,
    task_count: taskState.tasks.length,
    pending_decision_count: approvals.pendingIds.length,
  });
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
    if (command === 'check-workflow') {
      checkWorkflowCommand(options);
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
