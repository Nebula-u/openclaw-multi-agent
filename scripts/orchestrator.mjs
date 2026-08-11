#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createControlRepository, openControlDatabase } from './control-core/repository.mjs';
import { createTaskRepository } from './control-core/task-repository.mjs';
import { defaultCapabilityPath, initializeLocalAuthority } from './control-core/local-authority.mjs';
import { dispatchReadyTask } from './orchestrator/service.mjs';
import { createManagerSessionContext } from './orchestrator/manager-context.mjs';
import { runWorkflowTurn } from './workflow-runner.mjs';

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
    if (command === 'workflow-run') {
      const value = await runWorkflowTurn({
        projectRoot,
        databasePath,
        workflowId: required(options, 'workflow-id'),
        graphRunId: options['graph-run-id'],
        requestedTargetPhase: options['target-phase'] ?? null,
        afterRevision: options['after-revision'] ?? null,
      });
      return emit(value, value.ok ? 0 : 1);
    }
    const database = openControlDatabase(databasePath);
    try {
      const controls = createControlRepository(projectRoot, database);
      const tasks = createTaskRepository(projectRoot, database);
      if (command === 'manager-context') {
        return emit({ ok: true, command: 'manager-context', ...createManagerSessionContext({
          projectRoot,
          database,
          workflowId: required(options, 'workflow-id'),
          estimatedTokens: options['estimated-tokens'] ?? null,
        }) });
      }
      if (command === 'apply') {
        const input = JSON.parse(readFileSync(resolve(required(options, 'command-file')), 'utf8'));
        return emit(controls.apply({ ...input, actor: 'local-orchestrator' }));
      }
      if (command === 'task-register') {
        const input = JSON.parse(readFileSync(resolve(required(options, 'task-file')), 'utf8'));
        return emit(tasks.register(input));
      }
      if (command === 'task-validate') return emit(tasks.validatePackage(required(options, 'task-id'), options['occurred-at']));
      if (command === 'approval-request') {
        const input = JSON.parse(readFileSync(resolve(required(options, 'request-file')), 'utf8'));
        return emit(controls.requestApproval(input, { actor: 'local-orchestrator' }));
      }
      if (command === 'approval-list') {
        return emit({ ok: true, command: 'approval-list', approvals: controls.approvals({ workflowId: options['workflow-id'] ?? null, status: options.status ?? null }) });
      }
      if (command === 'demo-fast-request') {
        return emit(controls.requestDemoFastApproval(required(options, 'workflow-id'), { actor: 'local-orchestrator' }));
      }
      if (command === 'approval-resolve') {
        let response;
        if (options['response-file']) {
          response = JSON.parse(readFileSync(resolve(options['response-file']), 'utf8'));
        } else {
          const decisionId = required(options, 'decision-id');
          const pending = controls.approvals({ status: 'PENDING' }).find((item) => item.decision_id === decisionId);
          if (!pending) throw new Error(`pending approval not found: ${decisionId}`);
          const decidedBy = required(options, 'decided-by');
          const rawReply = required(options, 'raw-user-reply');
          if (!/^human:/u.test(decidedBy)) throw new Error('decided-by must identify a human and start with human:');
          const outcome = required(options, 'outcome');
          const chosenOptionId = options['chosen-option-id'] ?? null;
          response = {
            schema_version: 1,
            decision_id: pending.decision_id,
            workflow_id: pending.workflow_id,
            task_id: pending.task_id,
            run_id: pending.run_id,
            outcome,
            chosen_option_id: chosenOptionId,
            raw_user_reply_summary: rawReply,
            decided_by: decidedBy,
            decided_at: options['decided-at'] ?? new Date().toISOString(),
            notes: options.notes ?? '',
          };
        }
        const resolved = controls.resolveApproval(response, { actor: 'local-orchestrator' });
        const task = response.task_id ? tasks.resumeHumanTask({ task_id: response.task_id, decision_id: response.decision_id, occurred_at: response.decided_at }) : null;
        return emit({ ...resolved, task });
      }
      throw new Error('usage: orchestrator.mjs <init|manager-context|apply|task-register|task-validate|dispatch|workflow-run|demo-fast-request|approval-request|approval-list|approval-resolve --response-file <abs>|--decision-id <id> --outcome <...> --chosen-option-id <id> --raw-user-reply <text> --decided-by human:<id>> [options]');
    } finally { database.close(); }
  } catch (error) {
    emit({ ok: false, command, errors: [{ code: error.code ?? 'ORCHESTRATOR_ERROR', message: error.message, ...error.details }] }, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
