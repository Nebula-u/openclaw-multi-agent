import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/** 官方 saver + 项目侧 threadIds() 投影查询；共享 pool 的生命周期由 runtime 管理。 */
export class KernelPostgresSaver extends PostgresSaver {
  constructor(pool, { schema = 'langgraph', serde = undefined } = {}) {
    if (!pool) throw new TypeError('KernelPostgresSaver requires a pg Pool');
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/u.test(schema)) {
      throw Object.assign(new Error(`invalid checkpointer schema: ${schema}`), { code: 'CHECKPOINTER_SCHEMA_INVALID' });
    }
    super(pool, serde, { schema });
    this.schemaName = schema;
    this.pool = pool;
  }

  async threadIds() {
    const { rows } = await this.pool.query(
      `SELECT thread_id, MAX(checkpoint_id) AS updated_at
         FROM "${this.schemaName}".checkpoints
        GROUP BY thread_id
        ORDER BY updated_at DESC`,
    );
    return rows;
  }

  async setup() {
    // P1 曾创建过与官方 saver 不兼容的旧版两表结构。保留旧表作为归档，
    // 让官方迁移在同一 schema 内创建新表，避免静默覆盖历史 checkpoint。
    const { rows } = await this.pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='checkpoints' AND column_name='checkpoint'`,
      [this.schemaName],
    );
    if (rows.length === 0) {
      const { rows: legacy } = await this.pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema=$1 AND table_name IN ('checkpoints','checkpoint_writes')`,
        [this.schemaName],
      );
      if (legacy.length > 0) {
        await this.pool.query(`ALTER TABLE "${this.schemaName}".checkpoints RENAME TO checkpoints_legacy_sqlite`);
        if (legacy.some((row) => row.table_name === 'checkpoint_writes')) {
          await this.pool.query(`ALTER TABLE "${this.schemaName}".checkpoint_writes RENAME TO checkpoint_writes_legacy_sqlite`);
        }
      } else {
        // 迁移表可能因一次中断留下高版本，但实体表尚未创建；清掉游标让
        // 官方 setup 从 0 幂等重放，避免 "relation checkpoints does not exist"。
        await this.pool.query(`DROP TABLE IF EXISTS "${this.schemaName}".checkpoint_migrations`);
      }
    }
    await super.setup();
  }
}

export async function createKernelPostgresSaver({ pool, schema = 'langgraph', serde = undefined } = {}) {
  const saver = new KernelPostgresSaver(pool, { schema, serde });
  await saver.setup();
  return saver;
}
