#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createManagerRequestProcessor } from './orchestrator/manager-request-queue.mjs';
import { createOrchestrator } from './orchestrator/service.mjs';

function parseArgs(argv) {
  const [command, ...tokens] = argv; const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    if (!tokens[index]?.startsWith('--') || tokens[index + 1] === undefined) throw new Error(`invalid argument: ${tokens[index] ?? ''}`);
    options[tokens[index].slice(2)] = tokens[index + 1];
  }
  return { command, options };
}
function emit(value, status = 0) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); process.exitCode = status; }

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv); const projectRoot = resolve(options['project-root'] ?? process.cwd());
  if (command === 'init') return emit({ ok: true, command, runtime: 'orchestrator-postgresql', project_root: projectRoot });
  const orchestrator = createOrchestrator({ projectRoot });
  try {
    if (command === 'scan') {
      const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null });
      return emit({ ok: true, command, requests: await processor.scan(), request_root: processor.root });
    }
    if (command === 'run') return emit({ ok: true, command, result: await orchestrator.tick(options['workflow-id']) });
    if (command === 'retry-notifications') return emit({ ok: true, command, notifications: await orchestrator.deliverNotifications() });
    if (command === 'status') {
      const workflow = options['workflow-id'];
      const runs = workflow ? [await orchestrator.repository.getRun(workflow)] : await orchestrator.repository.listRuns({ limit: Number(options.limit ?? 200) });
      return emit({ ok: true, command, runs, tasks: workflow && runs[0] ? await orchestrator.repository.listTasks({ runId: runs[0].runId }) : undefined });
    }
    throw new Error('usage: orchestrator-cli.mjs <init|scan|run|retry-notifications|status> [options]');
  } finally { await orchestrator.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => emit({ ok: false, error: { code: error.code ?? 'ORCHESTRATOR_ERROR', message: error.message, details: error.details ?? null } }, 1));
}
