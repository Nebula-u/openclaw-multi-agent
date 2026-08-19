/**
 * Control Kernel — 门面
 *
 * 将 repository + lease + 事件哈希链（events 表，算法与 StateGraph events.mjs 一致）
 * 组装成 createKernel({ pool, clock, workerId }) 返回的统一 API。
 *
 * 事件链是 Control Kernel 的事实账本：
 *   event_hash = sha256(canonicalJson(body))
 *   body = { event_id, run_id, task_id, execution_id, type, payload, prev_hash, occurred_at }
 * 与 scripts/stategraph/events.mjs 保持算法一致，保证两条链可交叉校验。
 */

import { canonicalJson, sha256 } from '../stategraph/events.mjs';
import { createRepository } from './repository.mjs';
import { createLease } from './lease.mjs';
import {
  newRunId,
  runIdFor,
  threadIdFor,
  executionIdFor,
  artifactIdFor,
  eventIdFor,
} from './ids.mjs';

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.clock  - 可选，返回 now() Date；缺省用 new Date()
 * @param {string} deps.workerId - 本进程 workerId
 * @param {number} [deps.leaseSeconds] - 覆盖 pool 默认租约，默认 120
 */
export function createKernel({ pool, clock = () => new Date(), workerId = `worker-${process.pid}`, leaseSeconds = 120 }) {
  const repository = createRepository(pool);
  const lease = createLease({ pool, scheduleSeconds: leaseSeconds });

  /** 事件链：逐行追加，author 始终为本 kernel。 */
  async function appendEvent({ runId, taskId = null, executionId = null, type, key, change, cause, detail, idempotencyKey = null }) {
    const runIdResolved = runIdFor(runId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 对 run 行加锁，串行化该 run 的事件写入顺序（顺带校验 run 存在）
      const runLock = await client.query(
        'SELECT 1 FROM runs WHERE run_id=$1 FOR UPDATE', [runIdResolved],
      );
      if (runLock.rowCount === 0) {
        throw Object.assign(new Error(`kernel.appendEvent: unknown run ${runIdResolved}`), { code: 'RUN_NOT_FOUND' });
      }

      if (idempotencyKey) {
        const duplicate = await client.query(
          `SELECT event_id, run_id, task_id, execution_id, type, payload, prev_hash, event_hash, occurred_at
             FROM events
            WHERE run_id=$1 AND payload->'detail'->>'stategraph_event_hash'=$2
            LIMIT 1`,
          [runIdResolved, idempotencyKey],
        );
        if (duplicate.rowCount) {
          await client.query('COMMIT');
          return duplicate.rows[0];
        }
      }

      // 取上一事件哈希（尾查询）
      const tail = await client.query(
        'SELECT event_hash FROM events WHERE run_id=$1 ORDER BY event_seq DESC LIMIT 1',
        [runIdResolved],
      );
      const prevHash = tail.rowCount === 0 ? null : tail.rows[0].event_hash;

      const eventId = eventIdFor(runIdResolved);
      // JSONB 会丢弃 undefined；哈希前也必须构造同样的对象，否则审计重放
      // 时数据库读回的 payload 与写入前的 payload 不同。
      const occurredAtValue = clock();
      const occurredAt = occurredAtValue instanceof Date
        ? occurredAtValue.toISOString()
        : occurredAtValue;
      const payload = { key, change };
      if (cause !== undefined) payload.cause = cause;
      if (detail !== undefined) payload.detail = detail;
      // event_id / sha（64 hex）在 schema 有 CHECK 约束
      const body = {
        event_id: eventId,
        run_id: runIdResolved,
        task_id: taskId,
        execution_id: executionId,
        type,
        payload,
        prev_hash: prevHash,
        occurred_at: occurredAt,
      };
      const eventHash = sha256(canonicalJson(body));

      await client.query(
        `INSERT INTO events (event_id, run_id, task_id, execution_id, type, payload, prev_hash, event_hash, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [eventId, runIdResolved, taskId, executionId, type, JSON.stringify(payload), prevHash, eventHash, occurredAt],
      );
      await client.query('COMMIT');

      return {
        event_id: eventId,
        run_id: runIdResolved,
        task_id: taskId,
        execution_id: executionId,
        type,
        payload,
        prev_hash: prevHash,
        event_hash: eventHash,
        occurred_at: occurredAt,
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* 连接已断 */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /** 审计：重放整条链，重算每行哈希，找出断链点。 */
  async function auditEvents(runId) {
    const runIdResolved = runIdFor(runId);
    const { rows } = await pool.query(
      'SELECT * FROM events WHERE run_id=$1 ORDER BY event_seq ASC', [runIdResolved],
    );
    const broken = [];
    let prevFromChain = null;
    rows.forEach((row) => {
      const body = {
        event_id: row.event_id,
        run_id: row.run_id,
        task_id: row.task_id,
        execution_id: row.execution_id,
        type: row.type,
        payload: row.payload,
        prev_hash: row.prev_hash,
        occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
      };
      const recomputed = sha256(canonicalJson(body));
      if (recomputed !== row.event_hash) {
        broken.push({ event_seq: Number(row.event_seq), event_id: row.event_id, reason: 'hash_mismatch' });
      }
      if (row.prev_hash !== prevFromChain) {
        broken.push({ event_seq: Number(row.event_seq), event_id: row.event_id, reason: 'chain_break', expected_prev: prevFromChain });
      }
      prevFromChain = row.event_hash;
    });
    return {
      ok: broken.length === 0,
      run_id: runIdResolved,
      count: rows.length,
      broken,
    };
  }

  return {
    id: 'control-kernel',
    workerId,
    service: 'kernel',

    // 标识符
    ids: { newRunId, runIdFor, threadIdFor, executionIdFor, artifactIdFor, eventIdFor },

    // 仓储（纯 CRUD，含列映射）
    repository,

    // 租约 / 心跳 / reap
    lease,

    // 事件链
    appendEvent,
    auditEvents,

    // 只读投影查询
    getRun: repository.getRun,
    getRunByThreadId: repository.getRunByThreadId,
    listRuns: repository.listRuns,
    projectRuns: repository.projectRuns,
    getTask: repository.getTask,
    listTasks: repository.listTasks,
    getExecution: repository.getExecution,
    listExecutions: repository.listExecutions,
    listArtifacts: repository.listArtifacts,
  };
}

export { newRunId, runIdFor, threadIdFor, executionIdFor, artifactIdFor, eventIdFor };
