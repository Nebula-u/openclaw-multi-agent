import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../runtime-core/atomic-store.mjs';
import { ingestStructuredOutputs, isPublishedOutput, StructuredOutputIngestionError } from '../runtime-core/structured-output-ingestion.mjs';
import { ControlTransitionError } from './reducer.mjs';

const ZERO_HASH = '0'.repeat(64);
const RECEIPT_ORDER = new Map([['PREPARED', 0], ['SENT', 1], ['ACKNOWLEDGED', 2], ['RUNNING', 3]]);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function json(value) { return JSON.stringify(value); }
function parseJson(value) { return value == null ? null : JSON.parse(value); }
function fail(code, message, details = {}) { throw new ControlTransitionError(code, message, details); }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function normalized(path) { const value = resolve(path); return process.platform === 'win32' ? value.toLowerCase() : value; }
function isWithin(root, path) { const rel = relative(resolve(root), resolve(path)); return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)); }

function compile(schema) {
  const AjvClass = String(schema.$schema ?? '').includes('2020-12') ? Ajv2020 : Ajv;
  const ajv = new AjvClass({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function assertValid(validate, value, code) {
  if (!validate(value)) fail(code, 'JSON Schema validation failed', { errors: structuredClone(validate.errors ?? []) });
}

function initialize(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      attempt INTEGER NOT NULL,
      assigned_agent TEXT NOT NULL,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      contract_set_id TEXT NOT NULL,
      output_contract_version INTEGER NOT NULL,
      task_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      contract_set_id TEXT NOT NULL,
      output_contract_version INTEGER NOT NULL,
      task_snapshot_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, attempt),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS task_events (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      PRIMARY KEY(task_id, seq),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS dispatches (
      dispatch_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      session_key TEXT NOT NULL,
      session_id TEXT,
      input_manifest_sha256 TEXT NOT NULL,
      intent_json TEXT NOT NULL,
      latest_receipt_json TEXT,
      completion_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id),
      FOREIGN KEY (task_id) REFERENCES tasks(task_id),
      FOREIGN KEY (run_id) REFERENCES task_runs(run_id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS dispatch_one_unresolved_run
      ON dispatches(run_id) WHERE status NOT IN ('SUCCEEDED', 'FAILED', 'LOST');
    CREATE TABLE IF NOT EXISTS dispatch_outbox (
      dispatch_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DELIVERED', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(dispatch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS task_operations (
      operation_id TEXT PRIMARY KEY,
      operation_sha256 TEXT NOT NULL,
      operation_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS task_events_no_update
      BEFORE UPDATE ON task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS task_events_no_delete
      BEFORE DELETE ON task_events BEGIN SELECT RAISE(ABORT, 'task events are immutable'); END;
  `);
}

function taskFromRow(row) { return row ? parseJson(row.task_json) : null; }
function loadTask(database, taskId) { return taskFromRow(database.prepare('SELECT task_json FROM tasks WHERE task_id = ?').get(taskId)); }

export function storedTaskEventHash(event) {
  const unsigned = {
    task_id: event.task_id, seq: event.seq, event_id: event.event_id, event_type: event.event_type,
    occurred_at: event.occurred_at, from_status: event.from_status, to_status: event.to_status,
    payload: event.payload, previous_event_hash: event.previous_event_hash,
  };
  return sha256(canonicalJson(unsigned));
}

function appendTaskEvent(database, task, eventId, eventType, fromStatus, toStatus, occurredAt, payload = {}) {
  const prior = database.prepare('SELECT seq, event_hash FROM task_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(task.task_id);
  const event = {
    task_id: task.task_id, seq: (prior?.seq ?? 0) + 1, event_id: eventId, event_type: eventType,
    occurred_at: occurredAt, from_status: fromStatus, to_status: toStatus, payload,
    previous_event_hash: prior?.event_hash ?? ZERO_HASH,
  };
  event.event_hash = storedTaskEventHash(event);
  database.prepare(`INSERT INTO task_events(task_id, seq, event_id, event_type, occurred_at, from_status, to_status,
    payload_json, previous_event_hash, event_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(event.task_id, event.seq, event.event_id, event.event_type, event.occurred_at, event.from_status,
      event.to_status, json(event.payload), event.previous_event_hash, event.event_hash);
  return event;
}

function updateTask(database, task, status, occurredAt) {
  const next = { ...task, status, updated_at: occurredAt };
  const changed = database.prepare('UPDATE tasks SET status = ?, task_json = ?, updated_at = ? WHERE task_id = ? AND status = ?')
    .run(status, json(next), occurredAt, task.task_id, task.status);
  if (changed.changes !== 1) fail('TASK_STATUS_CONFLICT', `task status changed concurrently: ${task.task_id}`);
  database.prepare('UPDATE task_runs SET status = ?, updated_at = ? WHERE run_id = ?').run(status, occurredAt, task.run_id);
  return next;
}

function transactional(database, operationId, value, fn) {
  const input = canonicalJson(value);
  const digest = sha256(input);
  database.exec('BEGIN IMMEDIATE');
  try {
    const prior = database.prepare('SELECT operation_sha256, result_json FROM task_operations WHERE operation_id = ?').get(operationId);
    if (prior) {
      if (prior.operation_sha256 !== digest) fail('TASK_IDEMPOTENCY_CONFLICT', `operation_id reused with different content: ${operationId}`);
      database.exec('COMMIT');
      return { ...parseJson(prior.result_json), idempotent_replay: true };
    }
    const result = fn();
    database.prepare(`INSERT INTO task_operations(operation_id, operation_sha256, operation_json, result_json, committed_at)
      VALUES (?, ?, ?, ?, ?)`).run(operationId, digest, input, json(result), new Date().toISOString());
    database.exec('COMMIT');
    return { ...result, idempotent_replay: false };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* already closed */ }
    throw error;
  }
}

function replayedOperation(database, operationId, value) {
  const prior = database.prepare('SELECT operation_sha256, result_json FROM task_operations WHERE operation_id = ?').get(operationId);
  if (!prior) return null;
  if (prior.operation_sha256 !== sha256(canonicalJson(value))) fail('TASK_IDEMPOTENCY_CONFLICT', `operation_id reused with different content: ${operationId}`);
  return { ...parseJson(prior.result_json), idempotent_replay: true };
}

function validatePackage(projectRoot, database, task, validators, outputContracts) {
  const errors = [];
  const add = (code, path, message) => errors.push({ code, path, message });
  if (task.output_contract_version !== outputContracts.schema_version) add('TASK_OUTPUT_CONTRACT_VERSION', '$.output_contract_version', 'task output contract version is not current');
  const typePolicy = outputContracts.task_types[task.task_type];
  if (!typePolicy || typePolicy.agent !== task.assigned_agent) add('TASK_AGENT_POLICY', '$.assigned_agent', 'assigned agent does not match task type policy');
  for (const [key, value] of [['worktree_path_abs', task.worktree_path_abs], ['artifact_root_abs', task.artifact_root_abs], ['context_manifest_path_abs', task.context_manifest_path_abs]]) {
    if (!isAbsolute(value)) add('TASK_PATH_NOT_ABSOLUTE', `$.${key}`, 'path must be absolute');
  }
  let manifest = null;
  try {
    if (!existsSync(task.context_manifest_path_abs)) add('TASK_CONTEXT_MISSING', '$.context_manifest_path_abs', 'context manifest does not exist');
    else {
      manifest = readJson(task.context_manifest_path_abs);
      if (!validators.context(manifest)) add('TASK_CONTEXT_SCHEMA_INVALID', '$.context_manifest_path_abs', JSON.stringify(validators.context.errors));
    }
  } catch (error) { add('TASK_CONTEXT_INVALID_JSON', '$.context_manifest_path_abs', error.message); }
  if (manifest) {
    for (const key of ['workflow_id', 'task_id', 'run_id']) if (manifest[key] !== task[key]) add('TASK_CONTEXT_IDENTITY_MISMATCH', `context.${key}`, 'context identity does not match task');
    if (manifest.assigned_agent !== task.assigned_agent) add('TASK_CONTEXT_AGENT_MISMATCH', 'context.assigned_agent', 'context agent does not match task');
    if (normalized(manifest.worktree_path_abs) !== normalized(task.worktree_path_abs)) add('TASK_CONTEXT_PATH_MISMATCH', 'context.worktree_path_abs', 'context worktree path does not match task');
    if (normalized(manifest.artifact_root_abs) !== normalized(task.artifact_root_abs)) add('TASK_CONTEXT_PATH_MISMATCH', 'context.artifact_root_abs', 'context artifact path does not match task');
    for (const input of manifest.input_files ?? []) {
      if (!existsSync(input.path_abs)) add('TASK_INPUT_MISSING', input.path_abs, 'declared input does not exist');
      else if (sha256(readFileSync(input.path_abs)) !== input.sha256) add('TASK_INPUT_HASH_MISMATCH', input.path_abs, 'declared input hash does not match');
    }
  }
  const contractRoot = resolve(projectRoot, 'contracts');
  for (const [index, output] of task.structured_outputs.entries()) {
    if (output.producer !== task.assigned_agent) add('TASK_OUTPUT_PRODUCER_MISMATCH', `$.structured_outputs[${index}].producer`, 'producer must equal assigned_agent');
    if (!isWithin(task.artifact_root_abs, output.path_abs)) add('TASK_OUTPUT_PATH_ESCAPE', `$.structured_outputs[${index}].path_abs`, 'output must be inside artifact root');
    if (!isWithin(contractRoot, output.schema_path_abs)) add('TASK_SCHEMA_PATH_ESCAPE', `$.structured_outputs[${index}].schema_path_abs`, 'schema must be inside project contracts');
    else if (!existsSync(output.schema_path_abs)) add('TASK_OUTPUT_SCHEMA_MISSING', output.schema_path_abs, 'output schema does not exist');
    else { try { compile(readJson(output.schema_path_abs)); } catch (error) { add('TASK_OUTPUT_SCHEMA_INVALID', output.schema_path_abs, error.message); } }
  }
  for (const required of outputContracts.defaults.required) {
    const found = task.structured_outputs.find((output) => output.required && output.format === required.format
      && normalized(output.schema_path_abs) === normalized(join(contractRoot, required.schema))
      && output.path_abs.toLowerCase().replaceAll('\\', '/').endsWith(required.relative_path.toLowerCase().replaceAll('\\', '/')));
    if (!found) add('TASK_REQUIRED_OUTPUT_UNDECLARED', '$.structured_outputs', `missing required output declaration: ${required.relative_path}`);
  }
  for (const dependency of task.dependencies ?? []) {
    const row = database.prepare('SELECT status FROM tasks WHERE task_id = ?').get(dependency);
    if (!row || row.status !== 'COMPLETED') add('TASK_DEPENDENCY_INCOMPLETE', '$.dependencies', `dependency is not completed: ${dependency}`);
  }
  if (errors.length) fail('TASK_PACKAGE_INVALID', 'task package validation failed', { errors });
  return { manifest_sha256: sha256(readFileSync(task.context_manifest_path_abs)), checks: 8 + (manifest?.input_files?.length ?? 0) + task.structured_outputs.length };
}

function validateOutputs(task, resultPath, resultHash, validateSchema, occurredAt) {
  let accepted;
  try {
    accepted = ingestStructuredOutputs(task, { validateSchema, occurredAt });
  } catch (error) {
    if (error instanceof StructuredOutputIngestionError) fail(error.code, error.message, error.details);
    throw error;
  }
  if (!existsSync(resultPath) || sha256(readFileSync(resultPath)) !== resultHash) {
    fail('TASK_RESULT_HASH_MISMATCH', 'completion result hash does not match the locally published file');
  }
  let result = null;
  const validations = [];
  for (const acceptedOutput of accepted) {
    const { output, values, receipt_path_abs: receiptPath } = acceptedOutput;
    validations.push({ path_abs: output.path_abs, records: values.length, ingestion_receipt_path_abs: receiptPath });
    if (isPublishedOutput(task, output, resultPath)) result = values[0];
  }
  if (!result) fail('TASK_RESULT_NOT_DECLARED', 'completion result path is not a declared structured output');
  for (const key of ['workflow_id', 'task_id', 'run_id']) if (result[key] !== task[key]) fail('TASK_RESULT_IDENTITY_MISMATCH', `result ${key} does not match task`);
  if (result.agent_id !== task.assigned_agent || result.attempt !== task.attempt) fail('TASK_RESULT_AGENT_MISMATCH', 'result agent or attempt does not match task');
  if (normalized(result.worktree_path_abs) !== normalized(task.worktree_path_abs)
    || normalized(result.artifact_root_abs) !== normalized(task.artifact_root_abs)) fail('TASK_RESULT_PATH_MISMATCH', 'result paths do not match task');
  return { result, validations };
}

export function createTaskRepository(projectRootInput, database) {
  const projectRoot = resolve(projectRootInput);
  initialize(database);
  const schemas = (name) => readJson(join(projectRoot, 'contracts', name));
  const validators = {
    task: compile(schemas('task.schema.json')),
    context: compile(schemas('context-manifest.schema.json')),
    intent: compile(schemas('dispatch-intent.schema.json')),
    receipt: compile(schemas('dispatch-receipt.schema.json')),
    completion: compile(schemas('completion-receipt.schema.json')),
  };
  const outputContracts = readJson(join(projectRoot, 'config', 'task-output-contracts.json'));
  const outputSchemaValidators = new Map();
  const validateOutputSchema = (path) => {
    const key = normalized(path);
    if (!outputSchemaValidators.has(key)) outputSchemaValidators.set(key, compile(readJson(path)));
    return outputSchemaValidators.get(key);
  };

  return {
    register(task) {
      assertValid(validators.task, task, 'TASK_SCHEMA_INVALID');
      if (task.status !== 'CREATED') fail('TASK_INITIAL_STATUS_INVALID', 'new tasks must start in CREATED');
      if (task.output_ingestion_mode !== 'LOCAL_STAGED') fail('TASK_OUTPUT_INGESTION_MODE', 'new tasks must use LOCAL_STAGED output ingestion');
      return transactional(database, `REGISTER:${task.task_id}`, task, () => {
        const workflow = database.prepare('SELECT state_json FROM workflows WHERE workflow_id = ?').get(task.workflow_id);
        if (!workflow) fail('TASK_WORKFLOW_NOT_FOUND', `workflow does not exist: ${task.workflow_id}`);
        const workflowState = parseJson(workflow.state_json);
        if (workflowState.condition === 'TERMINAL') fail('TASK_WORKFLOW_TERMINAL', 'cannot register a task on a terminal workflow');
        const conflicting = database.prepare(`SELECT task_id, status FROM tasks
          WHERE workflow_id=? AND task_type=? AND assigned_agent=?
            AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'LOST')
          ORDER BY created_at LIMIT 1`).get(task.workflow_id, task.task_type, task.assigned_agent);
        if (conflicting) fail('TASK_ACTIVE_DUPLICATE', `active task already exists for ${task.workflow_id}/${task.task_type}/${task.assigned_agent}: ${conflicting.task_id}`,
          { conflicting_task_id: conflicting.task_id, conflicting_status: conflicting.status });
        database.prepare(`INSERT INTO tasks(task_id, workflow_id, run_id, attempt, assigned_agent, task_type, status,
          contract_set_id, output_contract_version, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(task.task_id, task.workflow_id, task.run_id, task.attempt, task.assigned_agent, task.task_type, task.status,
            workflowState.contract_set_id, task.output_contract_version, json(task), task.created_at, task.updated_at);
        database.prepare(`INSERT INTO task_runs(run_id, task_id, attempt, status, contract_set_id, output_contract_version,
          task_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(task.run_id, task.task_id, task.attempt, task.status, workflowState.contract_set_id,
            task.output_contract_version, json(task), task.created_at, task.updated_at);
        const event = appendTaskEvent(database, task, `TEV-REGISTER-${task.task_id}`, 'TASK_REGISTERED', null, 'CREATED', task.created_at,
          { contract_set_id: workflowState.contract_set_id, output_contract_version: task.output_contract_version });
        return { ok: true, command: 'task-register', task, event };
      });
    },
    validatePackage(taskId, occurredAt = new Date().toISOString()) {
      const task = loadTask(database, taskId);
      if (!task) fail('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
      const packageResult = validatePackage(projectRoot, database, task, validators, outputContracts);
      if (task.status === 'READY') return { ok: true, command: 'task-validate', task, validation: packageResult, idempotent_replay: true };
      return transactional(database, `VALIDATE:${taskId}:${sha256(canonicalJson(task))}`, { task_id: taskId, occurred_at: occurredAt, ...packageResult }, () => {
        const current = loadTask(database, taskId);
        if (!['CREATED', 'READY'].includes(current.status)) fail('TASK_PACKAGE_STATUS_INVALID', `cannot validate task in ${current.status}`);
        if (current.status === 'READY') return { ok: true, command: 'task-validate', task: current, validation: packageResult };
        const next = updateTask(database, current, 'READY', occurredAt);
        // A retry reuses task_id but has a distinct run_id.  Event ids must
        // therefore include the run id; otherwise retry validation collides
        // with the original TASK_PACKAGE_VALIDATED event.
        const event = appendTaskEvent(database, next, `TEV-READY-${taskId}-${next.run_id}`, 'TASK_PACKAGE_VALIDATED', 'CREATED', 'READY', occurredAt, packageResult);
        return { ok: true, command: 'task-validate', task: next, validation: packageResult, event };
      });
    },
    prepareDispatch(intent) {
      assertValid(validators.intent, intent, 'DISPATCH_INTENT_SCHEMA_INVALID');
      return transactional(database, `DISPATCH:${intent.dispatch_id}`, intent, () => {
        const task = loadTask(database, intent.task_id);
        if (!task || task.status !== 'READY') fail('DISPATCH_TASK_NOT_READY', 'dispatch requires a READY task');
        for (const key of ['workflow_id', 'task_id', 'run_id']) if (intent[key] !== task[key]) fail('DISPATCH_IDENTITY_MISMATCH', `intent ${key} does not match task`);
        if (intent.agent_id !== task.assigned_agent || intent.attempt !== task.attempt) fail('DISPATCH_AGENT_MISMATCH', 'intent agent or attempt does not match task');
        if (normalized(intent.input_manifest_path_abs) !== normalized(task.context_manifest_path_abs)
          || sha256(readFileSync(task.context_manifest_path_abs)) !== intent.input_manifest_sha256) fail('DISPATCH_MANIFEST_MISMATCH', 'dispatch manifest path or hash does not match validated task');
        const expectedKey = `${task.workflow_id}/${task.task_id}/${task.run_id}/${task.assigned_agent}/${task.attempt}`;
        if (intent.idempotency_key !== expectedKey) fail('DISPATCH_IDEMPOTENCY_KEY_INVALID', 'dispatch idempotency key is not canonical');
        database.prepare(`INSERT INTO dispatches(dispatch_id, idempotency_key, workflow_id, task_id, run_id, agent_id,
          attempt, status, session_key, session_id, input_manifest_sha256, intent_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, NULL, ?, ?, ?, ?)`)
          .run(intent.dispatch_id, intent.idempotency_key, intent.workflow_id, intent.task_id, intent.run_id, intent.agent_id,
            intent.attempt, intent.session_key, intent.input_manifest_sha256, json(intent), intent.created_at, intent.created_at);
        database.prepare("INSERT INTO dispatch_outbox(dispatch_id, status, attempts, created_at) VALUES (?, 'PENDING', 0, ?)")
          .run(intent.dispatch_id, intent.created_at);
        const next = updateTask(database, task, 'DISPATCHED', intent.created_at);
        const event = appendTaskEvent(database, next, `TEV-DISPATCH-${intent.dispatch_id}`, 'TASK_DISPATCH_PREPARED', 'READY', 'DISPATCHED', intent.created_at,
          { dispatch_id: intent.dispatch_id, outbox_status: 'PENDING' });
        return { ok: true, command: 'dispatch-prepare', task: next, intent, event, spawn_required: true };
      });
    },
    recordReceipt(receipt) {
      assertValid(validators.receipt, receipt, 'DISPATCH_RECEIPT_SCHEMA_INVALID');
      return transactional(database, `RECEIPT:${receipt.receipt_id}`, receipt, () => {
        const dispatch = database.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(receipt.dispatch_id);
        if (!dispatch) fail('DISPATCH_NOT_FOUND', `dispatch does not exist: ${receipt.dispatch_id}`);
        const intent = parseJson(dispatch.intent_json);
        for (const key of ['idempotency_key', 'workflow_id', 'task_id', 'run_id', 'agent_id', 'attempt', 'session_key', 'input_manifest_sha256']) {
          if (receipt[key] !== intent[key]) fail('DISPATCH_RECEIPT_MISMATCH', `receipt ${key} does not match intent`);
        }
        if (dispatch.session_id && dispatch.session_id !== receipt.session_id) fail('DISPATCH_SESSION_CONFLICT', 'session_id changed within one dispatch');
        if (!RECEIPT_ORDER.has(receipt.status) || RECEIPT_ORDER.get(receipt.status) !== RECEIPT_ORDER.get(dispatch.status) + 1) fail('DISPATCH_RECEIPT_ORDER', `cannot move ${dispatch.status} to ${receipt.status}`);
        database.prepare('UPDATE dispatches SET status = ?, session_id = ?, latest_receipt_json = ?, updated_at = ? WHERE dispatch_id = ?')
          .run(receipt.status, receipt.session_id, json(receipt), receipt.recorded_at, receipt.dispatch_id);
        database.prepare("UPDATE dispatch_outbox SET status = 'DELIVERED', attempts = attempts + 1, delivered_at = ? WHERE dispatch_id = ?")
          .run(receipt.recorded_at, receipt.dispatch_id);
        let task = loadTask(database, receipt.task_id);
        let event = null;
        if (receipt.status === 'RUNNING' && task.status === 'DISPATCHED') {
          task = updateTask(database, task, 'RUNNING', receipt.recorded_at);
          event = appendTaskEvent(database, task, `TEV-RUNNING-${receipt.receipt_id}`, 'TASK_SESSION_RUNNING', 'DISPATCHED', 'RUNNING', receipt.recorded_at,
            { dispatch_id: receipt.dispatch_id, session_id: receipt.session_id });
        }
        return { ok: true, command: 'dispatch-receipt', task, receipt, event };
      });
    },
    failDispatch({ dispatch_id: dispatchId, error_code: errorCode, error_message: errorMessage, completed_at: completedAt, session_id: sessionId = null }) {
      if (!dispatchId || !errorCode || !completedAt) fail('ORCHESTRATOR_FAILURE_INVALID', 'dispatch_id, error_code and completed_at are required');
      return transactional(database, `ORCHESTRATOR_FAILURE:${dispatchId}:${errorCode}`, {
        dispatch_id: dispatchId, error_code: errorCode, error_message: errorMessage ?? null, completed_at: completedAt, session_id: sessionId,
      }, () => {
        const dispatch = database.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(dispatchId);
        if (!dispatch) fail('DISPATCH_NOT_FOUND', `dispatch does not exist: ${dispatchId}`);
        if (['SUCCEEDED', 'FAILED', 'LOST'].includes(dispatch.status)) {
          return { ok: true, command: 'orchestrator-fail-dispatch', dispatch_id: dispatchId, terminal: dispatch.status };
        }
        const intent = parseJson(dispatch.intent_json);
        const completion = {
          schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: `CMP-ORCHESTRATOR-${dispatchId.slice(4)}`,
          dispatch_id: intent.dispatch_id, idempotency_key: intent.idempotency_key,
          workflow_id: intent.workflow_id, task_id: intent.task_id, run_id: intent.run_id,
          agent_id: intent.agent_id, attempt: intent.attempt, status: 'FAILED', session_key: intent.session_key,
          session_id: sessionId ?? dispatch.session_id ?? `orchestrator-failed-${dispatchId}`,
          result_path_abs: null, result_sha256: null, error_code: errorCode, error_message: errorMessage ?? null,
          completed_at: completedAt,
        };
        database.prepare('UPDATE dispatches SET status = ?, completion_json = ?, updated_at = ? WHERE dispatch_id = ?')
          .run('FAILED', json(completion), completedAt, dispatchId);
        database.prepare("UPDATE dispatch_outbox SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE dispatch_id = ?")
          .run(`${errorCode}: ${errorMessage ?? ''}`.slice(0, 2000), dispatchId);
        const task = loadTask(database, intent.task_id);
        const next = updateTask(database, task, 'FAILED', completedAt);
        const event = appendTaskEvent(database, next, `TEV-ORCHESTRATOR-FAILED-${dispatchId}`, 'TASK_ORCHESTRATOR_FAILED', task.status,
          'FAILED', completedAt, { dispatch_id: dispatchId, error_code: errorCode, error_message: errorMessage ?? null });
        return { ok: true, command: 'orchestrator-fail-dispatch', task: next, completion, event };
      });
    },
    ingestCompletion(completion) {
      assertValid(validators.completion, completion, 'COMPLETION_RECEIPT_SCHEMA_INVALID');
      const replay = replayedOperation(database, `COMPLETION:${completion.completion_id}`, completion);
      if (replay) return replay;
      let validated = null;
      const task = loadTask(database, completion.task_id);
      if (!task) fail('TASK_NOT_FOUND', `task does not exist: ${completion.task_id}`);
      if (completion.status === 'SUCCEEDED') {
        validated = validateOutputs(task, completion.result_path_abs, completion.result_sha256, validateOutputSchema, completion.completed_at);
      }
      return transactional(database, `COMPLETION:${completion.completion_id}`, completion, () => {
        const dispatch = database.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(completion.dispatch_id);
        if (!dispatch) fail('DISPATCH_NOT_FOUND', `dispatch does not exist: ${completion.dispatch_id}`);
        const intent = parseJson(dispatch.intent_json);
        for (const key of ['idempotency_key', 'workflow_id', 'task_id', 'run_id', 'agent_id', 'attempt', 'session_key']) {
          if (completion[key] !== intent[key]) fail('COMPLETION_RECEIPT_MISMATCH', `completion ${key} does not match intent`);
        }
        if (!dispatch.session_id || completion.session_id !== dispatch.session_id) fail('COMPLETION_SESSION_MISMATCH', 'completion requires the recorded spawn session');
        if (['SUCCEEDED', 'FAILED', 'LOST'].includes(dispatch.status)) fail('DISPATCH_ALREADY_TERMINAL', `dispatch is already ${dispatch.status}`);
        if (dispatch.status !== 'RUNNING') fail('COMPLETION_SESSION_NOT_RUNNING', 'completion requires a RUNNING session receipt');
        const current = loadTask(database, completion.task_id);
        let nextStatus;
        if (completion.status === 'FAILED') nextStatus = 'FAILED';
        else if (completion.status === 'LOST') nextStatus = 'LOST';
        else nextStatus = ({ COMPLETED: 'COMPLETED', NEEDS_REWORK: 'NEEDS_REWORK', BLOCKED: 'BLOCKED', HUMAN_DECISION_REQUIRED: 'WAITING_HUMAN', FAILED: 'FAILED' })[validated.result.result_status];
        if (!nextStatus) fail('TASK_RESULT_STATUS_INVALID', `unsupported result status: ${validated.result.result_status}`);
        database.prepare('UPDATE dispatches SET status = ?, completion_json = ?, updated_at = ? WHERE dispatch_id = ?')
          .run(completion.status, json(completion), completion.completed_at, completion.dispatch_id);
        const next = updateTask(database, current, nextStatus, completion.completed_at);
        database.prepare('UPDATE task_runs SET result_json = ? WHERE run_id = ?').run(validated ? json(validated.result) : null, completion.run_id);
        const event = appendTaskEvent(database, next, `TEV-COMPLETE-${completion.completion_id}`, 'TASK_RESULT_INGESTED', current.status, nextStatus,
          completion.completed_at, { dispatch_id: completion.dispatch_id, completion_status: completion.status, validations: validated?.validations ?? [] });
        return { ok: true, command: 'result-ingest', task: next, completion, result: validated?.result ?? null, event };
      });
    },
    retry(newTask) {
      assertValid(validators.task, newTask, 'TASK_SCHEMA_INVALID');
      if (newTask.status !== 'CREATED') fail('TASK_RETRY_STATUS_INVALID', 'retry task must start in CREATED');
      return transactional(database, `RETRY:${newTask.task_id}:${newTask.run_id}`, newTask, () => {
        const current = loadTask(database, newTask.task_id);
        if (!current) fail('TASK_NOT_FOUND', `task does not exist: ${newTask.task_id}`);
        if (!['FAILED', 'LOST', 'NEEDS_REWORK'].includes(current.status)) fail('TASK_RETRY_SOURCE_INVALID', `retry requires FAILED, LOST or NEEDS_REWORK task, received ${current.status}`);
        if (current.attempt >= current.max_attempts) fail('TASK_RETRY_BUDGET_EXHAUSTED', 'task retry budget is exhausted');
        for (const key of ['workflow_id', 'task_id', 'task_type', 'assigned_agent', 'max_attempts', 'output_contract_version']) {
          if (newTask[key] !== current[key]) fail('TASK_RETRY_IDENTITY_MISMATCH', `retry changed immutable field: ${key}`);
        }
        if (newTask.attempt !== current.attempt + 1 || newTask.run_id === current.run_id) fail('TASK_RETRY_ATTEMPT_INVALID', 'retry requires a new run_id and incremented attempt');
        if (normalized(newTask.artifact_root_abs) === normalized(current.artifact_root_abs)
          || normalized(newTask.context_manifest_path_abs) === normalized(current.context_manifest_path_abs)) {
          fail('TASK_RETRY_PATH_REUSE', 'retry requires a new artifact root and context manifest');
        }
        const dispatch = database.prepare('SELECT status, completion_json FROM dispatches WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(current.run_id);
        const completion = parseJson(dispatch?.completion_json);
        const expectedDispatchStatuses = current.status === 'NEEDS_REWORK' ? ['SUCCEEDED'] : ['FAILED', 'LOST'];
        if (!dispatch || !expectedDispatchStatuses.includes(dispatch.status) || completion?.status !== dispatch.status) {
          fail('TASK_RETRY_DISPATCH_UNCONFIRMED', 'retry requires a terminal dispatch completion matching the task rework state');
        }
        const workflow = database.prepare('SELECT state_json FROM workflows WHERE workflow_id=?').get(current.workflow_id);
        if (!workflow || parseJson(workflow.state_json).condition === 'TERMINAL') fail('TASK_WORKFLOW_TERMINAL', 'cannot retry task on terminal workflow');
        const contractSetId = database.prepare('SELECT contract_set_id FROM tasks WHERE task_id=?').get(current.task_id).contract_set_id;
        database.prepare(`UPDATE tasks SET run_id=?, attempt=?, status='CREATED', task_json=?, updated_at=? WHERE task_id=?`)
          .run(newTask.run_id, newTask.attempt, json(newTask), newTask.updated_at, newTask.task_id);
        database.prepare(`INSERT INTO task_runs(run_id, task_id, attempt, status, contract_set_id, output_contract_version,
          task_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, 'CREATED', ?, ?, ?, ?, ?)`)
          .run(newTask.run_id, newTask.task_id, newTask.attempt, contractSetId, newTask.output_contract_version,
            json(newTask), newTask.created_at, newTask.updated_at);
        const event = appendTaskEvent(database, newTask, `TEV-RETRY-${newTask.run_id}`, 'TASK_RETRY_CREATED', current.status, 'CREATED',
          newTask.created_at, { prior_run_id: current.run_id, prior_attempt: current.attempt, new_run_id: newTask.run_id, new_attempt: newTask.attempt });
        return { ok: true, command: 'task-retry', task: newTask, event };
      });
    },
    resumeHumanTask({ task_id: taskId, decision_id: decisionId, outcome, occurred_at: occurredAt = new Date().toISOString() } = {}) {
      if (!taskId || !decisionId || !['APPROVED', 'REJECTED', 'MODIFIED'].includes(outcome)) {
        fail('TASK_APPROVAL_RESUME_INVALID', 'task_id, decision_id and a valid outcome are required');
      }
      const targetStatus = { APPROVED: 'COMPLETED', REJECTED: 'BLOCKED', MODIFIED: 'NEEDS_REWORK' }[outcome];
      return transactional(database, `RESUME-HUMAN:${taskId}:${decisionId}`, { task_id: taskId, decision_id: decisionId, outcome, occurred_at: occurredAt }, () => {
        const current = loadTask(database, taskId);
        if (!current) fail('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
        if (current.status === targetStatus) return { ok: true, command: 'task-resume-human', task: current, idempotent_replay: true };
        if (current.status !== 'WAITING_HUMAN') fail('TASK_APPROVAL_RESUME_STATUS_INVALID', `task must be WAITING_HUMAN, received ${current.status}`);
        const next = updateTask(database, current, targetStatus, occurredAt);
        const event = appendTaskEvent(database, next, `TEV-APPROVAL-RESUME-${taskId}-${decisionId}`, 'TASK_HUMAN_APPROVAL_RESOLVED', current.status, targetStatus, occurredAt,
          { decision_id: decisionId, outcome });
        return { ok: true, command: 'task-resume-human', task: next, event };
      });
    },
    cancelWorkflow({ workflow_id: workflowId, occurred_at: occurredAt = new Date().toISOString(), reason = 'Workflow cancelled' } = {}) {
      if (!workflowId) fail('TASK_WORKFLOW_CANCEL_INVALID', 'workflow_id is required');
      return transactional(database, `CANCEL-WORKFLOW:${workflowId}`, { workflow_id: workflowId, occurred_at: occurredAt, reason }, () => {
        const active = database.prepare(`SELECT task_json FROM tasks WHERE workflow_id=?
          AND status NOT IN ('COMPLETED','FAILED','CANCELLED','SUPERSEDED','LOST') ORDER BY task_id`).all(workflowId);
        const cancelled = [];
        const dispatches = [];
        for (const row of active) {
          const task = parseJson(row.task_json);
          const dispatchRows = database.prepare(`SELECT * FROM dispatches WHERE task_id=?
            AND status NOT IN ('SUCCEEDED','FAILED','LOST') ORDER BY created_at`).all(task.task_id);
          for (const dispatch of dispatchRows) {
            const intent = parseJson(dispatch.intent_json);
            const completion = {
              schema_version: 1, record_type: 'COMPLETION_RECEIPT', completion_id: `CMP-CANCEL-${dispatch.dispatch_id.slice(4)}`,
              dispatch_id: intent.dispatch_id, idempotency_key: intent.idempotency_key,
              workflow_id: intent.workflow_id, task_id: intent.task_id, run_id: intent.run_id,
              agent_id: intent.agent_id, attempt: intent.attempt, status: 'LOST', session_key: intent.session_key,
              session_id: dispatch.session_id ?? `cancelled-${dispatch.dispatch_id}`,
              result_path_abs: null, result_sha256: null, error_code: 'WORKFLOW_CANCELLED', error_message: reason,
              completed_at: occurredAt,
            };
            database.prepare('UPDATE dispatches SET status=?, completion_json=?, updated_at=? WHERE dispatch_id=?')
              .run('LOST', json(completion), occurredAt, dispatch.dispatch_id);
            database.prepare("UPDATE dispatch_outbox SET status='FAILED', attempts=attempts+1, last_error=? WHERE dispatch_id=?")
              .run(`WORKFLOW_CANCELLED: ${reason}`.slice(0, 2000), dispatch.dispatch_id);
            dispatches.push({ dispatch_id: dispatch.dispatch_id, run_id: dispatch.run_id, completion });
          }
          const next = updateTask(database, task, 'CANCELLED', occurredAt);
          const event = appendTaskEvent(database, next, `TEV-CANCELLED-${task.task_id}-${task.run_id}`, 'TASK_WORKFLOW_CANCELLED', task.status,
            'CANCELLED', occurredAt, { reason, dispatch_ids: dispatchRows.map((item) => item.dispatch_id) });
          cancelled.push({ task: next, event });
        }
        return { ok: true, command: 'task-cancel-workflow', workflow_id: workflowId, cancelled, dispatches };
      });
    },
    supersede({ task_id: taskId, reason, occurred_at: occurredAt = new Date().toISOString() } = {}) {
      if (!taskId || !reason) fail('TASK_SUPERSEDE_INVALID', 'task_id and reason are required');
      return transactional(database, `SUPERSEDE:${taskId}:${sha256(String(reason))}`, { task_id: taskId, reason, occurred_at: occurredAt }, () => {
        const current = loadTask(database, taskId);
        if (!current) fail('TASK_NOT_FOUND', `task does not exist: ${taskId}`);
        if (['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED', 'LOST'].includes(current.status)) {
          fail('TASK_SUPERSEDE_STATUS_INVALID', `cannot supersede terminal task in ${current.status}`);
        }
        const next = updateTask(database, current, 'SUPERSEDED', occurredAt);
        const event = appendTaskEvent(database, next, `TEV-SUPERSEDED-${taskId}`, 'TASK_SUPERSEDED', current.status, 'SUPERSEDED', occurredAt, { reason });
        return { ok: true, command: 'task-supersede', task: next, event };
      });
    },
    get(taskId) { return loadTask(database, taskId); },
    getRun(runId) {
      const row = database.prepare('SELECT task_snapshot_json, status, result_json, updated_at FROM task_runs WHERE run_id=?').get(runId);
      return row ? { task: parseJson(row.task_snapshot_json), status: row.status, result: parseJson(row.result_json), updated_at: row.updated_at } : null;
    },
    getDispatch(dispatchId) {
      const row = database.prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(dispatchId);
      if (!row) return null;
      return {
        dispatch_id: row.dispatch_id,
        status: row.status,
        intent: parseJson(row.intent_json),
        receipt: parseJson(row.latest_receipt_json),
        completion: parseJson(row.completion_json),
        session_id: row.session_id,
        updated_at: row.updated_at,
      };
    },
    dispatches(taskId) { return database.prepare('SELECT dispatch_id, intent_json, latest_receipt_json, completion_json, status FROM dispatches WHERE task_id = ? ORDER BY created_at').all(taskId).map((row) => ({ dispatch_id: row.dispatch_id, intent: parseJson(row.intent_json), receipt: parseJson(row.latest_receipt_json), completion: parseJson(row.completion_json), status: row.status })); },
    unresolvedDispatch(taskId) {
      const row = database.prepare("SELECT dispatch_id FROM dispatches WHERE task_id = ? AND status NOT IN ('SUCCEEDED', 'FAILED', 'LOST') ORDER BY created_at DESC LIMIT 1").get(taskId);
      return row ? this.getDispatch(row.dispatch_id) : null;
    },
    outbox() { return database.prepare("SELECT * FROM dispatch_outbox WHERE status <> 'DELIVERED' ORDER BY created_at").all(); },
  };
}
