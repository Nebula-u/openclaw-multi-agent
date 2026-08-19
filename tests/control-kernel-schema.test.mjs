/**
 * Control Kernel — schema.sql 幂等性与约束测试
 *
 * 前置条件：OPENCLAW_PG_URL 可达；否则整个文件 skip。
 * 隔离：每次运行创建独立临时 schema，结束后 DROP CASCADE。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  kernelUrl, skipReason, schemaSqlWith, dropSchema,
  tempSchemaName, createTestPool,
} from './helpers/kernel-fixture.mjs';

describe('control-kernel schema', { skip: skipReason() }, () => {
  let pool;
  let schema;

  before(() => {
    schema = tempSchemaName();
    pool = createTestPool(kernelUrl(), { max: 2 });
  });

  after(async () => {
    if (!pool) return;
    try { await dropSchema(pool, schema); } catch { /* ignore */ }
    await pool.end();
  });

  it('第一次 apply 建表成功', async () => {
    const sql = schemaSqlWith(schema);
    await pool.query(sql);

    // 验证 5 张 kernel 事实表存在；LangGraph 表由 PostgresSaver.setup() 管理。
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 ORDER BY table_name`, [schema]);
    const names = rows.map((r) => r.table_name);
    assert.ok(names.includes('runs'), `runs 不存在: ${names}`);
    assert.ok(names.includes('tasks'), `tasks 不存在: ${names}`);
    assert.ok(names.includes('executions'), `executions 不存在: ${names}`);
    assert.ok(names.includes('artifacts'), `artifacts 不存在: ${names}`);
    assert.ok(names.includes('events'), `events 不存在: ${names}`);
    assert.deepEqual(names.sort(), ['artifacts', 'events', 'executions', 'runs', 'tasks']);
  });

  it('重复 apply 幂等（不报错）', async () => {
    const sql = schemaSqlWith(schema);
    await pool.query(sql); // 第二次
    await pool.query(sql); // 第三次
    // 不抛即通过
  });

  it('runs.state CHECK 约束生效', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".runs
           (run_id, langgraph_thread_id, state, request, request_sha256,
            target_project_root_abs, base_commit)
         VALUES ($1,$2,$3,'{}', $4, $5, $6)`,
        ['RUN-test', 'T-test', 'INVALID_STATE', 'd'.repeat(64), '/tmp', 'abc123']),
      (err) => err.message.includes('runs_state_check'),
    );
  });

  it('tasks.state CHECK 约束生效', async () => {
    const runId = `RUN-chk-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'a'.repeat(64)]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".tasks
           (task_id, run_id, kind, step_id, title, agent_id, state,
            task_group_id)
         VALUES ($1,$2,'CODE','step1','title','agent1','BOGUS', $1)`,
        [`TSK-${Date.now()}`, runId]),
      (err) => err.message.includes('tasks_state_check'),
    );
  });

  it('executions.state CHECK 约束生效', async () => {
    const runId = `RUN-exe-${Date.now()}`;
    const taskId = `TSK-exe-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'b'.repeat(64)]);
    await pool.query(
      `INSERT INTO "${schema}".tasks
         (task_id, run_id, kind, step_id, title, agent_id, state, task_group_id)
       VALUES ($1,$2,'CODE','s1','t','a','READY', $1)`,
      [taskId, runId]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".executions
           (execution_id, task_id, run_id, attempt, worker_id, state,
            agent_id, lease_expires_at)
         VALUES ($1,$2,$3, 1, 'w1', 'NOT_A_STATE', 'a', now() + interval '60s')`,
        [`EXE-${Date.now()}`, taskId, runId]),
      (err) => err.message.includes('executions_state_check'),
    );
  });

  it('artifacts.kind CHECK 约束生效', async () => {
    const runId = `RUN-art-${Date.now()}`;
    const taskId = `TSK-art-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'c'.repeat(64)]);
    await pool.query(
      `INSERT INTO "${schema}".tasks
         (task_id, run_id, kind, step_id, title, agent_id, state, task_group_id)
       VALUES ($1,$2,'CODE','s1','t','a','READY', $1)`,
      [taskId, runId]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".artifacts
           (artifact_id, run_id, task_id, kind, uri, sha256, size_bytes)
         VALUES ($1,$2,$3,'BAD_KIND','file:///x', $4, 42)`,
        [`ART-${Date.now()}`, runId, taskId, 'd'.repeat(64)]),
      (err) => err.message.includes('artifacts_kind_check'),
    );
  });

  it('artifacts.sha256 格式检查生效', async () => {
    const runId = `RUN-sha-${Date.now()}`;
    const taskId = `TSK-sha-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'e'.repeat(64)]);
    await pool.query(
      `INSERT INTO "${schema}".tasks
         (task_id, run_id, kind, step_id, title, agent_id, state, task_group_id)
       VALUES ($1,$2,'CODE','s1','t','a','READY', $1)`,
      [taskId, runId]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".artifacts
           (artifact_id, run_id, task_id, kind, uri, sha256, size_bytes)
         VALUES ($1,$2,$3,'RESULT','file:///x','NOT_HEX', 42)`,
        [`ART2-${Date.now()}`, runId, taskId]),
      (err) => err.message.includes('artifacts_sha_check'),
    );
  });

  it('events.event_hash 格式检查生效', async () => {
    const runId = `RUN-ev-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'f'.repeat(64)]);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".events
           (event_id, run_id, type, event_hash)
         VALUES ($1,$2,'TEST','NOTHEX')`,
        [`EVT-${Date.now()}`, runId]),
      (err) => err.message.includes('events_hash_check'),
    );
  });

  it('tasks CASCADE 删除：删 run 则 task 一起消失', async () => {
    const runId = `RUN-cas-${Date.now()}`;
    const taskId = `TSK-cas-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'a1'.repeat(32)]);
    await pool.query(
      `INSERT INTO "${schema}".tasks
         (task_id, run_id, kind, step_id, title, agent_id, state, task_group_id)
       VALUES ($1,$2,'CODE','s1','t','a','READY', $1)`,
      [taskId, runId]);
    await pool.query(`DELETE FROM "${schema}".runs WHERE run_id = $1`, [runId]);
    const { rows } = await pool.query(
      `SELECT 1 FROM "${schema}".tasks WHERE task_id = $1`, [taskId]);
    assert.equal(rows.length, 0);
  });

  it('executions 唯一活跃索引：同 task 只能有一个活跃 execution', async () => {
    const runId = `RUN-ux-${Date.now()}`;
    const taskId = `TSK-ux-${Date.now()}`;
    await pool.query(
      `INSERT INTO "${schema}".runs
         (run_id, langgraph_thread_id, state, request, request_sha256,
          target_project_root_abs, base_commit)
       VALUES ($1,$2,'ACTIVE','{}', $3, '/tmp', 'abc123')`,
      [runId, `T-${runId}`, 'b1'.repeat(32)]);
    await pool.query(
      `INSERT INTO "${schema}".tasks
         (task_id, run_id, kind, step_id, title, agent_id, state, task_group_id)
       VALUES ($1,$2,'CODE','s1','t','a','READY', $1)`,
      [taskId, runId]);
    // 第一条 LEASED — 成功
    await pool.query(
      `INSERT INTO "${schema}".executions
         (execution_id, task_id, run_id, attempt, worker_id, state,
          agent_id, lease_expires_at)
       VALUES ($1,$2,$3, 1, 'w1', 'LEASED', 'a', now() + interval '120s')`,
      [`EXE-A-${Date.now()}`, taskId, runId]);
    // 第二条 LEASED — 唯一索引冲突
    await assert.rejects(
      () => pool.query(
        `INSERT INTO "${schema}".executions
           (execution_id, task_id, run_id, attempt, worker_id, state,
            agent_id, lease_expires_at)
         VALUES ($1,$2,$3, 2, 'w2', 'LEASED', 'a', now() + interval '120s')`,
        [`EXE-B-${Date.now()}`, taskId, runId]),
      (err) => err.message.includes('executions_active_lease'),
    );
  });

  it('DROP 临时 schema 成功（后续清理验证）', async () => {
    await dropSchema(pool, schema);
    const { rows } = await pool.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1`,
      [schema]);
    assert.equal(rows.length, 0);
    // 标记已清理，after() 不会再次 DROP
    schema = null;
  });
});
