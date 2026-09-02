function encode(value) { return value === null || value === undefined ? null : JSON.stringify(value); }
function decode(value) { return value === null || value === undefined ? undefined : typeof value === 'string' ? JSON.parse(value) : value; }
function iso(value) { return (value instanceof Date ? value : new Date(value)).toISOString(); }

function mapExecution(row) {
  if (!row) return null;
  return { executionId: row.execution_id, taskId: row.task_id, runId: row.run_id, attempt: row.attempt,
    cycle: row.cycle, workerId: row.worker_id, state: row.state, phase: row.phase, agentId: row.agent_id,
    sessionId: row.session_id, pid: row.pid, worktreePathAbs: row.worktree_path_abs,
    artifactRootAbs: row.artifact_root_abs, leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at, startedAt: row.started_at, finishedAt: row.finished_at,
    exitCode: row.exit_code, error: decode(row.error), sandboxAttestation: decode(row.sandbox_attestation) };
}

export function createLease({ database, scheduleSeconds = 120, clock = () => new Date() }) {
  if (!database) throw new TypeError('database is required');
  if (!Number.isFinite(scheduleSeconds) || scheduleSeconds <= 0) throw new Error(`lease.createLease: invalid scheduleSeconds ${scheduleSeconds}`);
  const now = () => iso(clock());
  const expires = (seconds = scheduleSeconds) => new Date(new Date(now()).valueOf() + seconds * 1000).toISOString();
  const read = (executionId) => mapExecution(database.get('SELECT * FROM executions WHERE execution_id=?', [executionId]));
  const active = (taskId) => mapExecution(database.get("SELECT * FROM executions WHERE task_id=? AND state IN ('LEASED','RUNNING') ORDER BY started_at ASC LIMIT 1", [taskId]));

  return {
    id: 'kernel-lease', scheduleSeconds,
    async acquireLease(fields) {
      const timestamp = now();
      const result = database.run(`INSERT OR IGNORE INTO executions (execution_id,task_id,run_id,attempt,cycle,worker_id,state,phase,agent_id,
        session_id,pid,worktree_path_abs,artifact_root_abs,lease_expires_at,heartbeat_at,started_at) VALUES (?,?,?,?,?,?,'LEASED',?,?,?,?,?,?,?,?,?)`,
      [fields.executionId, fields.taskId, fields.runId, fields.attempt, fields.cycle ?? 0, fields.workerId,
        fields.phase ?? null, fields.agentId ?? 'unknown-agent', fields.sessionId ?? null, fields.pid ?? null,
        fields.worktreePathAbs ?? null, fields.artifactRootAbs ?? null, expires(), timestamp, timestamp]);
      if (!result.changes) {
        const holder = active(fields.taskId);
        throw Object.assign(new Error('task already has an active execution lease'), { code: 'LEASE_HELD', details: {
          active_execution_id: holder?.executionId ?? null, worker_id: holder?.workerId ?? null,
        } });
      }
      return read(fields.executionId);
    },
    async heartbeat({ executionId, phase = null, seconds = scheduleSeconds }) {
      const timestamp = now();
      const deadline = new Date(new Date(timestamp).valueOf() + seconds * 1000).toISOString();
      const result = database.run(`UPDATE executions SET heartbeat_at=?,lease_expires_at=?,state='RUNNING',phase=COALESCE(?,phase)
        WHERE execution_id=? AND state IN ('LEASED','RUNNING') AND lease_expires_at>=?`,
      [timestamp, deadline, phase, executionId, timestamp]);
      return result.changes ? read(executionId) : null;
    },
    async releaseLease({ executionId, state = 'SUCCEEDED', exitCode = 0, error = null }) {
      const timestamp = now();
      const result = database.run(`UPDATE executions SET state=?,exit_code=?,error=?,finished_at=?,lease_expires_at=?
        WHERE execution_id=? AND state IN ('LEASED','RUNNING')`, [state, exitCode, encode(error), timestamp, timestamp, executionId]);
      return result.changes ? read(executionId) : null;
    },
    async activeExecution(taskId) {
      if (typeof taskId !== 'string' || !taskId) throw new TypeError(`lease.activeExecution: taskId must be a non-empty string, got ${String(taskId)}`);
      return active(taskId);
    },
    async reapExpiredLeases() {
      const timestamp = now();
      const rows = database.transaction(() => {
        const expired = database.all("SELECT * FROM executions WHERE state IN ('LEASED','RUNNING') AND lease_expires_at < ?", [timestamp]);
        const reaped = [];
        for (const row of expired) {
          const error = { code: 'EXECUTION_LEASE_EXPIRED', message: 'execution lease expired without heartbeat renewal', last_heartbeat_at: row.heartbeat_at };
          const result = database.run(`UPDATE executions SET state='LEASE_EXPIRED',finished_at=?,error=?
            WHERE execution_id=? AND state IN ('LEASED','RUNNING') AND lease_expires_at < ?`,
          [timestamp, encode(error), row.execution_id, timestamp]);
          if (!result.changes) continue;
          database.run("UPDATE tasks SET state='FAILED',last_error=?,updated_at=? WHERE task_id=? AND state='RUNNING'",
            [encode(error), timestamp, row.task_id]);
          reaped.push(row);
        }
        return reaped;
      });
      return rows.map((row) => read(row.execution_id));
    },
  };
}

export { mapExecution };
