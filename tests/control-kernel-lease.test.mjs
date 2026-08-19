/**
 * Control Kernel — 租约仲裁（lease.mjs）测试
 *
 * 前置条件：OPENCLAW_PG_URL 可达；否则整个文件 skip（suite 级 describe skip）。
 * 隔离：每次运行创建独立临时 schema，结束后 DROP CASCADE。
 * 说明：lease.mjs 使用裸表名，依赖 search_path；测试主池通过 createTestPool
 *       的 searchPath 选项按连接 SET search_path。DDL 用独立无 search_path 池。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  skipReason, schemaSqlWith, dropSchema,
  tempSchemaName, createTestPool, kernelUrl,
} from './helpers/kernel-fixture.mjs';
import { createLease } from '../scripts/control-kernel/lease.mjs';
import { createRepository } from '../scripts/control-kernel/repository.mjs';

describe('control-kernel lease', { skip: skipReason() }, () => {
  let pool;
  let lease;
  let repo;
  let schema;

  before(async () => {
    schema = tempSchemaName();
    // DDL 用独立连接池执行：此时 schema 尚不存在，search_path 指向它会失败。
    const ddl = createTestPool(kernelUrl(), { max: 1 });
    try {
      await ddl.query(schemaSqlWith(schema));
    } finally {
      await ddl.end();
    }
    pool = createTestPool(kernelUrl(), { max: 6, searchPath: schema });
    lease = createLease({ pool, scheduleSeconds: 120 });
    repo = createRepository(pool);
  });

  after(async () => {
    if (pool) {
      try { await dropSchema(pool, schema); } catch { /* ignore */ }
      await pool.end();
    }
  });

  const runId = () => `RUN-${crypto.randomUUID().slice(0, 8)}`;
  const taskId = () => `TSK-${crypto.randomUUID().slice(0, 8)}`;

  // 种子：一个 run + 一个 task（executions.task_id → tasks，executions.run_id → runs）
  async function seedTask() {
    const r = await repo.upsertRun({
      runId: runId(),
      workflowId: `WF-${crypto.randomUUID().slice(0, 8)}`,
      state: 'ACTIVE',
      request: { prompt: 'lease test' },
      requestSha256: 'a'.repeat(64),
      targetProjectRootAbs: '/tmp/project',
      baseCommit: 'abc123',
    });
    const t = await repo.upsertTask({
      taskId: taskId(),
      runId: r.runId,
      kind: 'CODE',
      stepId: 'step-1',
      title: 'Lease test task',
      agentId: 'developer-agent',
      state: 'DISPATCHED',
      taskGroupId: taskId(),
    });
    return { run: r, task: t };
  }

  function execFields(task) {
    return {
      executionId: `EXE-${crypto.randomUUID().slice(0, 8)}`,
      taskId: task.taskId,
      runId: task.runId,
      attempt: 1,
      cycle: 0,
      workerId: `worker-${crypto.randomUUID().slice(0, 8)}`,
      pid: process.pid,
    };
  }

  it('acquireLease 授予 execution，默认 LEASED', async () => {
    const { task } = await seedTask();
    const fields = execFields(task);
    const exe = await lease.acquireLease(fields);
    assert.equal(exe.executionId, fields.executionId);
    assert.equal(exe.taskId, task.taskId);
    assert.equal(exe.state, 'LEASED');
    assert.ok(exe.leaseExpiresAt > exe.startedAt);
    assert.ok(exe.heartbeatAt);
  });

  it('同 task 二次 acquireLease → LEASE_HELD 且带上持有者', async () => {
    const { task } = await seedTask();
    const first = await lease.acquireLease(execFields(task));
    await assert.rejects(
      () => lease.acquireLease(execFields(task)),
      (err) => {
        assert.equal(err.code, 'LEASE_HELD');
        assert.equal(err.details.active_execution_id, first.executionId);
        assert.equal(err.details.worker_id, first.workerId);
        return true;
      },
    );
  });

  it('heartbeat 把 LEASED 推进为 RUNNING', async () => {
    const { task } = await seedTask();
    const exe = await lease.acquireLease(execFields(task));
    assert.equal(exe.state, 'LEASED');
    const hb = await lease.heartbeat({ executionId: exe.executionId });
    assert.equal(hb.state, 'RUNNING');
  });

  it('对已回收（过期）execution heartbeat → null', async () => {
    const { task } = await seedTask();
    // 单开一个短租约实例：先让租约失效
    const shortLeasePool = createTestPool(kernelUrl(), { max: 1, searchPath: schema });
    const short = createLease({ pool: shortLeasePool, scheduleSeconds: 1 });
    try {
      const exe = await short.acquireLease(execFields(task));
      await new Promise((r) => setTimeout(r, 1100)); // 等待 1s 租约过期
      await short.reapExpiredLeases();
      const hb = await short.heartbeat({ executionId: exe.executionId });
      assert.equal(hb, null);
    } finally {
      await shortLeasePool.end();
    }
  });

  it('releaseLease 落终态，之后该 task 可重新 acquire', async () => {
    const { task } = await seedTask();
    const first = await lease.acquireLease(execFields(task));
    const released = await lease.releaseLease({
      executionId: first.executionId,
      state: 'SUCCEEDED',
      exitCode: 0,
    });
    assert.equal(released.state, 'SUCCEEDED');
    assert.equal(released.exitCode, 0);

    // 终态不再占用 active_lease 唯一索引 → 可重新获取
    const second = await lease.acquireLease(execFields(task));
    assert.equal(second.state, 'LEASED');
    assert.notEqual(second.executionId, first.executionId);
  });

  it('reapExpiredLeases 回收过期租约', async () => {
    const { task } = await seedTask();
    const short = createLease({ pool, scheduleSeconds: 1 });
    const exe = await short.acquireLease(execFields(task));
    await new Promise((r) => setTimeout(r, 1100));

    const reaped = await short.reapExpiredLeases();
    const found = reaped.find((e) => e.executionId === exe.executionId);
    assert.ok(found, '过期租约应被回收');
    assert.equal(found.state, 'LEASE_EXPIRED');

    // 回收后释放 active_lease 唯一索引 → 可重新获取
    const again = await lease.acquireLease(execFields(task));
    assert.notEqual(again.executionId, exe.executionId);
  });

  it('不同 task 互不排斥：各自都能拿到自己的租约', async () => {
    // executions_active_lease 是 (task_id) WHERE state IN ('LEASED','RUNNING')，
    // 闸门粒度必须是「每 task 一个」而不是全局一个。
    const a = await seedTask();
    const b = await seedTask();
    assert.notEqual(a.task.taskId, b.task.taskId);

    const exeA = await lease.acquireLease(execFields(a.task));
    const exeB = await lease.acquireLease(execFields(b.task));

    assert.equal(exeA.state, 'LEASED');
    assert.equal(exeB.state, 'LEASED');
    assert.equal(exeA.taskId, a.task.taskId);
    assert.equal(exeB.taskId, b.task.taskId);
    assert.notEqual(exeA.executionId, exeB.executionId);

    // 交叉验证：A 被占不影响 B 继续心跳
    assert.equal((await lease.heartbeat({ executionId: exeB.executionId })).state, 'RUNNING');
    await assert.rejects(
      () => lease.acquireLease(execFields(a.task)),
      (err) => err.code === 'LEASE_HELD',
    );
  });

  it('activeExecution：无活跃执行返回 null，有则返回持有者', async () => {
    const { task } = await seedTask();
    assert.equal(await lease.activeExecution(task.taskId), null);

    const exe = await lease.acquireLease(execFields(task));
    const active = await lease.activeExecution(task.taskId);
    assert.equal(active.executionId, exe.executionId);
    assert.equal(active.workerId, exe.workerId);
    assert.equal(active.state, 'LEASED');

    // heartbeat 推进到 RUNNING 后仍算活跃
    await lease.heartbeat({ executionId: exe.executionId });
    assert.equal((await lease.activeExecution(task.taskId)).state, 'RUNNING');

    // 落终态后不再活跃
    await lease.releaseLease({ executionId: exe.executionId, state: 'SUCCEEDED', exitCode: 0 });
    assert.equal(await lease.activeExecution(task.taskId), null);
  });

  it('activeExecution 拒绝空 taskId', async () => {
    await assert.rejects(() => lease.activeExecution(''), TypeError);
    await assert.rejects(() => lease.activeExecution(null), TypeError);
  });

  it('10 路并发 acquireLease → 恰好 1 成功、9 个 LEASE_HELD', async () => {
    const { task } = await seedTask();
    const attempts = Array.from({ length: 10 }, () =>
      lease.acquireLease(execFields(task)),
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter(
      (r) => r.status === 'rejected' && r.reason?.code === 'LEASE_HELD',
    );
    assert.equal(fulfilled.length, 1, '并发下应只有 1 个成功');
    assert.equal(rejected.length, 9, '其余 9 个应被 LEASE_HELD 拒绝');

    const winner = fulfilled[0].value;
    assert.equal(winner.state, 'LEASED');
    // 所有 LEASE_HELD 都指向同一位持有者
    for (const r of rejected) {
      assert.equal(r.reason.details.active_execution_id, winner.executionId);
    }
  });
});
