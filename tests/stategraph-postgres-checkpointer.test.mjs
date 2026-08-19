import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  skipReason, tempSchemaName, createTestPool, kernelUrl, dropSchema,
} from './helpers/kernel-fixture.mjs';
import { schemaSqlWith } from './helpers/kernel-fixture.mjs';
import { KernelPostgresSaver } from '../scripts/stategraph/postgres-checkpointer.mjs';

describe('stategraph PostgreSQL checkpointer', { skip: skipReason() }, () => {
  let pool;
  let saver;
  let schema;
  let kernelSchema;

  before(async () => {
    schema = `lg_t_${tempSchemaName().slice(9)}`;
    kernelSchema = tempSchemaName();
    pool = createTestPool(kernelUrl(), { max: 4 });
    // Kernel DDL 与 checkpointer setup 使用同一数据库，但 schema 生命周期独立。
    await pool.query(schemaSqlWith(kernelSchema));
    saver = new KernelPostgresSaver(pool, { schema });
    await saver.setup();
  });

  after(async () => {
    if (!pool) return;
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch { /* best effort */ }
    try { await pool.query(`DROP SCHEMA IF EXISTS "${kernelSchema}" CASCADE`); } catch { /* best effort */ }
    await pool.end();
  });

  function checkpoint(id, value = 'alpha') {
    return {
      v: 1,
      id,
      ts: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      channel_values: { value },
      channel_versions: { value: id },
      versions_seen: {},
      pending_sends: [],
    };
  }

  it('setup 建立官方四表且幂等', async () => {
    await saver.setup();
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name`,
      [schema],
    );
    assert.deepEqual(rows.map((row) => row.table_name), [
      'checkpoint_blobs', 'checkpoint_migrations', 'checkpoint_writes', 'checkpoints',
    ]);
  });

  it('put/getTuple/list 往返 checkpoint、metadata 与父链', async () => {
    const base = { configurable: { thread_id: 'WF-PG-001', checkpoint_ns: '' } };
    const firstConfig = await saver.put(base, checkpoint('0001'), { source: 'input', step: 0 }, { value: '0001' });
    const secondConfig = await saver.put(
      { configurable: { ...firstConfig.configurable } },
      checkpoint('0002', 'beta'),
      { source: 'loop', step: 1 },
      { value: '0002' },
    );
    const tuple = await saver.getTuple(secondConfig);
    assert.equal(tuple.config.configurable.checkpoint_id, '0002');
    assert.equal(tuple.checkpoint.channel_values.value, 'beta');
    assert.deepEqual(tuple.metadata, { source: 'loop', step: 1 });
    assert.equal(tuple.parentConfig.configurable.checkpoint_id, '0001');

    const listed = [];
    for await (const item of saver.list({ configurable: { thread_id: 'WF-PG-001', checkpoint_ns: '' } })) listed.push(item);
    assert.deepEqual(listed.map((item) => item.config.configurable.checkpoint_id), ['0002', '0001']);
  });

  it('putWrites、threadIds 与 deleteThread 正常工作', async () => {
    const config = await saver.put(
      { configurable: { thread_id: 'WF-PG-002', checkpoint_ns: '' } },
      checkpoint('0001'),
      { source: 'input' },
      { value: '0001' },
    );
    await saver.putWrites(config, [['value', { ok: true }]], 'task-1');
    const tuple = await saver.getTuple(config);
    assert.deepEqual(tuple.pendingWrites, [['task-1', 'value', { ok: true }]]);
    const ids = await saver.threadIds();
    assert.deepEqual(ids.map((row) => row.thread_id).sort(), ['WF-PG-001', 'WF-PG-002']);
    await saver.deleteThread('WF-PG-002');
    assert.equal(await saver.getTuple(config), undefined);
  });
});
