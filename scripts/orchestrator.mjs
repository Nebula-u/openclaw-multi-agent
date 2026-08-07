#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createControlRepository, openControlDatabase } from './control-core/repository.mjs';
import { createTaskRepository } from './control-core/task-repository.mjs';
import { defaultCapabilityPath, initializeLocalAuthority } from './control-core/local-authority.mjs';
import { dispatchReadyTask } from './orchestrator/service.mjs';

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

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(options['project-root'] ?? process.cwd());
  const databasePath = resolve(options.db ?? join(projectRoot, 'runtime', 'control', 'control.db'));
  try {
    if (command === 'init') {
      const value = initializeLocalAuthority(resolve(options['capability-file'] ?? defaultCapabilityPath(projectRoot)));
      return emit({ ok: true, command: 'init', capability_path_abs: value.path, created: value.created,
        note: 'Keep this file readable only by the local Orchestrator service account; direct Control Kernel mutations require OPENCLAW_CONTROL_CAPABILITY.' });
    }
    if (command === 'dispatch') {
      const value = await dispatchReadyTask({ projectRoot, databasePath, taskId: required(options, 'task-id'),
        timeoutSeconds: Number(options['timeout-seconds'] ?? 900), leaseSeconds: Number(options['lease-seconds'] ?? 900) });
      return emit(value, value.ok ? 0 : 1);
    }
    const database = openControlDatabase(databasePath);
    try {
      const controls = createControlRepository(projectRoot, database);
      const tasks = createTaskRepository(projectRoot, database);
      if (command === 'apply') {
        const input = JSON.parse(readFileSync(resolve(required(options, 'command-file')), 'utf8'));
        return emit(controls.apply({ ...input, actor: 'local-orchestrator' }));
      }
      if (command === 'task-register') {
        const input = JSON.parse(readFileSync(resolve(required(options, 'task-file')), 'utf8'));
        return emit(tasks.register(input));
      }
      if (command === 'task-validate') return emit(tasks.validatePackage(required(options, 'task-id'), options['occurred-at']));
      throw new Error('usage: orchestrator.mjs <init|apply|task-register|task-validate|dispatch> [options]');
    } finally { database.close(); }
  } catch (error) {
    emit({ ok: false, command, errors: [{ code: error.code ?? 'ORCHESTRATOR_ERROR', message: error.message, ...error.details }] }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
