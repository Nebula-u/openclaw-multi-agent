import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTaskRepository } from '../control-core/task-repository.mjs';
import { reconcileDispatch } from './service.mjs';
import { runWorkflowTurn } from '../workflow-runner.mjs';

function shortHash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

function supervisionType(status) {
  return status === 'NEEDS_TASK' ? 'SEND_MESSAGE' : 'ESCALATE';
}

export function createWorkflowContinuation({ projectRoot: projectRootInput, databasePath, controlDatabase,
  supervision, enabled = true, maxTurns = 8, reconcile = reconcileDispatch, runTurn = runWorkflowTurn,
  now = () => new Date(), publish } = {}) {
  const projectRoot = resolve(projectRootInput);
  let running = false;

  function checkpoint(workflowId) {
    const row = controlDatabase.prepare(`SELECT checkpoint_id, checkpoint_blob, checkpoint_type, created_at
      FROM langgraph_checkpoints WHERE thread_id=?
      ORDER BY checkpoint_id DESC LIMIT 1`).get(workflowId);
    if (!row) return null;
    return { checkpoint_id: row.checkpoint_id, checkpoint_type: row.checkpoint_type, created_at: row.created_at };
  }

  function requestManager(workflow, graphResult) {
    if (!['NEEDS_TASK', 'HOLD', 'FAILED'].includes(graphResult.status)) return null;
    const key = `workflow-continuation/${workflow.workflow_id}/${workflow.revision}/${graphResult.status}`;
    const existing = supervision.list().find((item) => item.idempotency_key === key);
    if (existing) return { ok: true, command: 'supervision-request', request: existing, idempotent_replay: true };
    const request = {
      schema_version: 1,
      request_id: `SUP-${shortHash(key)}`,
      idempotency_key: key,
      workflow_id: workflow.workflow_id,
      task_id: graphResult.task_id ?? null,
      run_id: null,
      dispatch_id: null,
      target_agent_id: null,
      request_type: supervisionType(graphResult.status),
      source: 'WATCHDOG',
      reason: graphResult.status === 'NEEDS_TASK'
        ? `Workflow ${workflow.workflow_id} requires a task package for phase ${graphResult.phase}`
        : `Workflow ${workflow.workflow_id} stopped with ${graphResult.status}: ${graphResult.stop_reason ?? 'unknown reason'}`,
      evidence: { graph_result: graphResult, checkpoint: checkpoint(workflow.workflow_id) },
      requested_at: now().toISOString(),
    };
    const created = supervision.request(request);
    publish?.('supervision', created, { source: 'WORKFLOW_CONTINUATION' });
    return created;
  }

  return {
    async scan() {
      if (!enabled || running) return [];
      running = true;
      const results = [];
      try {
        const tasks = createTaskRepository(projectRoot, controlDatabase);
        const pending = controlDatabase.prepare(`SELECT dispatch_id, run_id FROM dispatches
          WHERE status NOT IN ('SUCCEEDED','FAILED','LOST') ORDER BY created_at`).all();
        for (const dispatch of pending) {
          const task = tasks.getRun(dispatch.run_id)?.task;
          if (!task) continue;
          const resultPath = join(task.artifact_root_abs, '.orchestrator', `${dispatch.dispatch_id}.process-result.json`);
          if (!existsSync(resultPath)) continue;
          results.push(await reconcile({ projectRoot, databasePath, dispatchId: dispatch.dispatch_id }));
        }

        const workflows = controlDatabase.prepare("SELECT workflow_id, revision, phase, condition FROM workflows WHERE condition <> 'TERMINAL' ORDER BY created_at")
          .all();
        for (const workflow of workflows) {
          let latest = null;
          for (let turn = 0; turn < maxTurns; turn += 1) {
            const run = await runTurn({ projectRoot, databasePath, workflowId: workflow.workflow_id });
            latest = run.result;
            results.push(run);
            if (latest.status !== 'PROGRESSED') break;
          }
          if (latest) {
            const current = controlDatabase.prepare('SELECT workflow_id, revision, phase, condition FROM workflows WHERE workflow_id=?')
              .get(workflow.workflow_id);
            const request = requestManager(current ?? workflow, latest);
            if (request) results.push(request);
          }
        }
        return results;
      } finally { running = false; }
    },
    status(workflowId = null) {
      const clauses = workflowId ? 'WHERE w.workflow_id=?' : "WHERE w.condition <> 'TERMINAL'";
      const rows = controlDatabase.prepare(`SELECT w.workflow_id, w.revision, w.phase, w.condition,
        (SELECT checkpoint_id FROM langgraph_checkpoints c WHERE c.thread_id=w.workflow_id
          ORDER BY checkpoint_id DESC LIMIT 1) AS checkpoint_id,
        (SELECT created_at FROM langgraph_checkpoints c WHERE c.thread_id=w.workflow_id
          ORDER BY checkpoint_id DESC LIMIT 1) AS checkpoint_at
        FROM workflows w ${clauses} ORDER BY w.created_at`).all(...(workflowId ? [workflowId] : []));
      return rows.map((row) => ({ ...row, supervisor_running: running }));
    },
    get running() { return running; },
  };
}
