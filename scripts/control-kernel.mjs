#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ControlTransitionError } from './control-core/reducer.mjs';
import { createControlRepository, openControlDatabase } from './control-core/repository.mjs';

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
    } else {
      throw new Error('usage: control-kernel.mjs <init|apply|get|events> [options]');
    }
  } catch (error) {
    const code = error instanceof ControlTransitionError ? error.code : 'CONTROL_KERNEL_ERROR';
    emit({ ok: false, command, errors: [{ code, message: error.message, ...error.details }] }, 1);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

