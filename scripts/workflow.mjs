#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeAuthority } from './stategraph/authority.mjs';
import { createStateGraphRuntime } from './stategraph/runtime.mjs';

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
  if (!options[name]) throw new Error(`missing --${name}`);
  return options[name];
}

function emit(value, status = 0) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exitCode = status;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(options['project-root'] ?? process.cwd());
  if (command === 'init') return emit({ ok: true, command, capabilities: initializeAuthority(projectRoot) });
  const runtime = createStateGraphRuntime({ projectRoot, databasePath: options.db ? resolve(options.db) : null });
  try {
    if (command === 'bootstrap') {
      const request = JSON.parse(readFileSync(resolve(required(options, 'request-file')), 'utf8'));
      return emit(await runtime.bootstrap({ workflowId: required(options, 'workflow-id'), request }));
    }
    if (command === 'run') return emit(await runtime.run(required(options, 'workflow-id')));
    if (command === 'approve') {
      const value = await runtime.approve(required(options, 'workflow-id'), {
        decision_id: required(options, 'decision-id'),
        choice: required(options, 'choice'),
        decided_by: required(options, 'decided-by'),
        notes: options.notes ?? '',
        decided_at: options['decided-at'] ?? new Date().toISOString(),
      });
      return emit(value);
    }
    if (command === 'snapshot') {
      const value = options['workflow-id'] ? await runtime.state(options['workflow-id']) : await runtime.list();
      return emit({ ok: true, command, snapshot: value });
    }
    if (command === 'audit') return emit(await runtime.audit(options['workflow-id'] ?? null));
    if (command === 'kernel-status') {
      if (!runtime.kernel) throw Object.assign(new Error('kernel-status requires PostgreSQL runtime'), { code: 'KERNEL_UNAVAILABLE' });
      return emit({
        ok: true,
        command,
        runs: await runtime.kernel.listRuns({ limit: Number(options.limit ?? 200) }),
        tasks: await runtime.kernel.listTasks({ limit: Number(options.limit ?? 1000) }),
        executions: await runtime.kernel.listExecutions({ limit: Number(options.limit ?? 1000) }),
      });
    }
    if (command === 'manager-context') return emit({ ok: true, command, context: await runtime.managerContext(required(options, 'workflow-id')) });
    throw new Error('usage: workflow.mjs <init|bootstrap|run|approve|snapshot|audit|kernel-status|manager-context> [options]');
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => emit({ ok: false, error: { code: error.code ?? 'STATEGRAPH_ERROR', message: error.message, details: error.details ?? null } }, 1));
}
