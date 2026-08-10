import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { canonicalJson } from '../runtime-core/atomic-store.mjs';
import { ControlTransitionError, reduceWorkflow } from './reducer.mjs';

const ZERO_HASH = '0'.repeat(64);

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function json(value) {
  return JSON.stringify(value);
}

function parseJson(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

function validationError(code, message, details = {}) {
  return new ControlTransitionError(code, message, details);
}

function validator(schema) {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function openControlDatabase(pathInput) {
  const path = pathInput === ':memory:' ? pathInput : resolve(pathInput);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS control_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workflows (
      workflow_id TEXT PRIMARY KEY,
      protocol_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      phase TEXT NOT NULL,
      condition TEXT NOT NULL,
      outcome TEXT,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workflow_events (
      workflow_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      from_state_json TEXT,
      to_state_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      PRIMARY KEY (workflow_id, seq),
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS control_commands (
      command_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      command_sha256 TEXT NOT NULL,
      command_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS approval_requests (
      decision_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'RESOLVED', 'CANCELLED')),
      request_json TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS approval_requests_pending_by_workflow
      ON approval_requests(workflow_id, status);
    CREATE TABLE IF NOT EXISTS projection_outbox (
      projection_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'APPLIED', 'FAILED')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE(workflow_id, revision),
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    ) STRICT;
    CREATE VIEW IF NOT EXISTS active_workflows AS
      SELECT workflow_id, revision, phase, condition, outcome, state_json, updated_at
      FROM workflows WHERE condition <> 'TERMINAL';
    CREATE TRIGGER IF NOT EXISTS workflow_events_no_update
      BEFORE UPDATE ON workflow_events BEGIN SELECT RAISE(ABORT, 'workflow events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS workflow_events_no_delete
      BEFORE DELETE ON workflow_events BEGIN SELECT RAISE(ABORT, 'workflow events are immutable'); END;
  `);
  database.prepare('INSERT OR IGNORE INTO control_meta(key, value) VALUES (?, ?)').run('schema_version', '2');
  return database;
}

export function loadWorkflow(database, workflowId) {
  const row = database.prepare('SELECT state_json FROM workflows WHERE workflow_id = ?').get(workflowId);
  return row ? parseJson(row.state_json) : null;
}

export function listEvents(database, workflowId) {
  return database.prepare(`
    SELECT workflow_id, seq, revision, command_id, event_type, actor, occurred_at,
      from_state_json, to_state_json, payload_json, previous_event_hash, event_hash
    FROM workflow_events WHERE workflow_id = ? ORDER BY seq
  `).all(workflowId).map((row) => ({
    workflow_id: row.workflow_id,
    seq: row.seq,
    revision: row.revision,
    command_id: row.command_id,
    event_type: row.event_type,
    actor: row.actor,
    occurred_at: row.occurred_at,
    from_state: parseJson(row.from_state_json),
    to_state: parseJson(row.to_state_json),
    payload: parseJson(row.payload_json),
    previous_event_hash: row.previous_event_hash,
    event_hash: row.event_hash,
  }));
}

export function listWorkflows(database, { activeOnly = false } = {}) {
  const source = activeOnly ? 'active_workflows' : 'workflows';
  return database.prepare(`SELECT state_json FROM ${source} ORDER BY workflow_id`).all().map((row) => parseJson(row.state_json));
}

function validateOrThrow(validate, value, code) {
  if (!validate(value)) {
    throw validationError(code, 'JSON Schema validation failed', { errors: structuredClone(validate.errors ?? []) });
  }
}

export function storedEventHash(event) {
  const hashInput = {
    workflow_id: event.workflow_id,
    seq: event.seq,
    revision: event.revision,
    command_id: event.command_id,
    event_type: event.event_type,
    actor: event.actor,
    occurred_at: event.occurred_at,
    from_state: event.from_state,
    to_state: event.to_state,
    payload: event.payload,
    previous_event_hash: event.previous_event_hash,
  };
  return sha256(canonicalJson(hashInput));
}

export function createControlRepository(projectRootInput, database, { failpoint = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const commandSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'transition-command.schema.json'), 'utf8'));
  const stateSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'control-state-v2.schema.json'), 'utf8'));
  const approvalRequestSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'approval-request.schema.json'), 'utf8'));
  const approvalResponseSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'approval-response.schema.json'), 'utf8'));
  const machine = JSON.parse(readFileSync(join(projectRoot, 'config', 'control-state-machine-v2.json'), 'utf8'));
  const validateCommand = validator(commandSchema);
  const validateState = validator(stateSchema);
  const validateApprovalRequest = validator(approvalRequestSchema);
  const validateApprovalResponse = validator(approvalResponseSchema);

  function validateApprovalBinding(request, workflowId) {
    if (request.workflow_id !== workflowId) {
      throw validationError('CONTROL_APPROVAL_WORKFLOW_MISMATCH', 'approval request workflow_id does not match command workflow_id');
    }
    if (request.status !== 'PENDING') {
      throw validationError('CONTROL_APPROVAL_STATUS_INVALID', 'a new approval request must have status PENDING');
    }
    if (request.recommended_option && !request.options.some((option) => option.option_id === request.recommended_option.option_id)) {
      throw validationError('CONTROL_APPROVAL_RECOMMENDATION_INVALID', 'recommended_option must refer to an approval option');
    }
  }

  function validateApprovalResponseBinding(request, response) {
    if (!/^human:/u.test(response.decided_by)) {
      throw validationError('CONTROL_APPROVAL_HUMAN_ACTOR_REQUIRED', 'approval response decided_by must identify a human with the human: prefix');
    }
    for (const key of ['decision_id', 'workflow_id', 'task_id', 'run_id']) {
      if (response[key] !== request[key]) {
        throw validationError('CONTROL_APPROVAL_RESPONSE_MISMATCH', `approval response ${key} does not match request`);
      }
    }
    const chosen = response.chosen_option_id;
    if (response.outcome === 'REJECTED' && chosen !== null) {
      throw validationError('CONTROL_APPROVAL_RESPONSE_OPTION_INVALID', 'REJECTED response must not choose an option');
    }
    if (response.outcome !== 'REJECTED' && !request.options.some((option) => option.option_id === chosen)) {
      throw validationError('CONTROL_APPROVAL_RESPONSE_OPTION_INVALID', 'APPROVED or MODIFIED response must choose a request option');
    }
  }

  return {
    apply(command) {
      validateOrThrow(validateCommand, command, 'CONTROL_COMMAND_SCHEMA_INVALID');
      const commandJson = canonicalJson(command);
      const commandHash = sha256(commandJson);
      database.exec('BEGIN IMMEDIATE');
      try {
        const prior = database.prepare('SELECT command_sha256, result_json FROM control_commands WHERE command_id = ?').get(command.command_id);
        if (prior) {
          if (prior.command_sha256 !== commandHash) {
            throw validationError('CONTROL_IDEMPOTENCY_CONFLICT', `command_id was already used with different content: ${command.command_id}`);
          }
          database.exec('COMMIT');
          return { ...parseJson(prior.result_json), idempotent_replay: true };
        }
        const current = loadWorkflow(database, command.workflow_id);
        let approvalRequest = null;
        let approvalResponse = null;
        if (command.command_type === 'WAIT_HUMAN') {
          approvalRequest = command.payload?.approval_request ?? null;
          if (approvalRequest !== null) {
            validateOrThrow(validateApprovalRequest, approvalRequest, 'CONTROL_APPROVAL_REQUEST_SCHEMA_INVALID');
            validateApprovalBinding(approvalRequest, command.workflow_id);
            const existing = database.prepare('SELECT request_json, status FROM approval_requests WHERE decision_id=?').get(approvalRequest.decision_id);
            if (existing) {
              if (existing.status !== 'PENDING' || existing.request_json !== json(approvalRequest)) {
                throw validationError('CONTROL_APPROVAL_IDEMPOTENCY_CONFLICT', `approval decision_id already exists: ${approvalRequest.decision_id}`);
              }
              throw validationError('CONTROL_APPROVAL_ALREADY_EXISTS', `approval decision_id already exists: ${approvalRequest.decision_id}`);
            }
          }
        } else if (command.command_type === 'RESOLVE_HUMAN') {
          approvalResponse = command.payload?.approval_response ?? null;
          if (approvalResponse === null) {
            throw validationError('CONTROL_APPROVAL_RESPONSE_REQUIRED', 'RESOLVE_HUMAN requires payload.approval_response');
          }
          validateOrThrow(validateApprovalResponse, approvalResponse, 'CONTROL_APPROVAL_RESPONSE_SCHEMA_INVALID');
          const row = database.prepare('SELECT request_json, status FROM approval_requests WHERE decision_id=?').get(approvalResponse.decision_id);
          if (!row) throw validationError('CONTROL_APPROVAL_NOT_FOUND', `approval decision does not exist: ${approvalResponse.decision_id}`);
          if (row.status !== 'PENDING') throw validationError('CONTROL_APPROVAL_NOT_PENDING', `approval decision is ${row.status}`);
          approvalRequest = parseJson(row.request_json);
          validateApprovalResponseBinding(approvalRequest, approvalResponse);
          if (current?.condition !== 'WAITING_HUMAN') {
            throw validationError('CONTROL_APPROVAL_WORKFLOW_NOT_WAITING', 'approval response requires workflow condition WAITING_HUMAN');
          }
        } else if (command.command_type === 'RESUME') {
          const pending = database.prepare("SELECT decision_id FROM approval_requests WHERE workflow_id=? AND status='PENDING' LIMIT 1").get(command.workflow_id);
          if (pending) {
            throw validationError('CONTROL_APPROVAL_RESPONSE_REQUIRED', `resolve pending approval before RESUME: ${pending.decision_id}`);
          }
        }
        if (command.command_type === 'ADVANCE_PHASE' && current?.phase === 'INTAKE' && command.target_phase === 'DEVELOPMENT') {
          const decisionId = command.payload?.approval_decision_id;
          const row = typeof decisionId === 'string'
            ? database.prepare("SELECT request_json, response_json, status FROM approval_requests WHERE decision_id=? AND workflow_id=?").get(decisionId, command.workflow_id)
            : null;
          const response = row?.response_json ? parseJson(row.response_json) : null;
          const request = row?.request_json ? parseJson(row.request_json) : null;
          if (!row || row.status !== 'RESOLVED' || request?.trigger !== 'IMPLEMENTATION_TRADEOFF'
            || !response || !['APPROVED', 'MODIFIED'].includes(response.outcome) || response.chosen_option_id !== 'DEMO_FAST') {
            throw validationError('CONTROL_DEMO_FAST_APPROVAL_REQUIRED', 'INTAKE to DEVELOPMENT requires a resolved approval choosing DEMO_FAST');
          }
        }
        const next = reduceWorkflow(current, command, machine);
        validateOrThrow(validateState, next, 'CONTROL_STATE_SCHEMA_INVALID');
        const previous = database.prepare('SELECT event_hash FROM workflow_events WHERE workflow_id = ? ORDER BY seq DESC LIMIT 1').get(command.workflow_id);
        const event = {
          workflow_id: command.workflow_id,
          seq: next.revision,
          revision: next.revision,
          command_id: command.command_id,
          event_type: command.command_type,
          actor: command.actor,
          occurred_at: command.occurred_at,
          from_state: current,
          to_state: next,
          payload: command.payload,
          previous_event_hash: previous?.event_hash ?? ZERO_HASH,
        };
        event.event_hash = storedEventHash(event);
        database.prepare(`
          INSERT INTO workflows(workflow_id, protocol_version, revision, phase, condition, outcome, state_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workflow_id) DO UPDATE SET
            protocol_version=excluded.protocol_version,
            revision=excluded.revision,
            phase=excluded.phase,
            condition=excluded.condition,
            outcome=excluded.outcome,
            state_json=excluded.state_json,
            updated_at=excluded.updated_at
          WHERE workflows.revision = ?
        `).run(next.workflow_id, next.protocol_version, next.revision, next.phase, next.condition, next.outcome,
          json(next), next.created_at, next.updated_at, current?.revision ?? 0);
        database.prepare(`
          INSERT INTO workflow_events(workflow_id, seq, revision, command_id, event_type, actor, occurred_at,
            from_state_json, to_state_json, payload_json, previous_event_hash, event_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(event.workflow_id, event.seq, event.revision, event.command_id, event.event_type, event.actor,
          event.occurred_at, event.from_state === null ? null : json(event.from_state), json(event.to_state),
          json(event.payload), event.previous_event_hash, event.event_hash);
        const result = { ok: true, command: 'apply', workflow_id: next.workflow_id, revision: next.revision, state: next, event };
        database.prepare(`
          INSERT INTO control_commands(command_id, workflow_id, command_sha256, command_json, result_json, committed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(command.command_id, command.workflow_id, commandHash, commandJson, json(result), new Date().toISOString());
        database.prepare(`
          INSERT INTO projection_outbox(workflow_id, revision, status, attempts, created_at)
          VALUES (?, ?, 'PENDING', 0, ?)
        `).run(command.workflow_id, next.revision, command.occurred_at);
        if (approvalRequest && command.command_type === 'WAIT_HUMAN') {
          database.prepare(`
            INSERT INTO approval_requests(decision_id, workflow_id, task_id, run_id, status, request_json, response_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'PENDING', ?, NULL, ?, ?)
          `).run(approvalRequest.decision_id, approvalRequest.workflow_id, approvalRequest.task_id, approvalRequest.run_id,
            json(approvalRequest), approvalRequest.created_at, command.occurred_at);
        }
        if (approvalResponse && command.command_type === 'RESOLVE_HUMAN') {
          database.prepare(`
            UPDATE approval_requests SET status='RESOLVED', response_json=?, updated_at=?
            WHERE decision_id=? AND status='PENDING'
          `).run(json(approvalResponse), command.occurred_at, approvalResponse.decision_id);
        }
        failpoint?.('before-workflow-commit', { command, next, event });
        database.exec('COMMIT');
        failpoint?.('after-workflow-commit', { command, next, event });
        return { ...result, idempotent_replay: false };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
        throw error;
      }
    },
    get(workflowId) { return loadWorkflow(database, workflowId); },
    events(workflowId) { return listEvents(database, workflowId); },
    workflows(options) { return listWorkflows(database, options); },
    approvals({ workflowId = null, status = null } = {}) {
      const clauses = [];
      const values = [];
      if (workflowId) { clauses.push('workflow_id=?'); values.push(workflowId); }
      if (status) { clauses.push('status=?'); values.push(status); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return database.prepare(`SELECT decision_id, workflow_id, task_id, run_id, status, request_json, response_json, created_at, updated_at
        FROM approval_requests${where} ORDER BY created_at, decision_id`).all(...values).map((row) => ({
        decision_id: row.decision_id, workflow_id: row.workflow_id, task_id: row.task_id, run_id: row.run_id,
        status: row.status, request: parseJson(row.request_json), response: parseJson(row.response_json),
        created_at: row.created_at, updated_at: row.updated_at,
      }));
    },
    requestApproval(request, { actor = 'local-orchestrator', reason = `人工审批: ${request.trigger}`, occurred_at: occurredAt = new Date().toISOString() } = {}) {
      const state = loadWorkflow(database, request.workflow_id);
      if (!state) throw validationError('CONTROL_WORKFLOW_NOT_FOUND', `workflow does not exist: ${request.workflow_id}`);
      return this.apply({
        schema_version: 1,
        command_id: `CMD-WAIT-${request.decision_id}`,
        workflow_id: request.workflow_id,
        expected_revision: state.revision,
        command_type: 'WAIT_HUMAN',
        actor,
        occurred_at: occurredAt,
        reason,
        payload: { approval_request: request },
      });
    },
    requestDemoFastApproval(workflowId, { actor = 'local-orchestrator', occurred_at: occurredAt = new Date().toISOString() } = {}) {
      const state = loadWorkflow(database, workflowId);
      if (!state) throw validationError('CONTROL_WORKFLOW_NOT_FOUND', `workflow does not exist: ${workflowId}`);
      if (state.phase !== 'INTAKE' || state.condition !== 'ACTIVE') {
        throw validationError('CONTROL_DEMO_FAST_PHASE_INVALID', 'Demo fast approval must be requested from active INTAKE');
      }
      const request = {
        schema_version: 1,
        decision_id: `DEC-${workflowId}-DEMO-FAST`,
        workflow_id: workflowId,
        task_id: null,
        run_id: null,
        trigger: 'IMPLEMENTATION_TRADEOFF',
        summary: '是否启用 Demo 快速流程并跳过大部分 Agent？',
        options: [
          { option_id: 'DEMO_FAST', description: '启用快速流程', impact: '跳过 requirement、architect、review、test、release Agent，仅保留 developer-agent 和本地测试', reversibility: 'reversible' },
          { option_id: 'STANDARD_FLOW', description: '使用标准流程', impact: '依次执行完整 Agent 流程，成本和耗时更高但校验更完整', reversibility: 'reversible' },
        ],
        recommended_option: null,
        evidence_refs: [],
        created_at: occurredAt,
        status: 'PENDING',
      };
      return this.requestApproval(request, { actor, occurred_at: occurredAt, reason: 'Demo 快速流程需要人工选择' });
    },
    resolveApproval(response, { actor = 'local-orchestrator', reason = `人工审批已回复: ${response.outcome}`, occurred_at: occurredAt = response.decided_at } = {}) {
      const state = loadWorkflow(database, response.workflow_id);
      if (!state) throw validationError('CONTROL_WORKFLOW_NOT_FOUND', `workflow does not exist: ${response.workflow_id}`);
      const result = this.apply({
        schema_version: 1,
        command_id: `CMD-RESOLVE-${response.decision_id}`,
        workflow_id: response.workflow_id,
        expected_revision: state.revision,
        command_type: 'RESOLVE_HUMAN',
        actor,
        occurred_at: occurredAt,
        reason,
        payload: { approval_response: response },
      });
      return { ...result, approval: this.approvals({ workflowId: response.workflow_id }).find((item) => item.decision_id === response.decision_id) ?? null };
    },
  };
}
