#!/usr/bin/env node

import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createManagerRequestProcessor } from './orchestrator/manager-request-queue.mjs';
import { validateManagerRequestFile } from './orchestrator/request-validation.mjs';
import { createOrchestrator } from './orchestrator/service.mjs';
import { createHrService } from './hr/service.mjs';
import { openKernelDatabase, resolveKernelConfig } from './control-kernel/database.mjs';
import { readForegroundServiceStatus, requestForegroundServiceStop, runForegroundService } from './orchestrator/foreground-service.mjs';

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
  if (command === 'init') {
    const config = resolveKernelConfig({ projectRoot }); const database = openKernelDatabase(config); database.close();
    return emit({ ok: true, command, runtime: 'orchestrator-sqlite', project_root: projectRoot, database_path: config.databasePath });
  }
  if (command === 'service-status') return emit({ ok: true, command, service: readForegroundServiceStatus(projectRoot) });
  if (command === 'stop') return emit({ ok: true, command, result: requestForegroundServiceStop(projectRoot) });
  if (command === 'validate-request') {
    if (!options['request-file']) throw Object.assign(new Error('--request-file is required'), { code: 'REQUEST_FILE_REQUIRED' });
    const request = validateManagerRequestFile(projectRoot, options['request-file']);
    return emit({ ok: true, command, request_id: request.request_id, workflow_id: request.workflow_id, request_type: request.request_type });
  }
  if (command === 'kernel-status') {
    const config = resolveKernelConfig({ projectRoot });
    const database = openKernelDatabase(config);
    try {
      const tables = database.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((row) => row.name);
      const required = ['runs', 'tasks', 'executions', 'artifacts', 'approvals', 'notifications', 'hr_jobs', 'snapshots'];
      const missing = required.filter((name) => !tables.includes(name));
      if (missing.length) {
        throw Object.assign(new Error(`Control Kernel schema is incomplete: ${missing.join(', ')}`), { code: 'KERNEL_SCHEMA_INCOMPLETE', details: { missing } });
      }
      return emit({ ok: true, command, database_path: config.databasePath, tables,
        journal_mode: database.get('PRAGMA journal_mode').journal_mode, foreign_keys: database.get('PRAGMA foreign_keys').foreign_keys === 1 });
    } finally { database.close(); }
  }
  const serveAbortController = command === 'serve' ? new AbortController() : null;
  const orchestrator = createOrchestrator({ projectRoot, signal: serveAbortController?.signal ?? null });
  const hr = createHrService({ projectRoot, repository: orchestrator.repository, snapshots: orchestrator.snapshots });
  orchestrator.attachHrService(hr);
  try {
    if (command === 'serve') {
      const requestShutdown = () => serveAbortController.abort();
      process.once('SIGINT', requestShutdown);
      process.once('SIGTERM', requestShutdown);
      try {
        const result = await runForegroundService({
          projectRoot,
          orchestrator,
          hr,
          managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null,
          pollMs: Number(options['poll-ms'] ?? 1000),
          shutdownTimeoutMs: Number(options['shutdown-timeout-seconds'] ?? 120) * 1000,
          signal: serveAbortController.signal,
          abort: () => serveAbortController.abort(),
        });
        return emit({ ok: true, command, result });
      } finally {
        process.removeListener('SIGINT', requestShutdown);
        process.removeListener('SIGTERM', requestShutdown);
      }
    }
    if (command === 'process-request') {
      if (!options['request-file']) throw Object.assign(new Error('--request-file is required'), { code: 'REQUEST_FILE_REQUIRED' });
      const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null });
      const requestFile = resolve(options['request-file']);
      if (dirname(requestFile) !== resolve(processor.requests)) throw Object.assign(new Error('--request-file must be directly inside the Manager requests directory'), { code: 'REQUEST_FILE_OUTSIDE_QUEUE' });
      return emit({ ok: true, command, receipt: await processor.processFile(basename(requestFile)), request_root: processor.root });
    }
    if (command === 'scan') {
      const processor = createManagerRequestProcessor({ orchestrator, projectRoot, managerWorkspace: options['manager-workspace'] ? resolve(options['manager-workspace']) : null });
      return emit({ ok: true, command, requests: await processor.scan(), request_root: processor.root });
    }
    if (command === 'run') return emit({ ok: true, command, result: await orchestrator.tick(options['workflow-id']) });
    if (command === 'retry-notifications') {
      const notificationIds = options['notification-id'] ? [options['notification-id']] : null;
      return emit({ ok: true, command, notifications: await orchestrator.deliverNotifications({ notificationIds }) });
    }
    if (command === 'snapshot-list') return emit({ ok: true, command, snapshots: await orchestrator.snapshots.list({ runId: options['run-id'] ?? null, taskId: options['task-id'] ?? null, agentId: options['agent-id'] ?? null, sessionId: options['session-id'] ?? null }) });
    if (command === 'snapshot-show') {
      if (!options['snapshot-id']) throw Object.assign(new Error('--snapshot-id is required'), { code: 'SNAPSHOT_ID_REQUIRED' });
      return emit({ ok: true, command, snapshot: await orchestrator.snapshots.show(options['snapshot-id']) });
    }
    if (command === 'snapshot-diff') {
      if (!options['snapshot-id']) throw Object.assign(new Error('--snapshot-id is required'), { code: 'SNAPSHOT_ID_REQUIRED' });
      return emit({ ok: true, command, ...(await orchestrator.snapshots.diff(options['snapshot-id'])) });
    }
    if (command === 'snapshot-restore') {
      if (!options['snapshot-id']) throw Object.assign(new Error('--snapshot-id is required'), { code: 'SNAPSHOT_ID_REQUIRED' });
      return emit({ ok: true, command, snapshot: await orchestrator.snapshots.restore(options['snapshot-id']) });
    }
    if (command === 'snapshot-revert') {
      if (!options['snapshot-id']) throw Object.assign(new Error('--snapshot-id is required'), { code: 'SNAPSHOT_ID_REQUIRED' });
      return emit({ ok: true, command, snapshot: await orchestrator.snapshots.revert(options['snapshot-id'], { confirm: options.confirm }) });
    }
    if (command === 'hr-review') {
      if (!options['workflow-id'] && !options['task-id'] && !options.date) throw Object.assign(new Error('one of --workflow-id, --task-id or --date is required'), { code: 'HR_REVIEW_SCOPE_REQUIRED' });
      const queued = await hr.queueReview({ workflowId: options['workflow-id'] ?? null, taskId: options['task-id'] ?? null, date: options.date ?? null, triggerMode: 'MANUAL' });
      const jobs = options['enqueue-only'] === 'true' ? [] : await hr.runPending();
      return emit({ ok: true, command, queued, jobs });
    }
    if (command === 'hr-review-daily') {
      if (!options.date) throw Object.assign(new Error('--date is required'), { code: 'HR_REVIEW_DATE_REQUIRED' });
      if (!['daily', 'both'].includes(hr.autoMode)) throw Object.assign(new Error('daily HR automation is disabled'), { code: 'HR_AUTO_MODE_DISABLED' });
      const queued = await hr.queueDailyReview(options.date); const jobs = await hr.runPending();
      return emit({ ok: true, command, queued, jobs, auto_mode: hr.autoMode });
    }
    if (command === 'hr-run-pending') return emit({ ok: true, command, jobs: await hr.runPending({ limit: Number(options.limit ?? 20) }) });
    if (command === 'status') {
      const workflow = options['workflow-id'];
      const runs = workflow ? [await orchestrator.repository.getRun(workflow)] : await orchestrator.repository.listRuns({ limit: Number(options.limit ?? 200) });
      return emit({ ok: true, command, runs,
        tasks: workflow && runs[0] ? await orchestrator.repository.listTasks({ runId: runs[0].runId }) : undefined,
        notifications: workflow && runs[0] ? await orchestrator.repository.listNotifications({ runId: runs[0].runId, statuses: ['PENDING', 'SENT', 'DELIVERED', 'FAILED'] }) : undefined });
    }
    throw new Error('usage: orchestrator-cli.mjs <init|validate-request|process-request|kernel-status|scan|run|retry-notifications|status|snapshot-list|snapshot-show|snapshot-diff|snapshot-restore|snapshot-revert|hr-review|hr-review-daily|hr-run-pending|serve|service-status|stop> [options]');
  } finally { await orchestrator.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => emit({ ok: false, error: { code: error.code ?? 'ORCHESTRATOR_ERROR', message: error.message, details: error.details ?? null } }, 1));
}
