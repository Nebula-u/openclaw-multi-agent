#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlTransitionError } from './control-core/reducer.mjs';
import { createControlRepository, openControlDatabase } from './control-core/repository.mjs';
import { createTaskRepository } from './control-core/task-repository.mjs';
import { auditControlDatabase } from './control-core/audit.mjs';
import { exportControlProjections } from './control-core/projections.mjs';
import { createSupervisionRepository } from './control-core/supervision-repository.mjs';
import { createControlSnapshot } from './control-core/read-model.mjs';

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    if (!key?.startsWith('--') || tokens[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = tokens[index + 1];
  }
  return { command, options };
}

function required(options, name) {
  if (!options[name]) throw new Error(`missing required option --${name}`);
  return options[name];
}

function emit(value, status = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = status;
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(options['project-root'] ?? process.cwd());
  const databasePath = resolve(options.db ?? join(projectRoot, 'runtime', 'control', 'control.db'));
  const database = openControlDatabase(databasePath);
  try {
    const repository = createControlRepository(projectRoot, database);
    const tasks = createTaskRepository(projectRoot, database);
    const supervision = createSupervisionRepository(projectRoot, database);
    if (command === 'init') {
      emit({ ok: true, command: 'init', database: databasePath, schema_version: 2 });
    } else if (command === 'apply') {
      const input = JSON.parse(readFileSync(resolve(required(options, 'command-file')), 'utf8'));
      emit(repository.apply(input));
    } else if (command === 'get') {
      const workflowId = required(options, 'workflow-id');
      const state = repository.get(workflowId);
      emit(state ? { ok: true, command: 'get', state } : { ok: false, command: 'get', errors: [{ code: 'CONTROL_WORKFLOW_NOT_FOUND', workflow_id: workflowId }] }, state ? 0 : 1);
    } else if (command === 'events') {
      const workflowId = required(options, 'workflow-id');
      emit({ ok: true, command: 'events', workflow_id: workflowId, events: repository.events(workflowId) });
    } else if (command === 'active') {
      emit({ ok: true, command: 'active', workflows: repository.workflows({ activeOnly: true }) });
    } else if (command === 'snapshot') {
      emit({ ok: true, command: 'snapshot', snapshot: createControlSnapshot(database, { workflowId: options['workflow-id'] ?? null }) });
    } else if (command === 'project') {
      const runtimeRoot = resolve(required(options, 'runtime-root'));
      emit({ ...exportControlProjections(database, runtimeRoot), command: 'project' });
    } else if (command === 'audit') {
      const runtimeRoot = options['runtime-root'] ? resolve(options['runtime-root']) : null;
      const result = auditControlDatabase(database, { runtimeRoot, projections: options.projections === 'true' });
      emit({ ...result, command: 'audit', effective_status: result.ok ? 'CONSISTENT' : 'HOLD' }, result.ok ? 0 : 1);
    } else if (command === 'recover') {
      const runtimeRoot = resolve(required(options, 'runtime-root'));
      const before = auditControlDatabase(database);
      if (!before.ok) {
        emit({ ...before, command: 'recover', effective_status: 'HOLD', recovered: false }, 1);
      } else {
        const projection = exportControlProjections(database, runtimeRoot);
        database.exec('PRAGMA wal_checkpoint(FULL)');
        const after = auditControlDatabase(database, { runtimeRoot, projections: true });
        emit({ ...after, command: 'recover', effective_status: after.ok ? 'CONSISTENT' : 'HOLD', recovered: after.ok, projection }, after.ok ? 0 : 1);
      }
    } else if (command === 'task-register') {
      emit(tasks.register(JSON.parse(readFileSync(resolve(required(options, 'task-file')), 'utf8'))));
    } else if (command === 'task-validate') {
      emit(tasks.validatePackage(required(options, 'task-id'), options['occurred-at']));
    } else if (command === 'task-get') {
      const task = tasks.get(required(options, 'task-id'));
      emit(task ? { ok: true, command: 'task-get', task } : { ok: false, command: 'task-get', errors: [{ code: 'TASK_NOT_FOUND' }] }, task ? 0 : 1);
    } else if (command === 'task-retry') {
      emit(tasks.retry(JSON.parse(readFileSync(resolve(required(options, 'task-file')), 'utf8'))));
    } else if (command === 'dispatch-prepare') {
      emit(tasks.prepareDispatch(JSON.parse(readFileSync(resolve(required(options, 'intent-file')), 'utf8'))));
    } else if (command === 'dispatch-receipt') {
      emit(tasks.recordReceipt(JSON.parse(readFileSync(resolve(required(options, 'receipt-file')), 'utf8'))));
    } else if (command === 'dispatch-list') {
      emit({ ok: true, command: 'dispatch-list', dispatches: tasks.dispatches(required(options, 'task-id')) });
    } else if (command === 'dispatch-outbox') {
      emit({ ok: true, command: 'dispatch-outbox', pending: tasks.outbox() });
    } else if (command === 'result-ingest') {
      emit(tasks.ingestCompletion(JSON.parse(readFileSync(resolve(required(options, 'completion-file')), 'utf8'))));
    } else if (command === 'supervision-request') {
      emit(supervision.request(JSON.parse(readFileSync(resolve(required(options, 'request-file')), 'utf8'))));
    } else if (command === 'supervision-list') {
      emit({ ok: true, command: 'supervision-list', requests: supervision.list({ status: options.status ?? null }) });
    } else if (command === 'supervision-claim') {
      emit(supervision.claim(JSON.parse(readFileSync(resolve(required(options, 'claim-file')), 'utf8'))));
    } else if (command === 'supervision-complete') {
      emit(supervision.complete(JSON.parse(readFileSync(resolve(required(options, 'receipt-file')), 'utf8'))));
    } else if (command === 'supervision-events') {
      emit({ ok: true, command: 'supervision-events', request_id: required(options, 'request-id'), events: supervision.events(required(options, 'request-id')) });
    } else if (command === 'wake-outbox') {
      emit({ ok: true, command: 'wake-outbox', pending: supervision.wakeOutbox() });
    } else if (command === 'wake-record') {
      emit(supervision.recordWake(JSON.parse(readFileSync(resolve(required(options, 'record-file')), 'utf8'))));
    } else {
      throw new Error('usage: control-kernel.mjs <init|apply|get|events|active|snapshot|project|audit|recover|task-register|task-validate|task-get|task-retry|dispatch-prepare|dispatch-receipt|dispatch-list|dispatch-outbox|result-ingest|supervision-request|supervision-list|supervision-claim|supervision-complete|supervision-events|wake-outbox|wake-record> [options]');
    }
  } catch (error) {
    const code = error instanceof ControlTransitionError ? error.code : 'CONTROL_KERNEL_ERROR';
    emit({ ok: false, command, errors: [{ code, message: error.message, ...error.details }] }, 1);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
