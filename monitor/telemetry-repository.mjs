import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

function json(value) { return JSON.stringify(value); }
function parseJson(value) { return value == null ? null : JSON.parse(value); }

function compile(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export function openTelemetryDatabase(pathInput) {
  const path = pathInput === ':memory:' ? pathInput : resolve(pathInput);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=5000;');
  if (path !== ':memory:') database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  database.exec(`
    CREATE TABLE IF NOT EXISTS monitor_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      session_id TEXT,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      producer TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_activities (
      activity_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      task_id TEXT,
      run_id TEXT,
      dispatch_id TEXT,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      activity_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_cursors (
      source_path TEXT PRIMARY KEY,
      offset_bytes INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_cursors (
      source_path TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_health_snapshots (
      workflow_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT,
      health TEXT NOT NULL,
      confidence TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      calculated_at TEXT NOT NULL,
      PRIMARY KEY(workflow_id, task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS redaction_audit (
      redaction_id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      details_json TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

export function createTelemetryRepository(projectRootInput, database) {
  const projectRoot = resolve(projectRootInput);
  const activitySchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'agent-activity.schema.json'), 'utf8'));
  const eventSchema = JSON.parse(readFileSync(join(projectRoot, 'contracts', 'monitor-event.schema.json'), 'utf8'));
  const validateActivity = compile(activitySchema);
  const validateEvent = compile(eventSchema);
  return {
    addActivity(activity, event) {
      if (!validateActivity(activity)) throw Object.assign(new Error('activity schema validation failed'), { code: 'ACTIVITY_SCHEMA_INVALID', details: { errors: structuredClone(validateActivity.errors ?? []) } });
      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = database.prepare('SELECT activity_json FROM agent_activities WHERE activity_id=?').get(activity.activity_id);
        if (existing) {
          if (existing.activity_json !== json(activity)) throw Object.assign(new Error('activity_id already used with different content'), { code: 'ACTIVITY_IDEMPOTENCY_CONFLICT' });
          database.exec('COMMIT');
          return { activity, event: this.eventById(event.event_id), idempotent_replay: true };
        }
        database.prepare(`INSERT INTO agent_activities(activity_id, workflow_id, task_id, run_id, dispatch_id, agent_id,
          session_id, kind, status, timestamp, activity_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(activity.activity_id, activity.workflow_id, activity.task_id ?? null, activity.run_id ?? null,
            activity.dispatch_id ?? null, activity.agent_id, activity.session_id ?? null, activity.kind,
            activity.status, activity.timestamp, json(activity));
        const stored = this.addEvent(event);
        database.exec('COMMIT');
        return { activity, event: stored, idempotent_replay: false };
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch { /* transaction may be closed */ }
        throw error;
      }
    },
    addEvent(event) {
      if (!validateEvent(event)) throw Object.assign(new Error('monitor event schema validation failed'), { code: 'MONITOR_EVENT_SCHEMA_INVALID', details: { errors: structuredClone(validateEvent.errors ?? []) } });
      const existing = database.prepare('SELECT event_json FROM monitor_events WHERE event_id=?').get(event.event_id);
      if (existing) return parseJson(existing.event_json);
      const result = database.prepare(`INSERT INTO monitor_events(event_id, workflow_id, task_id, run_id, session_id, topic,
        event_type, producer, source, timestamp, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.event_id, event.workflow_id, event.task_id ?? null, event.run_id ?? null, event.session_id ?? null,
          event.topic, event.event_type, event.producer, event.source, event.timestamp, json(event));
      const stored = { ...event, sequence: Number(result.lastInsertRowid) };
      database.prepare('UPDATE monitor_events SET event_json=? WHERE event_id=?').run(json(stored), event.event_id);
      return stored;
    },
    eventById(eventId) { const row = database.prepare('SELECT event_json FROM monitor_events WHERE event_id=?').get(eventId); return row ? parseJson(row.event_json) : null; },
    events({ workflowId = null, after = 0, limit = 500 } = {}) {
      const rows = workflowId
        ? database.prepare('SELECT event_json FROM monitor_events WHERE workflow_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(workflowId, after, limit)
        : database.prepare('SELECT event_json FROM monitor_events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, limit);
      return rows.map((row) => parseJson(row.event_json));
    },
    activities({ taskId = null, agentId = null, limit = 500 } = {}) {
      let rows;
      if (taskId) rows = database.prepare('SELECT activity_json FROM agent_activities WHERE task_id=? ORDER BY timestamp DESC LIMIT ?').all(taskId, limit);
      else if (agentId) rows = database.prepare('SELECT activity_json FROM agent_activities WHERE agent_id=? ORDER BY timestamp DESC LIMIT ?').all(agentId, limit);
      else rows = database.prepare('SELECT activity_json FROM agent_activities ORDER BY timestamp DESC LIMIT ?').all(limit);
      return rows.map((row) => parseJson(row.activity_json));
    },
    latestActivity(taskId) { const row = database.prepare('SELECT activity_json FROM agent_activities WHERE task_id=? ORDER BY timestamp DESC LIMIT 1').get(taskId); return row ? parseJson(row.activity_json) : null; },
    latestEvent(taskId) { const row = database.prepare('SELECT event_json FROM monitor_events WHERE task_id=? ORDER BY sequence DESC LIMIT 1').get(taskId); return row ? parseJson(row.event_json) : null; },
    getSessionCursor(path) { return database.prepare('SELECT offset_bytes FROM session_cursors WHERE source_path=?').get(path)?.offset_bytes ?? 0; },
    setSessionCursor(path, offset, at) { database.prepare(`INSERT INTO session_cursors(source_path, offset_bytes, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET offset_bytes=excluded.offset_bytes, updated_at=excluded.updated_at`).run(path, offset, at); },
    getArtifactCursor(path) { return database.prepare('SELECT signature FROM artifact_cursors WHERE source_path=?').get(path)?.signature ?? null; },
    setArtifactCursor(path, signature, at) { database.prepare(`INSERT INTO artifact_cursors(source_path, signature, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET signature=excluded.signature, updated_at=excluded.updated_at`).run(path, signature, at); },
    saveHealth(value) { database.prepare(`INSERT INTO agent_health_snapshots(workflow_id, task_id, run_id, health, confidence, evidence_json, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workflow_id, task_id) DO UPDATE SET run_id=excluded.run_id, health=excluded.health,
      confidence=excluded.confidence, evidence_json=excluded.evidence_json, calculated_at=excluded.calculated_at`)
      .run(value.workflow_id, value.task_id, value.run_id ?? null, value.health, value.confidence, json(value.evidence), value.calculated_at); },
    health(taskId) { const row = database.prepare('SELECT * FROM agent_health_snapshots WHERE task_id=?').get(taskId); return row ? { workflow_id: row.workflow_id, task_id: row.task_id, run_id: row.run_id, health: row.health, confidence: row.confidence, evidence: parseJson(row.evidence_json), calculated_at: row.calculated_at } : null; },
    healthList(workflowId = null) { const rows = workflowId ? database.prepare('SELECT * FROM agent_health_snapshots WHERE workflow_id=? ORDER BY task_id').all(workflowId)
      : database.prepare('SELECT * FROM agent_health_snapshots ORDER BY workflow_id, task_id').all(); return rows.map((row) => ({ workflow_id: row.workflow_id, task_id: row.task_id, run_id: row.run_id, health: row.health, confidence: row.confidence, evidence: parseJson(row.evidence_json), calculated_at: row.calculated_at })); },
  };
}
