import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile, atomicWriteJson, canonicalJson, ensureDirectory } from '../runtime-core/atomic-store.mjs';
import { acquireWorkflowLock } from '../runtime-core/workflow-lock.mjs';
import { listEvents, listWorkflows } from './repository.mjs';

function projectionRoot(runtimeRoot) {
  return join(resolve(runtimeRoot), 'control', 'v2');
}

export function expectedProjection(database, runtimeRoot) {
  const root = projectionRoot(runtimeRoot);
  const workflows = listWorkflows(database);
  const active = listWorkflows(database, { activeOnly: true }).map((state) => ({
    workflow_id: state.workflow_id,
    revision: state.revision,
    phase: state.phase,
    condition: state.condition,
    outcome: state.outcome,
    updated_at: state.updated_at,
    workflow_json_abs: resolve(root, 'workflows', state.workflow_id, 'workflow.json'),
  }));
  return { root, workflows, active };
}

export function exportControlProjections(database, runtimeRoot) {
  const root = projectionRoot(runtimeRoot);
  ensureDirectory(root);
  const lock = acquireWorkflowLock(join(root, '.projection.lock'), { purpose: 'control-v2-projection' });
  try {
    const expected = expectedProjection(database, runtimeRoot);
    const generatedAt = new Date().toISOString();
    for (const state of expected.workflows) {
      const directory = join(root, 'workflows', state.workflow_id);
      ensureDirectory(directory);
      atomicWriteJson(join(directory, 'workflow.json'), state);
      const events = listEvents(database, state.workflow_id);
      atomicWriteFile(join(directory, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
      atomicWriteJson(join(directory, 'projection.json'), {
        schema_version: 1,
        projection: 'READ_ONLY_DERIVED',
        workflow_id: state.workflow_id,
        revision: state.revision,
        event_count: events.length,
        generated_at: generatedAt,
      });
    }
    atomicWriteJson(join(root, 'active-workflows.json'), {
      schema_version: 2,
      projection: 'READ_ONLY_DERIVED',
      generated_at: generatedAt,
      workflows: expected.active,
    });
    database.exec('BEGIN IMMEDIATE');
    try {
      const markApplied = database.prepare(`
        UPDATE projection_outbox SET status='APPLIED', attempts=attempts+1, last_error=NULL, applied_at=?
        WHERE workflow_id=? AND revision<=? AND status IN ('PENDING', 'FAILED')
      `);
      for (const state of expected.workflows) markApplied.run(generatedAt, state.workflow_id, state.revision);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, root, generated_at: generatedAt, workflows: expected.workflows.length, active_workflows: expected.active.length };
  } catch (error) {
    try {
      database.prepare(`
        UPDATE projection_outbox SET status='FAILED', attempts=attempts+1, last_error=?
        WHERE status='PENDING'
      `).run(String(error.message ?? error));
    } catch { /* keep the original projection failure */ }
    throw error;
  } finally {
    lock.release();
  }
}

function readJson(path, errors, code) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    errors.push({ code, path, message: error.message });
    return null;
  }
}

export function auditProjectionFiles(database, runtimeRoot) {
  const expected = expectedProjection(database, runtimeRoot);
  const errors = [];
  for (const state of expected.workflows) {
    const directory = join(expected.root, 'workflows', state.workflow_id);
    const statePath = join(directory, 'workflow.json');
    const eventsPath = join(directory, 'events.jsonl');
    const projectedState = readJson(statePath, errors, 'CONTROL_PROJECTION_STATE_UNREADABLE');
    if (projectedState && canonicalJson(projectedState) !== canonicalJson(state)) {
      errors.push({ code: 'CONTROL_PROJECTION_STATE_DRIFT', path: statePath });
    }
    if (!existsSync(eventsPath)) {
      errors.push({ code: 'CONTROL_PROJECTION_EVENTS_UNREADABLE', path: eventsPath });
    } else {
      try {
        const projectedEvents = readFileSync(eventsPath, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
        if (canonicalJson(projectedEvents) !== canonicalJson(listEvents(database, state.workflow_id))) {
          errors.push({ code: 'CONTROL_PROJECTION_EVENTS_DRIFT', path: eventsPath });
        }
      } catch (error) {
        errors.push({ code: 'CONTROL_PROJECTION_EVENTS_UNREADABLE', path: eventsPath, message: error.message });
      }
    }
  }
  const activePath = join(expected.root, 'active-workflows.json');
  const active = readJson(activePath, errors, 'CONTROL_PROJECTION_ACTIVE_UNREADABLE');
  if (active && canonicalJson(active.workflows) !== canonicalJson(expected.active)) {
    errors.push({ code: 'CONTROL_PROJECTION_ACTIVE_DRIFT', path: activePath });
  }
  return errors;
}
