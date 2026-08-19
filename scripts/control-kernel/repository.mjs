/**
 * Control Kernel — 仓储层
 *
 * 五个事实表的纯 SQL CRUD（runs / tasks / executions / artifacts / events），
 * 全部使用参数化占位符 $n，列名↔JS 字段映射在此层内部完成。
 *
 * PG 列名 (snake_case) 是 SSOT；JS 侧只暴露稳定字段名。个别例外：
 *  - runs.langgraph_thread_id   ↔  state.workflowId    （Monitor 既有字段）
 *  - tasks.state               ↔  task.status         （Monitor publicTask.status 冻结）
 *
 * run_id 与 langgraph_thread_id 是两个独立标识（见 ids.mjs 顶部说明）：
 * 前者由 Kernel 生成（RUN-<hex>），后者由 StateGraph 决定（WF-*）。
 * upsertRun 以 run_id 为主键、langgraph_thread_id 唯一；按线程反查用
 * getRunByThreadId()。
 */

import { newRunId, runIdFor, executionIdFor, artifactIdFor } from './ids.mjs';

// JSONB 序列化默认过滤 undefined，避免把 undefined 塞进 JSONB。
const jsonb = (value) => (value === undefined ? null : JSON.stringify(value));

/** 读取行内 JSONB 字段；NULL / 未定义返回 undefined。 */
const jsonbIn = (value) => (value === undefined || value === null ? undefined : value);

// ═══════════════════════════════════════════════════════════════
// runs
// ═══════════════════════════════════════════════════════════════

const RUN_COLS = `run_id, langgraph_thread_id, state, outcome, status_reason,
  request, request_sha256, target_project_root_abs, base_commit,
  candidate_commit, route_hash, created_at, updated_at, completed_at`;

function mapRunOut(row) {
  if (!row) return undefined;
  return {
    runId: row.run_id,
    workflowId: row.langgraph_thread_id,
    status: row.state,               // 直接透传 states，供上层归一化
    state: row.state,
    outcome: row.outcome,
    statusReason: row.status_reason,
    request: row.request,
    requestSha256: row.request_sha256,
    targetProjectRootAbs: row.target_project_root_abs,
    baseCommit: row.base_commit,
    candidateCommit: row.candidate_commit,
    routeHash: row.route_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function upsertRun(pool, fields) {
  // run_id 缺省则新生成；langgraph_thread_id 是必填绑定键。
  const runId = fields.runId ? runIdFor(fields.runId) : newRunId();
  const { rows } = await pool.query(
    `INSERT INTO runs (${RUN_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now(),$12)
     ON CONFLICT (run_id) DO UPDATE SET
       langgraph_thread_id = EXCLUDED.langgraph_thread_id,
       state = EXCLUDED.state,
       outcome = EXCLUDED.outcome,
       status_reason = EXCLUDED.status_reason,
       request = EXCLUDED.request,
       request_sha256 = EXCLUDED.request_sha256,
       target_project_root_abs = EXCLUDED.target_project_root_abs,
       base_commit = EXCLUDED.base_commit,
       candidate_commit = EXCLUDED.candidate_commit,
       route_hash = EXCLUDED.route_hash,
       completed_at = EXCLUDED.completed_at,
       updated_at = now()
     RETURNING *`,
    [
      runId, fields.workflowId, fields.state ?? 'ACTIVE',
      fields.outcome ?? null, fields.statusReason ?? null,
      jsonb(fields.request), fields.requestSha256,
      fields.targetProjectRootAbs, fields.baseCommit,
      fields.candidateCommit ?? null, fields.routeHash ?? null,
      fields.completedAt ?? null,
    ],
  );
  return mapRunOut(rows[0]);
}

async function getRun(pool, runId) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLS} FROM runs WHERE run_id=$1`, [runId],
  );
  return mapRunOut(rows[0]);
}

/**
 * 按 StateGraph 线程标识反查 run。
 * StateGraph 侧只持有 threadId（state.workflowId），Kernel 侧主键是 run_id，
 * 所有从图节点进入 Kernel 的调用都要先经过这里换取 run_id。
 */
async function getRunByThreadId(pool, threadId) {
  const { rows } = await pool.query(
    `SELECT ${RUN_COLS} FROM runs WHERE langgraph_thread_id=$1`, [threadId],
  );
  return mapRunOut(rows[0]);
}

async function listRuns(pool, { limit = 200, states = null } = {}) {
  const clauses = [];
  const params = [];
  if (Array.isArray(states) && states.length > 0) {
    params.push(states);
    clauses.push(`state = ANY($${params.length})`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderParam = params.length + 1;
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${RUN_COLS} FROM runs ${where} ORDER BY updated_at DESC LIMIT $${orderParam}`,
    params,
  );
  return rows.map(mapRunOut);
}

