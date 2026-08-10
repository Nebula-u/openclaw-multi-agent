#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openControlDatabase } from './control-core/repository.mjs';
import { acquireWorkflowLock } from './runtime-core/workflow-lock.mjs';
import { createWorkflowGraphAdapter } from './orchestrator/workflow-graph/control-adapter.mjs';
import { buildWorkflowGraph } from './orchestrator/workflow-graph/graph.mjs';
import { loadWorkflowGraphPolicy } from './orchestrator/workflow-graph/phase-policy.mjs';
import { createGraphResultValidator, graphRunResult } from './orchestrator/workflow-graph/result.mjs';

function errorResult({ graphRunId, workflowId, error }) {
  return {
    schema_version: 1, graph_run_id: graphRunId, workflow_id: workflowId, status: 'FAILED',
    before_revision: null, after_revision: null, action: null, phase: null, next_phase: null,
    task_id: null, stop_reason: error.code ?? 'WORKFLOW_GRAPH_ERROR',
    errors: [{ code: error.code ?? 'WORKFLOW_GRAPH_ERROR', message: error.message }],
  };
}

export async function runWorkflowTurn({ projectRoot: projectRootInput, databasePath: databasePathInput, workflowId,
  graphRunId = `GR-${randomUUID()}`, requestedTargetPhase = null, runner, clock = () => new Date() } = {}) {
  const projectRoot = resolve(projectRootInput);
  const databasePath = resolve(databasePathInput ?? join(projectRoot, 'runtime', 'control', 'control.db'));
  if (!/^WF-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(workflowId ?? '')) throw Object.assign(new Error('valid workflowId is required'), { code: 'GRAPH_WORKFLOW_ID_INVALID' });
  if (!/^GR-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(graphRunId)) throw Object.assign(new Error('valid graphRunId is required'), { code: 'GRAPH_RUN_ID_INVALID' });
  const lock = acquireWorkflowLock(join(dirname(databasePath), 'graph-locks', `${workflowId}.lock`), { purpose: `stategraph:${workflowId}` });
  let database = null;
  try {
    database = openControlDatabase(databasePath);
    const { policy, machine } = loadWorkflowGraphPolicy(projectRoot);
    const adapter = createWorkflowGraphAdapter({ projectRoot, databasePath, database, runner, clock });
    const graph = buildWorkflowGraph({ adapter, policy, machine });
    const state = await graph.invoke({ workflowId, graphRunId, requestedTargetPhase }, { recursionLimit: 20 });
    const result = graphRunResult(state);
    const validate = createGraphResultValidator(projectRoot);
    if (!validate(result)) throw Object.assign(new Error('workflow graph produced an invalid run result'), { code: 'GRAPH_RESULT_SCHEMA_INVALID', details: validate.errors });
    return { ok: !['FAILED'].includes(result.status), command: 'workflow-run', result };
  } catch (error) {
    const result = errorResult({ graphRunId, workflowId, error });
    return { ok: false, command: 'workflow-run', result };
  } finally {
    database?.close();
    lock.release();
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error(`invalid argument: ${key ?? ''}`);
    options[key.slice(2)] = argv[index + 1];
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = resolve(options['project-root'] ?? process.cwd());
  const result = await runWorkflowTurn({
    projectRoot,
    databasePath: options.db,
    workflowId: options['workflow-id'],
    graphRunId: options['graph-run-id'],
    requestedTargetPhase: options['target-phase'] ?? null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
