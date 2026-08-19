import { resolve } from 'node:path';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { auditEventChain, sha256 } from './events.mjs';
import { assertAuthority } from './authority.mjs';
import { createForcedDispatcher } from './dispatcher.mjs';
import { buildWorkflowGraph } from './graph.mjs';
import { loadStateGraphPolicy } from './policy.mjs';
import { KernelPostgresSaver } from './postgres-checkpointer.mjs';
import { createKernelPool, resolveKernelConfig } from '../control-kernel/pool.mjs';
import { createKernel } from '../control-kernel/kernel.mjs';
import { withWorkflowLock } from './workflow-lock.mjs';
import { createCompactManagerContext } from './manager-context.mjs';
import { createGitWorktreeManager } from './git-worktree.mjs';

const offlineCheckpointers = new Map();

class RuntimeMemorySaver extends MemorySaver {
  async threadIds() {
    return Object.keys(this.storage).map((thread_id) => ({ thread_id, updated_at: null }));
  }
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
  pool: poolInput = null, kernel: kernelInput = null, checkpointer: checkpointerInput = null,
  dispatcher = null, worktrees: worktreesInput = null, policy = null, clock = () => new Date(), skipAuthority = false,
  runtimeCapability = null, humanCapability = null } = {}) {
  const projectRoot = resolve(projectRootInput);
  const offlineMemory = Boolean(databasePath);
  if (database) throw Object.assign(new Error('database injection was removed; pass pool/checkpointer instead'), { code: 'SQLITE_RUNTIME_REMOVED' });
  const kernelConfig = offlineMemory ? null : resolveKernelConfig({ projectRoot });
  if (!offlineMemory && !poolInput && !kernelConfig.url) {
    throw Object.assign(new Error('OPENCLAW_PG_URL is required for StateGraph runtime'), { code: 'KERNEL_PG_URL_MISSING' });
  }
  const connection = null;
  const ownPool = !offlineMemory && !poolInput;
  const pool = offlineMemory ? null : (poolInput ?? createKernelPool({
    url: kernelConfig.url,
    max: kernelConfig.max,
    statementTimeoutMs: kernelConfig.statementTimeoutMs,
    connectTimeoutMs: kernelConfig.connectTimeoutMs,
    kernelSchema: kernelConfig.kernelSchema,
  }));
  const selectedPolicy = policy ?? loadStateGraphPolicy(projectRoot);
  let checkpointer = checkpointerInput;
  if (!checkpointer && offlineMemory) {
    checkpointer = offlineCheckpointers.get(databasePath) ?? new RuntimeMemorySaver();
    offlineCheckpointers.set(databasePath, checkpointer);
  }
  checkpointer ??= new KernelPostgresSaver(pool, { schema: 'langgraph' });
  const ready = offlineMemory || checkpointerInput ? Promise.resolve() : checkpointer.setup();
  const kernel = offlineMemory ? null : (kernelInput ?? createKernel({
    pool,
    clock,
    workerId: kernelConfig?.workerId,
    leaseSeconds: selectedPolicy.lease_seconds,
  }));
  const worktrees = worktreesInput ?? createGitWorktreeManager({ projectRoot });
  const selectedDispatcher = dispatcher ?? createForcedDispatcher({ projectRoot, policy: selectedPolicy, clock, worktrees });
  const graph = buildWorkflowGraph({ projectRoot, policy: selectedPolicy, dispatcher: selectedDispatcher, worktrees, clock, sha256, kernel }, { checkpointer });
  const config = (workflowId) => ({ configurable: { thread_id: workflowId, checkpoint_ns: '' }, recursionLimit: selectedPolicy.recursion_limit ?? 20 });

  async function state(workflowId) {
    await ready;
    const snapshot = await graph.getState(config(workflowId));
    return snapshot?.values?.createdAt ? snapshot.values : null;
  }

  async function list() {
    await ready;
    const values = [];
    let rows;
    if (kernel) {
      try {
        rows = await kernel.listRuns({ limit: 200 });
      } catch (error) {
        // Kernel 不可达时仍尝试读取 Checkpoint 投影，供 Monitor 保持只读可用。
        rows = await checkpointer.threadIds();
        rows = rows.map((row) => ({ workflowId: row.thread_id, kernelDegraded: error }));
      }
    } else rows = await checkpointer.threadIds();
    for (const row of rows) {
      const item = await state(kernel ? row.workflowId : row.thread_id);
      if (item) values.push(kernel ? { ...item, __kernelRun: row } : item);
    }
    return values;
  }

  async function invoke(workflowId, input, authorityKind = 'runtime') {
    await ready;
    if (!skipAuthority) assertAuthority(projectRoot, authorityKind, authorityKind === 'human' ? humanCapability : runtimeCapability);
    return withWorkflowLock(projectRoot, workflowId, async () => {
      const value = await graph.invoke(input, config(workflowId));
      return { ...publicResult(value), state: value };
    });
  }

  return {
    projectRoot,
    database: connection,
    pool,
    kernel,
    ready,
    checkpointer,
    graph,
    policy: selectedPolicy,
    async bootstrap({ workflowId, request }) {
      if (await state(workflowId)) throw Object.assign(new Error(`workflow already exists: ${workflowId}`), { code: 'WORKFLOW_ALREADY_EXISTS' });
      return invoke(workflowId, { workflowId, request }, 'runtime');
    },
    async bootstrapConfirmed({ workflowId, request, routePlan }) {
      if (await state(workflowId)) throw Object.assign(new Error(`workflow already exists: ${workflowId}`), { code: 'WORKFLOW_ALREADY_EXISTS' });
      return invoke(workflowId, { workflowId, request, confirmedRoutePlan: routePlan }, 'runtime');
    },
    async run(workflowId) {
      if (!await state(workflowId)) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return invoke(workflowId, { workflowId }, 'runtime');
    },
    async approve(workflowId, command) {
      if (!await state(workflowId)) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return invoke(workflowId, { workflowId, operatorCommand: command }, 'human');
    },
    async revise(workflowId, command) {
      const current = await state(workflowId);
      if (!current) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      if (current.activeTaskId || current.pendingApproval) throw Object.assign(new Error('workflow route can change only between completed stages'), { code: 'WORKFLOW_ROUTE_CHANGE_BUSY' });
      return invoke(workflowId, { workflowId, routeChangeCommand: command }, 'runtime');
    },
    state,
    list,
    async audit(workflowId = null) {
      const values = workflowId ? [await state(workflowId)].filter(Boolean) : await list();
      const workflows = values.map(auditEventChain);
      const kernelChains = [];
      if (kernel) {
        for (const value of values) {
          const run = await kernel.getRunByThreadId(value.workflowId);
          if (run) kernelChains.push(await kernel.auditEvents(run.runId));
        }
      }
      return {
        ok: workflows.every((item) => item.ok) && kernelChains.every((item) => item.ok),
        database: 'LANGGRAPH_CHECKPOINTS',
        workflows,
        kernel_chains: kernelChains,
      };
    },
    async managerContext(workflowId) {
      const value = await state(workflowId);
      if (!value) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      return createCompactManagerContext(value, selectedPolicy);
    },
    async history(workflowId, { limit = 50 } = {}) {
      await ready;
      const values = [];
      if (!await state(workflowId)) throw Object.assign(new Error(`workflow does not exist: ${workflowId}`), { code: 'WORKFLOW_NOT_FOUND' });
      for await (const snapshot of graph.getStateHistory(config(workflowId), { limit })) {
        values.push({
          checkpoint_id: snapshot.config?.configurable?.checkpoint_id ?? null,
          revision: snapshot.values?.revision ?? null,
          phase: snapshot.values?.phase ?? null,
          condition: snapshot.values?.condition ?? null,
          last_action: snapshot.values?.lastAction ?? null,
          next: snapshot.next ?? [],
          created_at: snapshot.createdAt ?? null,
        });
      }
      return values;
    },
    async stateAt(workflowId, checkpointId) {
      await ready;
      if (!checkpointId) throw Object.assign(new Error('checkpoint_id is required'), { code: 'CHECKPOINT_ID_REQUIRED' });
      const snapshot = await graph.getState({ configurable: { thread_id: workflowId, checkpoint_ns: '', checkpoint_id: checkpointId } });
      return snapshot?.values ?? null;
    },
    publicResult,
    async close() {
      if (ownPool) await pool.end();
    },
  };
}
