#!/usr/bin/env node

import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createManagerRequestProcessor } from './orchestrator/manager-request-queue.mjs';
import { validateManagerRequestFile } from './orchestrator/request-validation.mjs';
import { createOrchestrator } from './orchestrator/service.mjs';
import { createHrService } from './hr/service.mjs';
import { createKernelPool, resolveKernelConfig } from './control-kernel/pool.mjs';

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
  if (command === 'validate-request') {
    if (!options['request-file']) throw Object.assign(new Error('--request-file is required'), { code: 'REQUEST_FILE_REQUIRED' });
    const request = validateManagerRequestFile(projectRoot, options['request-file']);
    return emit({ ok: true, command, request_id: request.request_id, workflow_id: request.workflow_id, request_type: request.request_type });
  }
  if (command === 'kernel-status') {
    const config = resolveKernelConfig({ projectRoot });
    const pool = createKernelPool(config);
    try {
      const { rows } = await pool.query(
        `SELECT current_database() AS database, current_schema() AS schema,
          current_setting('search_path') AS search_path,
          to_regclass('runs') AS runs, to_regclass('tasks') AS tasks,
          to_regclass('executions') AS executions, to_regclass('artifacts') AS artifacts,
          to_regclass('events') AS events, to_regclass('approvals') AS approvals,
          to_regclass('notifications') AS notifications, to_regclass('hr_jobs') AS hr_jobs`,
      );
      const status = rows[0];
      const missing = ['runs', 'tasks', 'executions', 'artifacts', 'events', 'approvals', 'notifications', 'hr_jobs']
        .filter((name) => status[name] === null);
      if (missing.length) {
        throw Object.assign(new Error(`Control Kernel schema is incomplete: ${missing.join(', ')}`), {
          code: 'KERNEL_SCHEMA_INCOMPLETE', details: { missing, schema: config.kernelSchema },
        });
      }
      return emit({ ok: true, command, kernel_schema: config.kernelSchema, ...status });
    } finally { await pool.end(); }
  }
  const orchestrator = createOrchestrator({ projectRoot });
  const hr = createHrService({ projectRoot, repository: orchestrator.repository, kernel: orchestrator.kernel });
  orchestrator.attachHrService(hr);
  try {
    if (command === 'process-request') {
      if (!options['request-file']) throw Object.assign(new Error('--request-file is required'), { code: 'REQUEST_FILE_REQUIRED' });
      const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null });
      const requestFile = resolve(options['request-file']);
      if (dirname(requestFile) !== resolve(processor.requests)) throw Object.assign(new Error('--request-file must be directly inside the Manager requests directory'), { code: 'REQUEST_FILE_OUTSIDE_QUEUE' });
      return emit({ ok: true, command, receipt: await processor.processFile(basename(requestFile)), request_root: processor.root });
    }
    if (command === 'scan') {
      const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null });
      return emit({ ok: true, command, requests: await processor.scan(), hr_jobs: await hr.runPending(), request_root: processor.root });
    }
    if (command === 'run') return emit({ ok: true, command, result: await orchestrator.tick(options['workflow-id']) });
    if (command === 'retry-notifications') {
      const notificationIds = options['notification-id'] ? [options['notification-id']] : null;
      return emit({ ok: true, command, notifications: await orchestrator.deliverNotifications({ notificationIds }), hr_jobs: await hr.runPending() });
    }
    if (command === 'status') {
      const workflow = options['workflow-id'];
      const runs = workflow ? [await orchestrator.repository.getRun(workflow)] : await orchestrator.repository.listRuns({ limit: Number(options.limit ?? 200) });
      return emit({ ok: true, command, runs,
        tasks: workflow && runs[0] ? await orchestrator.repository.listTasks({ runId: runs[0].runId }) : undefined,
        notifications: workflow && runs[0] ? await orchestrator.repository.listNotifications({ runId: runs[0].runId, statuses: ['PENDING', 'SENT', 'DELIVERED', 'FAILED'] }) : undefined });
    }
    throw new Error('usage: orchestrator-cli.mjs <init|validate-request|process-request|kernel-status|scan|run|retry-notifications|status> [options]');
  } finally { await orchestrator.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => emit({ ok: false, error: { code: error.code ?? 'ORCHESTRATOR_ERROR', message: error.message, details: error.details ?? null } }, 1));
}
