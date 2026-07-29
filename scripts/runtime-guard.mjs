#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const SUPPORTED_SCHEMA_KEYS = new Set([
  '$id',
  '$ref',
  '$schema',
  'additionalProperties',
  'const',
  'default',
  'definitions',
  'description',
  'enum',
  'format',
  'items',
  'minimum',
  'minItems',
  'minLength',
  'pattern',
  'properties',
  'required',
  'title',
  'type',
  'uniqueItems',
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${token}`);
    }
    const name = token.slice(2);
    if (['jsonl', 'allow-placeholders', 'skip-git'].includes(name)) {
      options[name] = true;
      continue;
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

function matchesType(value, type) {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'null': return value === null;
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'object': return isObject(value);
    case 'string': return typeof value === 'string';
    default: return false;
  }
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveLocalRef(rootSchema, reference) {
  if (!reference.startsWith('#/')) {
    throw new Error(`only local JSON Schema references are supported: ${reference}`);
  }
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, part) => value?.[part], rootSchema);
}

function assertSupportedSchema(schema, path = '#', errors = []) {
  if (!isObject(schema)) return errors;
  for (const [key, value] of Object.entries(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      errors.push(issue('UNSUPPORTED_SCHEMA_KEYWORD', `${path}/${key}`, `unsupported keyword: ${key}`));
      continue;
    }
    if (key === 'properties' || key === 'definitions') {
      if (isObject(value)) {
        for (const [name, child] of Object.entries(value)) {
          assertSupportedSchema(child, `${path}/${key}/${name}`, errors);
        }
      }
    } else if (key === 'items' || (key === 'additionalProperties' && isObject(value))) {
      assertSupportedSchema(value, `${path}/${key}`, errors);
    }
  }
  return errors;
}

function validateDateTime(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function validateValue(value, schema, rootSchema, path = '$', errors = []) {
  if (schema.$ref) {
    const referenced = resolveLocalRef(rootSchema, schema.$ref);
    if (!referenced) {
      errors.push(issue('SCHEMA_REF_NOT_FOUND', path, `reference not found: ${schema.$ref}`));
      return errors;
    }
    return validateValue(value, referenced, rootSchema, path, errors);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(issue('SCHEMA_TYPE', path, `expected ${types.join('|')}`));
      return errors;
    }
  }

  if (schema.const !== undefined && !equalJson(value, schema.const)) {
    errors.push(issue('SCHEMA_CONST', path, `expected ${JSON.stringify(schema.const)}`));
  }
  if (schema.enum && !schema.enum.some((candidate) => equalJson(value, candidate))) {
    errors.push(issue('SCHEMA_ENUM', path, `value is not in enum ${JSON.stringify(schema.enum)}`));
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(issue('SCHEMA_MINIMUM', path, `must be >= ${schema.minimum}`));
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(issue('SCHEMA_MIN_LENGTH', path, `must have at least ${schema.minLength} characters`));
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(issue('SCHEMA_PATTERN', path, `must match ${schema.pattern}`));
    }
    if (schema.format === 'date-time' && !validateDateTime(value)) {
      errors.push(issue('SCHEMA_FORMAT', path, 'must be an RFC 3339 date-time'));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(issue('SCHEMA_MIN_ITEMS', path, `must contain at least ${schema.minItems} items`));
    }
    if (schema.items) {
      value.forEach((item, index) => validateValue(item, schema.items, rootSchema, `${path}[${index}]`, errors));
    }
    if (schema.uniqueItems === true) {
      const identities = value.map((item) => JSON.stringify(canonicalize(item)));
      if (new Set(identities).size !== identities.length) {
        errors.push(issue('SCHEMA_UNIQUE_ITEMS', path, 'array items must be unique'));
      }
    }
  }

  if (isObject(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(issue('SCHEMA_REQUIRED', path, `missing required property: ${required}`));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateValue(child, properties[key], rootSchema, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(issue('SCHEMA_ADDITIONAL_PROPERTY', `${path}.${key}`, 'additional property is not allowed'));
      } else if (isObject(schema.additionalProperties)) {
        validateValue(child, schema.additionalProperties, rootSchema, `${path}.${key}`, errors);
      }
    }
  }

  return errors;
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
  const errors = assertSupportedSchema(schema);
  validateValue(value, schema, schema, '$', errors);
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
  const canonical = JSON.stringify(canonicalize(unsigned));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameStringSet(left, right) {
  return equalJson(sortedUnique(left), sortedUnique(right));
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
  const schema = readJson(schemaPath);
  const records = options.jsonl ? readJsonLines(filePath) : [{ line: null, value: readJson(filePath) }];
  const errors = [];
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
    emit({ ok: false, command: 'validate-file', file: filePath, errors }, 1);
    return;
  }
  emit({ ok: true, command: 'validate-file', file: filePath, records: records.length });
}

function appendEventCommand(options) {
  const projectRoot = resolve(requireOption(options, 'project-root'));
  const eventsPath = resolve(requireOption(options, 'events'));
  const draftPath = resolve(requireOption(options, 'event'));
  const eventSchema = readJson(join(projectRoot, 'contracts', 'workflow-event.schema.json'));
  const existing = existsSync(eventsPath) ? readJsonLines(eventsPath).map((record) => record.value) : [];
  const draft = readJson(draftPath);
  const errors = [];
  let prior = null;
  for (const [index, existingEvent] of existing.entries()) {
    const source = `events.jsonl:${index + 1}`;
    addSchemaErrors(errors, existingEvent, eventSchema, source);
    const expectedSequence = index + 1;
    if (existingEvent.seq !== expectedSequence || existingEvent.state_revision !== expectedSequence) {
      errors.push(issue('EVENT_SEQUENCE_MISMATCH', source, `expected seq and state_revision ${expectedSequence}`));
    }
    const expectedPreviousHash = prior?.event_hash ?? '0'.repeat(64);
    if (existingEvent.previous_event_hash !== expectedPreviousHash) {
      errors.push(issue('EVENT_PREVIOUS_HASH_MISMATCH', source, 'previous_event_hash does not match prior event'));
    }
    if (existingEvent.event_hash !== eventHash(existingEvent)) {
      errors.push(issue('EVENT_HASH_MISMATCH', source, 'event_hash does not match canonical event content'));
    }
    if (prior && existingEvent.workflow_id !== prior.workflow_id) {
      errors.push(issue('EVENT_WORKFLOW_MISMATCH', source, 'event workflow differs from existing chain'));
    }
    prior = existingEvent;
  }
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
  errors.push(...validateInstance(event, eventSchema));
  if (previous && previous.workflow_id !== event.workflow_id) {
    errors.push(issue('EVENT_WORKFLOW_MISMATCH', '$.workflow_id', 'event workflow differs from existing chain'));
  }
  if (errors.length > 0) {
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
      } else if (event.task_status_before !== event.task_status_after) {
        const allowed = machine.task.transitions[event.task_status_before] ?? [];
        if (!allowed.includes(event.task_status_after)) {
          errors.push(issue('INVALID_TASK_TRANSITION', `events.jsonl:${index + 1}`, `${event.task_status_before} -> ${event.task_status_after} is not allowed`));
        }
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
  const releaseDecisions = [];
  for (const taskFile of taskFiles) {
    const task = readJsonForCheck(taskFile, errors);
    if (!task) continue;
    tasks.push(task);
    addSchemaErrors(errors, task, taskSchema, taskFile);
    if (task.workflow_id !== workflow.workflow_id) {
      errors.push(issue('TASK_WORKFLOW_MISMATCH', taskFile, 'task workflow_id does not match workflow'));
    }
    const latestTaskEvent = [...eventRecords]
      .reverse()
      .find((event) => event.task_id === task.task_id && event.task_status_after !== null);
    if (latestTaskEvent && (latestTaskEvent.task_status_after !== task.status || latestTaskEvent.run_id !== task.run_id)) {
      errors.push(issue('TASK_EVENT_MISMATCH', taskFile, 'latest task event does not match task snapshot'));
    }

    const outputDir = join(task.artifact_root_abs, 'output');
    const resultPath = join(outputDir, 'result.json');
    if (existsSync(resultPath)) {
      const result = readJsonForCheck(resultPath, errors);
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

    for (const [name, schema] of [['evidence.jsonl', evidenceSchema], ['command-records.jsonl', commandSchema]]) {
      const path = join(outputDir, name);
      if (!existsSync(path)) continue;
      for (const record of readJsonLinesForCheck(path, errors)) {
        addSchemaErrors(errors, record.value, schema, `${path}:${record.line}`);
        if (name === 'command-records.jsonl'
          && (record.value.task_id !== task.task_id || record.value.run_id !== task.run_id)) {
          errors.push(issue('COMMAND_RECORD_SCOPE_MISMATCH', `${path}:${record.line}`, 'command record task_id or run_id does not match task'));
        }
      }
    }

    const reviewPath = join(outputDir, 'review-findings.json');
    if (existsSync(reviewPath)) {
      const review = readJsonForCheck(reviewPath, errors);
      if (review) {
        addSchemaErrors(errors, review, reviewSchema, reviewPath);
        for (const finding of review.findings ?? []) {
          if (finding.blocking === true && ['BLOCKER', 'CRITICAL', 'HIGH'].includes(finding.severity) && finding.status === 'OPEN') {
            blockingFindings.push({ task_id: task.task_id, finding_id: finding.finding_id, severity: finding.severity });
          }
        }
      }
    }

    const releasePath = join(outputDir, 'release-decision.json');
    if (existsSync(releasePath)) {
      const release = readJsonForCheck(releasePath, errors);
      if (release) {
        addSchemaErrors(errors, release, releaseSchema, releasePath);
        releaseDecisions.push(release);
      }
    }
  }
  if (!sameStringSet(tasks.map((task) => task.task_id), workflow.task_ids)) {
    errors.push(issue('WORKFLOW_TASK_INDEX_MISMATCH', '$.task_ids', 'workflow task_ids do not match control task files'));
  }
  return { tasks, blockingFindings, releaseDecisions };
}

function validateApprovals({ workflow, workflowDir, projectRoot, errors }) {
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
    const responsePath = requestFile.replace(/\.request\.json$/u, '.response.json');
    const hasResponse = existsSync(responsePath);
    if (request.status === 'PENDING') {
      pendingIds.push(request.decision_id);
      if (hasResponse) {
        errors.push(issue('PENDING_APPROVAL_HAS_RESPONSE', responsePath, 'pending request must not have a response'));
      }
      continue;
    }
    if (request.status === 'RESOLVED' && !hasResponse) {
      errors.push(issue('APPROVAL_RESPONSE_REQUIRED', responsePath, 'resolved request is missing a response'));
      continue;
    }
    if (!hasResponse) continue;
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

function validateGates({ workflow, workflowDir, projectRoot, approvals, taskState, errors }) {
  const gateSchema = readJson(join(projectRoot, 'contracts', 'gate-result.schema.json'));
  const gateFiles = jsonFiles(join(workflowDir, 'gates'));
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
    for (const decisionId of gate.approved_decision_ids ?? []) {
      const approval = approvals.resolvedApprovals.get(decisionId);
      if (!approval || !['APPROVED', 'MODIFIED'].includes(approval.response.outcome)) {
        errors.push(issue('GATE_APPROVAL_NOT_RESOLVED', gateFile, `approved decision is not resolved: ${decisionId}`));
      }
    }
    if (['ReviewGate', 'SecurityGate', 'ReleaseReadinessGate'].includes(gate.gate_name)
        && taskState.blockingFindings.length > 0
        && gate.overall === 'PASS') {
      errors.push(issue('OPEN_BLOCKING_FINDING', gateFile, 'gate cannot PASS with open BLOCKER, CRITICAL, or HIGH findings'));
    }
    if (gate.gate_name === 'ReleaseReadinessGate' && taskState.releaseDecisions.length > 0) {
      const verdict = taskState.releaseDecisions.at(-1).verdict;
      const verdictOverall = { GO: 'PASS', NO_GO: 'FAIL', HOLD: 'HOLD' }[verdict];
      if (verdictOverall && gate.overall !== verdictOverall) {
        errors.push(issue('RELEASE_VERDICT_MISMATCH', gateFile, `release verdict ${verdict} requires ${verdictOverall}`));
      }
    }
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
  const workflowDir = join(runtimeRoot, 'control', 'workflows', workflowId);
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
  if (workflow.workflow_id !== workflowId) {
    errors.push(issue('WORKFLOW_ID_MISMATCH', workflowPath, 'workflow_id does not match requested workflow'));
  }
  if (resolve(workflow.runtime_root_abs) !== runtimeRoot) {
    errors.push(issue('RUNTIME_ROOT_MISMATCH', '$.runtime_root_abs', 'workflow runtime root does not match command runtime root'));
  }
  const activeEntries = (active.workflows ?? []).filter((entry) => entry.workflow_id === workflowId);
  if (activeEntries.length !== 1) {
    errors.push(issue('ACTIVE_WORKFLOW_ENTRY_COUNT', activePath, `expected one active entry, found ${activeEntries.length}`));
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
  const approvals = validateApprovals({ workflow, workflowDir, projectRoot, errors });
  validateGates({ workflow, workflowDir, projectRoot, approvals, taskState, errors });
  if (!options['skip-git']) validateGitCandidate(workflow, errors);

  if (errors.length > 0) {
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
      for (const error of assertSupportedSchema(schema)) errors.push({ ...error, source: schemaPath });
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
