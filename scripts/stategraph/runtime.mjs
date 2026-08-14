import { join, resolve } from 'node:path';
import { auditEventChain, sha256 } from './events.mjs';
import { assertAuthority } from './authority.mjs';
import { openStateGraphDatabase } from './database.mjs';
import { createForcedDispatcher } from './dispatcher.mjs';
import { buildWorkflowGraph } from './graph.mjs';
import { loadStateGraphPolicy } from './policy.mjs';
import { SqliteCheckpointSaver } from './sqlite-checkpointer.mjs';
import { withWorkflowLock } from './workflow-lock.mjs';
import { createCompactManagerContext } from './manager-context.mjs';
import { createGitWorktreeManager } from './git-worktree.mjs';

export function defaultDatabasePath(projectRootInput) {
  return join(resolve(projectRootInput), 'runtime', 'stategraph', 'checkpoints.db');
}

function publicResult(state) {
  return {
    ok: state.condition !== 'HOLD',
    workflow_id: state.workflowId,
    revision: state.revision,
    phase: state.phase,
    condition: state.condition,
    outcome: state.outcome,
    stop_reason: state.stopReason,
    last_action: state.lastAction,
    route_hash: state.routePlan?.route_hash ?? null,
    pending_approval: state.pendingApproval,
    active_task_id: state.activeTaskId,
  };
}

export function createStateGraphRuntime({ projectRoot: projectRootInput, databasePath = null, database = null,
  dispatcher = null, worktrees: worktreesInput = null, policy = null, clock = () => new Date(), skipAuthority = false } = {}) {
  const projectRoot = resolve(projectRootInput);
  const ownDatabase = !database;
  const connection = database ?? openStateGraphDatabase(databasePath ?? defaultDatabasePath(projectRoot));
  const selectedPolicy = policy ?? loadStateGraphPolicy(projectRoot);
  const checkpointer = new SqliteCheckpointSaver(connection);
  const worktrees = worktreesInput ?? createGitWorktreeManager({ projectRoot });
  const selectedDispatcher = dispatcher ?? createForcedDispatcher({ projectRoot, policy: selectedPolicy, clock, worktrees });
  const graph = buildWorkflowGraph({ projectRoot, policy: selectedPolicy, dispatcher: selectedDispatcher, worktrees, clock, sha256 }, { checkpointer });
  const config = (workflowId) => ({ configurable: { thread_id: workflowId, checkpoint_ns: '' }, recursionLimit: 20 });

  async function state(workflowId) {
    const snapshot = await graph.getState(config(workflowId));
    return snapshot?.values?.createdAt ? snapshot.values : null;
  }

  async function list() {
    const values = [];
    for (const row of checkpointer.threadIds()) {
      const item = await state(row.thread_id);
      if (item) values.push(item);
    }
    return values;
  }

  async function invoke(workflowId, input, authorityKind = 'runtime') {
    if (!skipAuthority) assertAuthority(projectRoot, authorityKind);
    return withWorkflowLock(projectRoot, workflowId, async () => {
      const value = await graph.invoke(input, config(workflowId));
      return { ...publicResult(value), state: value };
    });
  }

  return {
    projectRoot,
    database: connection,
    checkpointer,
    graph,
    policy: selectedPolicy,
    async bootstrap({ workflowId, request }) {
      if (await state(workflowId)) throw Object.assign(new Error(`workflow already exists: ${workflowId}`), { code: 'WORKFLOW_ALREADY_EXISTS' });
      return invoke(workflowId, { workflowId, request }, 'runtime');
    },
    async run(workflowId) {
      if (!await state(workflowId)) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return invoke(workflowId, { workflowId }, 'runtime');
    },
    async approve(workflowId, command) {
      if (!await state(workflowId)) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return invoke(workflowId, { workflowId, operatorCommand: command }, 'human');
    },
    state,
    list,
    async audit(workflowId = null) {
      const values = workflowId ? [await state(workflowId)].filter(Boolean) : await list();
      const workflows = values.map(auditEventChain);
      return { ok: workflows.every((item) => item.ok), database: 'LANGGRAPH_CHECKPOINTS', workflows };
    },
    async managerContext(workflowId) {
      const value = await state(workflowId);
      if (!value) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return createCompactManagerContext(value, selectedPolicy);
    },
    publicResult,
    close() { if (ownDatabase) connection.close(); },
  };
}
