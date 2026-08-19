/**
 * Control Kernel — 事件哈希链（kernel.mjs appendEvent / auditEvents）测试
 *
 * 前置条件：OPENCLAW_PG_URL 可达；否则整个文件 skip（suite 级 describe skip）。
 * 隔离：每次运行创建独立临时 schema，结束后 DROP CASCADE。
 *
 * 事件链是 Kernel 的事实账本，这里锁死四件事：
 *  1. 首事件 prev_hash 为 null，后续每条 prev_hash 严格等于前一条 event_hash；
 *  2. event_hash = sha256(canonicalJson(body))，与 runtime-core/hash-chain.mjs 同算法；
 *  3. auditEvents 能重放并检出被篡改的行（hash_mismatch / chain_break）；
 *  4. 未知 run 追加事件被拒（RUN_NOT_FOUND），且事务回滚不留残行。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  skipReason, schemaSqlWith, dropSchema,
  tempSchemaName, createTestPool, kernelUrl,
} from './helpers/kernel-fixture.mjs';
import { createKernel } from '../scripts/control-kernel/kernel.mjs';
import { createKernelPool } from '../scripts/control-kernel/pool.mjs';
import { canonicalJson, sha256 } from '../scripts/runtime-core/hash-chain.mjs';

describe('control-kernel events', { skip: skipReason() }, () => {
  let pool;
  let kernel;
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
    // 这里刻意走生产连接池实现，验证 search_path 启动参数而非测试 fixture。
    pool = createKernelPool({ url: kernelUrl(), max: 6, kernelSchema: schema });
    kernel = createKernel({ pool, workerId: 'worker-events-test' });
  });

  after(async () => {
    if (pool) {
      try { await dropSchema(pool, schema); } catch { /* ignore */ }
      await pool.end();
    }
  });

  /** 种子：一个 run（events.run_id 外键指向 runs）。 */
  async function seedRun() {
    return kernel.repository.upsertRun({
      workflowId: `WF-${crypto.randomUUID().slice(0, 8)}`,
      state: 'ACTIVE',
      request: { prompt: 'events test' },
      requestSha256: 'b'.repeat(64),
      targetProjectRootAbs: '/tmp/project',
      baseCommit: 'abc123',
    });
  }

  /** 串行追加一串事件（事件链靠 run 行 FOR UPDATE 串行化，顺序即写入顺序）。 */
  async function appendChain(runId, types) {
    const chain = [];
    for (const type of types) {
      // eslint-disable-next-line no-await-in-loop
      chain.push(await kernel.appendEvent({ runId, type, key: 'k', change: type }));
    }
    return chain;
  }

  it('首条事件 prev_hash 为 null，event_id 带 run 短签', async () => {
    const run = await seedRun();
    const event = await kernel.appendEvent({
      runId: run.runId,
      type: 'RUN_CREATED',
      key: 'run.state',
      change: 'ACTIVE',
      cause: 'test',
      detail: null,
    });
    assert.equal(event.prev_hash, null);
    assert.equal(event.run_id, run.runId);
    assert.equal(event.type, 'RUN_CREATED');
    assert.ok(event.event_id.startsWith(`EVT-${run.runId.slice(4)}-`));
    assert.match(event.event_hash, /^[0-9a-f]{64}$/u);
  });

  it('event_hash = sha256(canonicalJson(body))，算法与 StateGraph 一致', async () => {
    const run = await seedRun();
    const event = await kernel.appendEvent({
      runId: run.runId,
      taskId: null,
      executionId: null,
      type: 'TASK_DISPATCHED',
      key: 'task.state',
      change: 'DISPATCHED',
      cause: 'scheduler',
      detail: { note: 'hash check' },
    });
    const recomputed = sha256(canonicalJson({
      event_id: event.event_id,
      run_id: event.run_id,
      task_id: event.task_id,
      execution_id: event.execution_id,
      type: event.type,
      payload: event.payload,
      prev_hash: event.prev_hash,
      occurred_at: event.occurred_at,
    }));
    assert.equal(recomputed, event.event_hash);
  });

  it('连续追加：每条 prev_hash 严格等于前一条 event_hash，auditEvents 通过', async () => {
    const run = await seedRun();
    const types = ['RUN_CREATED', 'TASK_CREATED', 'TASK_DISPATCHED', 'TASK_SUCCEEDED', 'RUN_COMPLETED'];
    const chain = await appendChain(run.runId, types);

    assert.equal(chain[0].prev_hash, null);
    for (let i = 1; i < chain.length; i += 1) {
      assert.equal(chain[i].prev_hash, chain[i - 1].event_hash, `第 ${i} 条断链`);
    }

    const audit = await kernel.auditEvents(run.runId);
    assert.equal(audit.ok, true, JSON.stringify(audit.broken));
    assert.equal(audit.count, types.length);
    assert.equal(audit.run_id, run.runId);
    assert.deepEqual(audit.broken, []);
  });

  it('事件链按 run 隔离：两个 run 各自从 null 起链，互不串味', async () => {
    const runA = await seedRun();
    const runB = await seedRun();

    const a1 = await kernel.appendEvent({ runId: runA.runId, type: 'RUN_CREATED', key: 'k', change: 'A1' });
    const b1 = await kernel.appendEvent({ runId: runB.runId, type: 'RUN_CREATED', key: 'k', change: 'B1' });
    const a2 = await kernel.appendEvent({ runId: runA.runId, type: 'TASK_CREATED', key: 'k', change: 'A2' });

    assert.equal(a1.prev_hash, null);
    assert.equal(b1.prev_hash, null, 'B 链不应接到 A 链尾部');
    assert.equal(a2.prev_hash, a1.event_hash, 'A 链应接自己的尾部而非 B 的');

    assert.equal((await kernel.auditEvents(runA.runId)).count, 2);
    assert.equal((await kernel.auditEvents(runB.runId)).count, 1);
  });

  it('auditEvents 检出被篡改的 payload → hash_mismatch', async () => {
    const run = await seedRun();
    const chain = await appendChain(run.runId, ['RUN_CREATED', 'TASK_CREATED', 'TASK_SUCCEEDED']);
    const victim = chain[1];

    // 绕过 Kernel 直接改库，模拟越权写入：改 payload 但不重算 event_hash。
    await pool.query(
      `UPDATE events SET payload = $2 WHERE event_id = $1`,
      [victim.event_id, JSON.stringify({ key: 'k', change: 'TAMPERED', cause: null, detail: null })],
    );

    const audit = await kernel.auditEvents(run.runId);
    assert.equal(audit.ok, false, '被篡改的链不应通过审计');
    const mismatch = audit.broken.find((b) => b.event_id === victim.event_id && b.reason === 'hash_mismatch');
    assert.ok(mismatch, `应检出 hash_mismatch，实得 ${JSON.stringify(audit.broken)}`);
  });

  it('auditEvents 检出被删除的中间事件 → chain_break', async () => {
    const run = await seedRun();
    const chain = await appendChain(run.runId, ['RUN_CREATED', 'TASK_CREATED', 'TASK_SUCCEEDED']);

    // 删掉中间一条：剩余行自身哈希仍正确，但 prev_hash 指向已消失的事件。
    await pool.query('DELETE FROM events WHERE event_id = $1', [chain[1].event_id]);

    const audit = await kernel.auditEvents(run.runId);
    assert.equal(audit.ok, false, '缺环的链不应通过审计');
    const broken = audit.broken.find((b) => b.event_id === chain[2].event_id && b.reason === 'chain_break');
    assert.ok(broken, `应检出 chain_break，实得 ${JSON.stringify(audit.broken)}`);
    assert.equal(broken.expected_prev, chain[0].event_hash);
  });

  it('未知 run 追加事件 → RUN_NOT_FOUND，且不留残行', async () => {
    const ghost = 'RUN-deadbeefcafe';
    await assert.rejects(
      () => kernel.appendEvent({ runId: ghost, type: 'RUN_CREATED', key: 'k', change: 'x' }),
      (err) => {
        assert.equal(err.code, 'RUN_NOT_FOUND');
        return true;
      },
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM events WHERE run_id = $1', [ghost]);
    assert.equal(rows[0].n, 0, '失败事务必须回滚，不得留下事件行');
  });

  it('非法 run_id 形态在进 SQL 前就被拒', async () => {
    await assert.rejects(
      () => kernel.appendEvent({ runId: 'WF-not-a-run-id', type: 'RUN_CREATED', key: 'k', change: 'x' }),
      TypeError,
    );
    await assert.rejects(() => kernel.auditEvents(''), TypeError);
  });

  it('事件可挂到 task / execution 上，字段原样落库', async () => {
    const run = await seedRun();
    const task = await kernel.repository.upsertTask({
      taskId: `TSK-${crypto.randomUUID().slice(0, 8)}`,
      runId: run.runId,
      kind: 'CODE',
      stepId: 'step-1',
      title: 'Events test task',
      agentId: 'developer-agent',
      state: 'DISPATCHED',
      taskGroupId: `TSK-${crypto.randomUUID().slice(0, 8)}`,
    });
    const executionId = kernel.ids.executionIdFor(run.runId, { attempt: 1, cycle: 0 });

    const event = await kernel.appendEvent({
      runId: run.runId,
      taskId: task.taskId,
      executionId,
      type: 'EXECUTION_LEASED',
      key: 'execution.state',
      change: 'LEASED',
      cause: 'lease.acquireLease',
      detail: { workerId: 'worker-events-test' },
    });

    assert.equal(event.task_id, task.taskId);
    assert.equal(event.execution_id, executionId);
    assert.deepEqual(event.payload, {
      key: 'execution.state',
      change: 'LEASED',
      cause: 'lease.acquireLease',
      detail: { workerId: 'worker-events-test' },
    });

    const { rows } = await pool.query(
      'SELECT task_id, execution_id, payload FROM events WHERE event_id = $1',
      [event.event_id],
    );
    assert.equal(rows[0].task_id, task.taskId);
    assert.equal(rows[0].execution_id, executionId);
    assert.equal(rows[0].payload.change, 'LEASED');

    assert.equal((await kernel.auditEvents(run.runId)).ok, true);
  });

  it('同一 run 并发追加 10 条事件仍保持单链无分叉', async () => {
    const run = await seedRun();
    const events = await Promise.all(Array.from({ length: 10 }, (_, i) => kernel.appendEvent({
      runId: run.runId,
      type: 'TASK_PROGRESS',
      key: 'progress.index',
      change: i,
    })));
    assert.equal(new Set(events.map((event) => event.event_id)).size, 10);
    const audit = await kernel.auditEvents(run.runId);
    assert.equal(audit.ok, true, JSON.stringify(audit.broken));
    assert.equal(audit.count, 10);
  });
});