async function setRunState(pool, runId, { state, outcome = undefined, statusReason = undefined,
  completedAt = undefined, routeHash = undefined }) {
  const assignments = ['updated_at = now()'];
  const params = [];
  const bind = (sqlLiteral, value) => {
    if (value === undefined) return;
    params.push(value);
    assignments.push(`${sqlLiteral} = $${params.length}`);
  };
  bind('state', state);
  bind('outcome', outcome);
  bind('status_reason', statusReason);
  bind('completed_at', completedAt);
  bind('route_hash', routeHash);
  params.push(runId);
  const { rows } = await pool.query(
    `UPDATE runs SET ${assignments.join(', ')} WHERE run_id=$${params.length} RETURNING *`,
    params,
  );
  return mapRunOut(rows[0]);
}

// ═══════════════════════════════════════════════════════════════
// tasks
// ═══════════════════════════════════════════════════════════════

const TASK_COLS = `task_id, run_id, kind, step_id, title, agent_id, state,
  attempt, max_attempts, json_regenerations, execution_round, route_hash,
  input_commit, task_group_id, parallel_slot, depends_on, last_error,
  created_at, updated_at`;

function mapTaskOut(row) {
  if (!row) return undefined;
  return {
    taskId: row.task_id,
    runId: row.run_id,
    kind: row.kind,
    stepId: row.step_id,
    title: row.title,
    agentId: row.agent_id,
    status: row.state,                    // Monitor publicTask.status 字段名冻结
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    jsonRegenerations: row.json_regenerations,
    executionRound: row.execution_round,
    routeHash: row.route_hash,
    inputCommit: row.input_commit,
    taskGroupId: row.task_group_id,
    parallelSlot: row.parallel_slot,
    dependsOn: row.depends_on ?? [],
    lastError: jsonbIn(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function upsertTask(pool, fields) {
  const { rows } = await pool.query(
    `INSERT INTO tasks (${TASK_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),now())
     ON CONFLICT (task_id) DO UPDATE SET
       state = EXCLUDED.state,
       attempt = EXCLUDED.attempt,
       last_error = EXCLUDED.last_error,
       updated_at = now()
     RETURNING *`,
    [
      fields.taskId, fields.runId, fields.kind, fields.stepId, fields.title,
      fields.agentId, fields.state ?? 'READY', fields.attempt ?? 1,
      fields.maxAttempts ?? 3, fields.jsonRegenerations ?? 0,
      fields.executionRound ?? 1, fields.routeHash ?? null,
      fields.inputCommit ?? null, fields.taskGroupId ?? fields.taskId,
      fields.parallelSlot ?? 0, fields.dependsOn ?? [],
      jsonb(fields.lastError),
    ],
  );
  return mapTaskOut(rows[0]);
}

async function getTask(pool, taskId) {
  const { rows } = await pool.query(
    `SELECT ${TASK_COLS} FROM tasks WHERE task_id=$1`, [taskId],
  );
  return mapTaskOut(rows[0]);
}

async function listTasks(pool, { runId = null, states = null, limit = 1000 } = {}) {
  const clauses = [];
  const params = [];
  if (runId != null) {
    params.push(runId);
    clauses.push(`run_id = $${params.length}`);
  }
  if (Array.isArray(states) && states.length > 0) {
    params.push(states);
    clauses.push(`state = ANY($${params.length})`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderParam = params.length + 1;
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${TASK_COLS} FROM tasks ${where} ORDER BY created_at ASC LIMIT $${orderParam}`,
    params,
  );
  return rows.map(mapTaskOut);
}

async function setTaskState(pool, taskId, { state, attempt = undefined, lastError = undefined,
  executionRound = undefined, routeHash = undefined }) {
  const assignments = ['updated_at = now()'];
  const params = [];
  const bind = (sqlLiteral, value) => {
    if (value === undefined) return;
    params.push(value);
    assignments.push(`${sqlLiteral} = $${params.length}`);
  };
  bind('state', state);
  bind('attempt', attempt);
  bind('last_error', jsonb(lastError));
  bind('execution_round', executionRound);
  bind('route_hash', routeHash);
  params.push(taskId);
  const { rows } = await pool.query(
    `UPDATE tasks SET ${assignments.join(', ')} WHERE task_id=$${params.length} RETURNING *`,
    params,
  );
  return mapTaskOut(rows[0]);
}

// ═══════════════════════════════════════════════════════════════
// executions  ← 租约 / 心跳 / attempt / cycle 字段走 lease.mjs；
//               此处仅提供只读查询 + 纯 CRUD（reap 为 UPDATE，属 lease 职责）
// ═══════════════════════════════════════════════════════════════

const EXEC_COLS = `execution_id, task_id, run_id, attempt, cycle, worker_id,
  state, phase, agent_id, session_id, pid, worktree_path_abs,
  artifact_root_abs, lease_expires_at, heartbeat_at, started_at, finished_at,
  exit_code, error, sandbox_attestation`;

function mapExecutionOut(row) {
  if (!row) return undefined;
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    runId: row.run_id,
    attempt: row.attempt,
    cycle: row.cycle,
    workerId: row.worker_id,
    state: row.state,
    phase: row.phase,
    agentId: row.agent_id,
    sessionId: row.session_id,
    pid: row.pid,
    worktreePathAbs: row.worktree_path_abs,
    artifactRootAbs: row.artifact_root_abs,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    error: jsonbIn(row.error),
    sandboxAttestation: jsonbIn(row.sandbox_attestation),
  };
}

async function getExecution(pool, executionId) {
  const { rows } = await pool.query(
    `SELECT ${EXEC_COLS} FROM executions WHERE execution_id=$1`, [executionId],
  );
  return mapExecutionOut(rows[0]);
}

async function listExecutions(pool, { taskId = null, runId = null, limit = 1000 } = {}) {
  const clauses = [];
  const params = [];
  if (taskId != null) {
    params.push(taskId);
    clauses.push(`task_id = $${params.length}`);
  }
  if (runId != null) {
    params.push(runId);
    clauses.push(`run_id = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderParam = params.length + 1;
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${EXEC_COLS} FROM executions ${where} ORDER BY started_at DESC LIMIT $${orderParam}`,
    params,
  );
  return rows.map(mapExecutionOut);
}

// ═══════════════════════════════════════════════════════════════
// artifacts  ← CAS 文件写入在 P7；此处只登记索引
// ═══════════════════════════════════════════════════════════════

const ART_COLS = `artifact_id, run_id, task_id, execution_id, kind, uri,
  sha256, size_bytes, media_type, commit_sha, created_at`;

function mapArtifactOut(row) {
  if (!row) return undefined;
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    taskId: row.task_id,
    executionId: row.execution_id,
    kind: row.kind,
    uri: row.uri,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    mediaType: row.media_type,
    commitSha: row.commit_sha,
    createdAt: row.created_at,
  };
}

async function upsertArtifact(pool, fields) {
  const { rows } = await pool.query(
    `INSERT INTO artifacts (${ART_COLS})
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
     ON CONFLICT (artifact_id) DO UPDATE SET
       sha256 = EXCLUDED.sha256, size_bytes = EXCLUDED.size_bytes
     RETURNING *`,
    [
      fields.artifactId, fields.runId, fields.taskId,
      fields.executionId ?? null, fields.kind, fields.uri,
      fields.sha256, fields.sizeBytes ?? 0, fields.mediaType ?? 'application/json',
      fields.commitSha ?? null,
    ],
  );
  return mapArtifactOut(rows[0]);
}

async function listArtifacts(pool, { runId = null, taskId = null, kind = null, limit = 1000 } = {}) {
  const clauses = [];
  const params = [];
  if (runId != null) {
    params.push(runId);
    clauses.push(`run_id = $${params.length}`);
  }
  if (taskId != null) {
    params.push(taskId);
    clauses.push(`task_id = $${params.length}`);
  }
  if (kind != null) {
    params.push(kind);
    clauses.push(`kind = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const orderParam = params.length + 1;
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT ${ART_COLS} FROM artifacts ${where} ORDER BY created_at ASC LIMIT $${orderParam}`,
    params,
  );
  return rows.map(mapArtifactOut);
}

/**
 * Build the Monitor projection from Kernel facts.  The projection is keyed by
 * task id so the checkpoint read model can merge execution/artifact facts
 * without treating Kernel as the workflow decision engine.
 */
async function projectRuns(pool, { limit = 200 } = {}) {
  const runs = await listRuns(pool, { limit });
  return Promise.all(runs.map(async (run) => {
    const [tasks, executions, artifacts] = await Promise.all([
      listTasks(pool, { runId: run.runId, limit: 1000 }),
      listExecutions(pool, { runId: run.runId, limit: 2000 }),
      listArtifacts(pool, { runId: run.runId, limit: 5000 }),
    ]);
    const executionByTask = {};
    for (const execution of executions) {
      // listExecutions is newest-first; preserve the latest fact per task.
      if (executionByTask[execution.taskId]) continue;
      executionByTask[execution.taskId] = {
        ...execution,
        execution_id: execution.executionId,
        worker_id: execution.workerId,
        heartbeat_at: execution.heartbeatAt,
        lease_expires_at: execution.leaseExpiresAt,
      };
    }
    const artifactsByTask = {};
    for (const artifact of artifacts) {
      (artifactsByTask[artifact.taskId] ??= []).push({
        ...artifact,
        artifact_id: artifact.artifactId,
      });
    }
    return {
      ...run,
      run_id: run.runId,
      langgraph_thread_id: run.workflowId,
      tasks,
      executions: executionByTask,
      artifacts: artifactsByTask,
    };
  }));
}

// ═══════════════════════════════════════════════════════════════
// ─── 组装 ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

/**
 * 创建仓储。所有方法已绑定 pool，调用方无需传 pool。
 * 表用裸名，schema 由 createKernelPool() 在每条连接上 SET search_path 指定。
 *
 * @param {import('pg').Pool} pool
 * @returns {object} { id, upsertRun, getRun, getRunByThreadId, listRuns, projectRuns, setRunState,
 *                     upsertTask, getTask, listTasks, setTaskState,
 *                     getExecution, listExecutions,
 *                     upsertArtifact, listArtifacts }
 */
export function createRepository(pool) {
  return {
    id: 'kernel-repository',

    // runs
    upsertRun: (fields) => upsertRun(pool, fields),
    getRun: (runId) => getRun(pool, runId),
    getRunByThreadId: (threadId) => getRunByThreadId(pool, threadId),
    listRuns: (opts) => listRuns(pool, opts),
    projectRuns: (opts) => projectRuns(pool, opts),
    setRunState: (runId, opts) => setRunState(pool, runId, opts),

    // tasks
    upsertTask: (fields) => upsertTask(pool, fields),
    getTask: (taskId) => getTask(pool, taskId),
    listTasks: (opts) => listTasks(pool, opts),
    setTaskState: (taskId, opts) => setTaskState(pool, taskId, opts),

    // executions (只读；租约写操作在 lease.mjs)
    getExecution: (executionId) => getExecution(pool, executionId),
    listExecutions: (opts) => listExecutions(pool, opts),

    // artifacts
    upsertArtifact: (fields) => upsertArtifact(pool, fields),
    listArtifacts: (opts) => listArtifacts(pool, opts),
  };
}

// 复用 ID 生成（供上层直接使用，避免 import 环）
export { newRunId, runIdFor, executionIdFor, artifactIdFor };
