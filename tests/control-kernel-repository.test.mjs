/**
 * Control Kernel — 仓储层 CRUD / FK CASCADE / CHECK 约束测试
 *
 * 前置条件：OPENCLAW_PG_URL 可达；否则整个文件 skip（suite 级 describe skip）。
 * 隔离：每次运行创建独立临时 schema，结束后 DROP CASCADE。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  skipReason, schemaSqlWith, dropSchema,
  tempSchemaName, createTestPool, kernelUrl,
} from './helpers/kernel-fixture.mjs';
import { createRepository } from '../scripts/control-kernel/repository.mjs';

describe('control-kernel repository', { skip: skipReason() }, () => {
  let pool;
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
    repo = createRepository(pool);
  });

  after(async () => {
    if (pool) {
      try { await dropSchema(pool, schema); } catch { /* ignore */ }
      await pool.end();
    }
  });

  // ─── fixtures ──────────────────────────────────────────────────────

  function mkRun(overrides = {}) {
    return {
      runId: `RUN-${crypto.randomUUID().slice(0, 8)}`,
      workflowId: `WF-${crypto.randomUUID().slice(0, 8)}`,
      state: 'ACTIVE',
      request: { prompt: 'hello' },
      requestSha256: 'a'.repeat(64),
      targetProjectRootAbs: '/tmp/project',
      baseCommit: 'abc123',
      ...overrides,
    };
  }

  function mkTask(runId, overrides = {}) {
    const taskId = `TSK-${crypto.randomUUID().slice(0, 8)}`;
    return {
      taskId,
      runId,
      kind: 'CODE',
      stepId: 'step-1',
      title: 'Test task',
      agentId: 'developer-agent',
      state: 'READY',
      taskGroupId: taskId,
      ...overrides,
    };
  }

  function mkArtifact(runId, taskId, overrides = {}) {
    return {
      artifactId: `ART-${crypto.randomUUID().slice(0, 8)}`,
      runId,
      taskId,
      kind: 'RESULT',
      uri: 'file:///tmp/output.json',
      sha256: 'b'.repeat(64),
      sizeBytes: 1024,
      mediaType: 'application/json',
      ...overrides,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // runs CRUD
  // ═══════════════════════════════════════════════════════════════

  it('upsertRun + getRun 往返一致', async () => {
    const fields = mkRun();
    const created = await repo.upsertRun(fields);
    assert.equal(created.runId, fields.runId);
    assert.equal(created.state, 'ACTIVE');
    assert.equal(created.workflowId, fields.workflowId);
    assert.equal(created.requestSha256, fields.requestSha256);

    const fetched = await repo.getRun(fields.runId);
    assert.deepEqual(fetched, created);
  });

  it('upsertRun 幂等更新 outcome', async () => {
    const fields = mkRun();
    await repo.upsertRun(fields);
    const updated = await repo.upsertRun({ ...fields, outcome: 'SUCCESS' });
    assert.equal(updated.outcome, 'SUCCESS');
    const fetched = await repo.getRun(fields.runId);
    assert.equal(fetched.outcome, 'SUCCESS');
  });

  it('未指定 runId 时生成独立 RUN-* 主键，并可按 threadId 反查', async () => {
    const fields = mkRun();
    delete fields.runId;
    const created = await repo.upsertRun(fields);
    assert.match(created.runId, /^RUN-[0-9a-f]{12}$/u);
    assert.equal(created.workflowId, fields.workflowId);
    assert.deepEqual(await repo.getRunByThreadId(fields.workflowId), created);
  });

  it('setRunState 可推进终态', async () => {
    const fields = mkRun();
    await repo.upsertRun(fields);
    const result = await repo.setRunState(fields.runId, {
      state: 'TERMINAL',
      outcome: 'SUCCESS',
      completedAt: new Date(),
    });
    assert.equal(result.state, 'TERMINAL');
    assert.equal(result.outcome, 'SUCCESS');
    assert.ok(result.completedAt);
  });

  it('listRuns 默认返回所有', async () => {
    const r1 = mkRun();
    const r2 = mkRun();
    await repo.upsertRun(r1);
    await repo.upsertRun(r2);
    const all = await repo.listRuns();
    const ids = all.map((r) => r.runId);
    assert.ok(ids.includes(r1.runId));
    assert.ok(ids.includes(r2.runId));
  });

  it('listRuns 按 state 过滤', async () => {
    const r1 = mkRun({ state: 'ACTIVE' });
    const r2 = mkRun({ state: 'TERMINAL' });
    await repo.upsertRun(r1);
    await repo.upsertRun(r2);
    const active = await repo.listRuns({ states: ['ACTIVE'] });
    assert.ok(active.every((r) => r.state === 'ACTIVE'));
    assert.ok(active.some((r) => r.runId === r1.runId));
  });

  it('getRun 不存在返回 undefined', async () => {
    const result = await repo.getRun('RUN-nonexistent');
    assert.equal(result, undefined);
  });

  // ═══════════════════════════════════════════════════════════════
  // tasks CRUD
  // ═══════════════════════════════════════════════════════════════

  it('upsertTask + getTask 往返一致', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const fields = mkTask(run.runId);
    const created = await repo.upsertTask(fields);
    assert.equal(created.taskId, fields.taskId);
    assert.equal(created.runId, run.runId);
    assert.equal(created.kind, 'CODE');
    assert.equal(created.state, 'READY');

    const fetched = await repo.getTask(fields.taskId);
    assert.deepEqual(fetched, created);
  });

  it('setTaskState 推进到 RUNNING', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    const result = await repo.setTaskState(task.taskId, {
      state: 'RUNNING',
      attempt: 2,
      executionRound: 3,
    });
    assert.equal(result.state, 'RUNNING');
    assert.equal(result.attempt, 2);
    assert.equal(result.executionRound, 3);
  });

  it('setTaskState 写 lastError（JSONB）', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    const err = { code: 'LEASE_HELD', message: 'conflict' };
    const result = await repo.setTaskState(task.taskId, {
      state: 'FAILED',
      lastError: err,
    });
    assert.deepEqual(result.lastError, err);
  });

  it('listTasks 按 runId 过滤', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const t1 = mkTask(run.runId);
    const t2 = mkTask(run.runId);
    await repo.upsertTask(t1);
    await repo.upsertTask(t2);
    const list = await repo.listTasks({ runId: run.runId });
    assert.equal(list.length, 2);
  });

  it('getTask 不存在返回 undefined', async () => {
    const result = await repo.getTask('TSK-nonexistent');
    assert.equal(result, undefined);
  });

  // ═══════════════════════════════════════════════════════════════
  // artifacts CRUD
  // ═══════════════════════════════════════════════════════════════

  it('upsertArtifact + listArtifacts 往返一致', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    const fields = mkArtifact(run.runId, task.taskId);
    const created = await repo.upsertArtifact(fields);
    assert.equal(created.artifactId, fields.artifactId);
    assert.equal(created.kind, 'RESULT');
    assert.equal(created.sizeBytes, 1024);

    const list = await repo.listArtifacts({ runId: run.runId });
    assert.equal(list.length, 1);
    assert.equal(list[0].artifactId, fields.artifactId);
  });

  it('listArtifacts 按 kind 过滤', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    await repo.upsertArtifact(mkArtifact(run.runId, task.taskId, { kind: 'RESULT' }));
    await repo.upsertArtifact(mkArtifact(run.runId, task.taskId, { kind: 'EVIDENCE' }));

    const results = await repo.listArtifacts({ runId: run.runId, kind: 'RESULT' });
    assert.ok(results.every((a) => a.kind === 'RESULT'));
  });

  // ═══════════════════════════════════════════════════════════════
  // executions（只读查询，写入通过 lease.mjs）
  // ═══════════════════════════════════════════════════════════════

  it('getExecution / listExecutions 通过直接插入验证', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);

    // 直接 SQL 插入一条 execution（绕过 lease 模块，测试只读查询）
    const exeId = `EXE-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO "${schema}".executions
         (execution_id, task_id, run_id, attempt, cycle, worker_id,
          state, agent_id, lease_expires_at, started_at)
       VALUES ($1,$2,$3,1,0,'w1','SUCCEEDED','agent1',
               now() + interval '120s', now())`,
      [exeId, task.taskId, run.runId],
    );

    const exe = await repo.getExecution(exeId);
    assert.equal(exe.executionId, exeId);
    assert.equal(exe.state, 'SUCCEEDED');
    assert.equal(exe.workerId, 'w1');

    const list = await repo.listExecutions({ runId: run.runId });
    assert.ok(list.some((e) => e.executionId === exeId));
  });

  // ═══════════════════════════════════════════════════════════════
  // FK CASCADE
  // ═══════════════════════════════════════════════════════════════

  it('删 run → task CASCADE 删除', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);

    await pool.query(`DELETE FROM "${schema}".runs WHERE run_id = $1`, [run.runId]);
    const t = await repo.getTask(task.taskId);
    assert.equal(t, undefined);
  });

  it('删 run → execution CASCADE 删除', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    const exeId = `EXE-${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO "${schema}".executions
         (execution_id, task_id, run_id, attempt, cycle, worker_id,
          state, agent_id, lease_expires_at, started_at)
       VALUES ($1,$2,$3,1,0,'w1','SUCCEEDED','a1',
               now() + interval '120s', now())`,
      [exeId, task.taskId, run.runId],
    );

    await pool.query(`DELETE FROM "${schema}".runs WHERE run_id = $1`, [run.runId]);
    const ex = await repo.getExecution(exeId);
    assert.equal(ex, undefined);
  });

  it('删 run → artifact CASCADE 删除', async () => {
    const run = mkRun();
    await repo.upsertRun(run);
    const task = mkTask(run.runId);
    await repo.upsertTask(task);
    const art = mkArtifact(run.runId, task.taskId);
    await repo.upsertArtifact(art);

    await pool.query(`DELETE FROM "${schema}".runs WHERE run_id = $1`, [run.runId]);
    const list = await repo.listArtifacts({ runId: run.runId });
    assert.equal(list.length, 0);
  });

  it('FK 违反插入 task → 抛错', async () => {
    await assert.rejects(
      () => repo.upsertTask({
        taskId: 'TSK-fk-orphan',
        runId: 'RUN-nonexistent',
        kind: 'CODE',
        stepId: 's1',
        title: 'orphan',
        agentId: 'a',
        taskGroupId: 'TSK-fk-orphan',
      }),
      (err) => err.code === '23503',
    );
  });
});
