/**
 * Control Kernel — 执行租约与心跳
 *
 * 单个任务同一时刻最多一个活跃执行（LEASED/RUNNING）。
 * 仲裁通过部分唯一索引 executions_active_lease 上的 INSERT .. ON CONFLICT DO NOTHING
 * 实现，天然原子，无需 Redis、无需应用层互斥。
 *
 * 租约语义：
 *  - acquireLease：抢到 → 返回 execution；没抢到（冲突）→ 抛 { code:'LEASE_HELD', ... }。
 *  - activeExecution：只读探测某任务当前的活跃执行（非并发闸门，仅供调度器预检/重启认领）。
 *  - heartbeat：刷新租约到期时间；返回 0 行 = 租约已被回收，调用方（Harness）必须自杀。
 *  - releaseLease：正常结束并落终态。
 *  - reapExpiredLeases：回收过期未续约的执行 → state='LEASE_EXPIRED'。
 */

const EXEC_RETURN = `execution_id, task_id, run_id, attempt, cycle, worker_id,
  state, phase, agent_id, session_id, pid, worktree_path_abs,
  artifact_root_abs, lease_expires_at, heartbeat_at, started_at, finished_at,
  exit_code, error, sandbox_attestation`;

function mapExecution(row) {
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
    error: row.error === null ? undefined : row.error,
    sandboxAttestation: row.sandbox_attestation === null ? undefined : row.sandbox_attestation,
  };
}

export function createLease({ pool, scheduleSeconds = 120 }) {
  // schema：与 pool.mjs 一致，表位于 kernel schema（经 search_path）。
  // 以下 SQL 不加 schema 前缀，依赖 pool 连接上设好的 search_path。
  if (!scheduleSeconds || typeof scheduleSeconds !== 'number' || scheduleSeconds <= 0) {
    throw new Error(`lease.createLease: invalid scheduleSeconds ${scheduleSeconds}`);
  }

  /** 读某任务当前的活跃执行（LEASED/RUNNING），无则 null。 */
  async function readActiveExecution(taskId) {
    const { rows } = await pool.query(
      `SELECT ${EXEC_RETURN}
         FROM executions
        WHERE task_id = $1 AND state IN ('LEASED','RUNNING')
        ORDER BY started_at ASC
        LIMIT 1`,
      [taskId],
    );
    return rows.length === 0 ? null : mapExecution(rows[0]);
  }

  return {
    id: 'kernel-lease',
    scheduleSeconds,

    /**
     * 尝试为 taskId 抢租约。
     * 成功 → 返回 execution（含新的 lease_expires_at）。
     * 冲突（task 已有 LEASED/RUNNING 活跃执行）→ 抛 LEASE_HELD。
     */
    async acquireLease(executionFields) {
      const {
        executionId, taskId, runId, attempt, cycle,
        workerId, sessionId, pid, worktreePathAbs, artifactRootAbs,
        phase = null, agentId = 'unknown-agent',
      } = executionFields;
      const sql = `
        INSERT INTO executions (
          execution_id, task_id, run_id, attempt, cycle, worker_id,
          state, phase, agent_id, session_id, pid,
          worktree_path_abs, artifact_root_abs, lease_expires_at, heartbeat_at, started_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,'LEASED',$7,$8,$9,$10,$11,$12, now() + make_interval(secs => ${scheduleSeconds}), now(), now())
        ON CONFLICT DO NOTHING
        RETURNING ${EXEC_RETURN}
      `;
      const { rows } = await pool.query(sql, [
        executionId, taskId, runId, attempt, cycle, workerId,
        phase, agentId, sessionId, pid, worktreePathAbs, artifactRootAbs,
      ]);
      if (rows.length === 0) {
        // 该任务已有一个活跃执行。取现有者信息抛出 LEASE_HELD。
        const holder = await readActiveExecution(taskId);
        throw {
          code: 'LEASE_HELD',
          details: {
            active_execution_id: holder ? holder.executionId : null,
            worker_id: holder ? holder.workerId : null,
          },
        };
      }
      return mapExecution(rows[0]);
    },

    /**
     * 刷新租约。0 行 = 租约已被回收 → 返回 null，调用方必须自杀。
     * 可选 phase 推进（COALESCE 语义：非 NULL 才覆盖）。
     */
    async heartbeat({ executionId, phase = null, seconds = scheduleSeconds }) {
      const { rows } = await pool.query(
        `UPDATE executions
            SET heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $2),
                state = 'RUNNING',
                phase = COALESCE($3, phase)
          WHERE execution_id = $1 AND state IN ('LEASED','RUNNING')
          RETURNING ${EXEC_RETURN}`,
        [executionId, seconds, phase],
      );
      return rows.length === 0 ? null : mapExecution(rows[0]);
    },

    /**
     * 正常结束并落终态。执行已被回收（state 不在 LEASED/RUNNING）→ 返回 null。
     */
    async releaseLease({ executionId, state = 'SUCCEEDED', exitCode = 0, error = null }) {
      const { rows } = await pool.query(
        `UPDATE executions
            SET state = $2,
                exit_code = $3,
                error = $4,
                finished_at = now(),
                lease_expires_at = now()
          WHERE execution_id = $1 AND state IN ('LEASED','RUNNING')
          RETURNING ${EXEC_RETURN}`,
        [executionId, state, exitCode, error === null ? null : JSON.stringify(error)],
      );
      return rows.length === 0 ? null : mapExecution(rows[0]);
    },

    /**
     * 查询某任务当前的活跃执行（LEASED/RUNNING），没有则返回 null。
     *
     * 与 acquireLease 的冲突分支查的是同一批行，但这里是只读探测：
     * 调度器在派发前先问一次，可以避免"明知被占还去 INSERT 撞索引"的无谓写入，
     * 也让 Harness 重启后能认领自己遗留的执行（比对 worker_id）。
     *
     * 注意：这不是并发闸门。真正的互斥永远由 executions_active_lease
     * 部分唯一索引在 acquireLease 里保证；本方法读到的结果在返回瞬间就可能过期。
     */
    async activeExecution(taskId) {
      if (typeof taskId !== 'string' || taskId.length === 0) {
        throw new TypeError(`lease.activeExecution: taskId must be a non-empty string, got ${String(taskId)}`);
      }
      return readActiveExecution(taskId);
    },

    /**
     * 回收到期租约。返回被回收的执行数组（供上层载入错误详情）。
     */
    async reapExpiredLeases() {
      const { rows } = await pool.query(
        `UPDATE executions
            SET state = 'LEASE_EXPIRED',
                finished_at = now(),
                error = jsonb_build_object(
                  'code','EXECUTION_LEASE_EXPIRED',
                  'message','execution lease expired without heartbeat renewal',
                  'last_heartbeat_at', to_jsonb(heartbeat_at)
                )
          WHERE state IN ('LEASED','RUNNING') AND lease_expires_at < now()
          RETURNING ${EXEC_RETURN}`,
      );
      return rows.map(mapExecution);
    },
  };
}
