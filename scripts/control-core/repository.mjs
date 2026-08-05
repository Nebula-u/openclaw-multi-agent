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

function validateOrThrow(validate, value, code) {
  if (!validate(value)) {
    throw validationError(code, 'JSON Schema validation failed', { errors: structuredClone(validate.errors ?? []) });
  }
}

function storedEventHash(event) {
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

export function createControlRepository(projectRootInput, database) {
  const projectRoot = resolve(projectRootInput);
  const commandSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'transition-command.schema.json'), 'utf8'));
  const stateSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'control-state-v2.schema.json'), 'utf8'));
  const machine = JSON.parse(readFileSync(join(projectRoot, 'config', 'control-state-machine-v2.json'), 'utf8'));
  const validateCommand = validator(commandSchema);
  const validateState = validator(stateSchema);

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
        database.exec('COMMIT');
        return { ...result, idempotent_replay: false };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* transaction may already be closed */ }
        throw error;
      }
    },
    get(workflowId) { return loadWorkflow(database, workflowId); },
    events(workflowId) { return listEvents(database, workflowId); },
  };
}

