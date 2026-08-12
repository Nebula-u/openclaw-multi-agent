import { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } from '@langchain/langgraph-checkpoint';

function requiredConfig(config, field, { allowEmpty = false } = {}) {
  const value = config?.configurable?.[field];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`LangGraph checkpoint config requires a string ${field}`);
  }
  return value;
}

function checkpointConfig(threadId, checkpointNs, checkpointId) {
  return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId } };
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  constructor(database, serde) {
    super(serde);
    this.database = database;
    database.exec(`
      CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint_type TEXT NOT NULL,
        checkpoint_blob BLOB NOT NULL,
        metadata_type TEXT NOT NULL,
        metadata_blob BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS langgraph_checkpoint_writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        write_index INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value_type TEXT NOT NULL,
        value_blob BLOB NOT NULL,
        PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS langgraph_checkpoints_latest
        ON langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);
    `);
  }

  async deserializeRow(row) {
    if (!row) return undefined;
    const checkpoint = await this.serde.loadsTyped(row.checkpoint_type, row.checkpoint_blob);
    const metadata = await this.serde.loadsTyped(row.metadata_type, row.metadata_blob);
    const writes = this.database.prepare(`SELECT task_id, channel, value_type, value_blob
      FROM langgraph_checkpoint_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?
      ORDER BY task_id, write_index`).all(row.thread_id, row.checkpoint_ns, row.checkpoint_id);
    const pendingWrites = [];
    for (const write of writes) {
      pendingWrites.push([write.task_id, write.channel, await this.serde.loadsTyped(write.value_type, write.value_blob)]);
    }
    const value = {
      config: checkpointConfig(row.thread_id, row.checkpoint_ns, row.checkpoint_id),
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id) {
      value.parentConfig = checkpointConfig(row.thread_id, row.checkpoint_ns, row.parent_checkpoint_id);
    }
    return value;
  }

  async getTuple(config) {
    const threadId = requiredConfig(config, 'thread_id');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config);
    const row = checkpointId
      ? this.database.prepare(`SELECT * FROM langgraph_checkpoints
        WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?`).get(threadId, checkpointNs, checkpointId)
      : this.database.prepare(`SELECT * FROM langgraph_checkpoints
        WHERE thread_id=? AND checkpoint_ns=? ORDER BY checkpoint_id DESC LIMIT 1`).get(threadId, checkpointNs);
    return this.deserializeRow(row);
  }

  async *list(config, options = {}) {
    const threadId = config.configurable?.thread_id ?? null;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    const beforeId = options.before?.configurable?.checkpoint_id ?? null;
    const clauses = [];
    const parameters = [];
    if (threadId) { clauses.push('thread_id=?'); parameters.push(threadId); }
    if (checkpointNs !== undefined) { clauses.push('checkpoint_ns=?'); parameters.push(checkpointNs); }
    if (checkpointId) { clauses.push('checkpoint_id=?'); parameters.push(checkpointId); }
    if (beforeId) { clauses.push('checkpoint_id<?'); parameters.push(beforeId); }
    const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : null;
    const sql = `SELECT * FROM langgraph_checkpoints ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY checkpoint_id DESC${limit === null ? '' : ' LIMIT ?'}`;
    if (limit !== null) parameters.push(limit);
    for (const row of this.database.prepare(sql).all(...parameters)) {
      const tuple = await this.deserializeRow(row);
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => tuple.metadata?.[key] === value)) continue;
      yield tuple;
    }
  }

  async put(config, checkpoint, metadata) {
    const threadId = requiredConfig(config, 'thread_id');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
    const prepared = copyCheckpoint(checkpoint);
    const [checkpointType, checkpointBlob] = await this.serde.dumpsTyped(prepared);
    const [metadataType, metadataBlob] = await this.serde.dumpsTyped(metadata);
    this.database.prepare(`INSERT INTO langgraph_checkpoints(thread_id, checkpoint_ns, checkpoint_id,
      parent_checkpoint_id, checkpoint_type, checkpoint_blob, metadata_type, metadata_blob, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
        parent_checkpoint_id=excluded.parent_checkpoint_id, checkpoint_type=excluded.checkpoint_type,
        checkpoint_blob=excluded.checkpoint_blob, metadata_type=excluded.metadata_type,
        metadata_blob=excluded.metadata_blob`).run(threadId, checkpointNs, prepared.id, parentCheckpointId,
      checkpointType, checkpointBlob, metadataType, metadataBlob, new Date().toISOString());
    return checkpointConfig(threadId, checkpointNs, prepared.id);
  }

  async putWrites(config, writes, taskId) {
    const threadId = requiredConfig(config, 'thread_id');
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = requiredConfig(config, 'checkpoint_id');
    const insert = this.database.prepare(`INSERT OR IGNORE INTO langgraph_checkpoint_writes(thread_id,
      checkpoint_ns, checkpoint_id, task_id, write_index, channel, value_type, value_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < writes.length; index += 1) {
      const [channel, value] = writes[index];
      const writeIndex = WRITES_IDX_MAP[channel] ?? index;
      const [valueType, valueBlob] = await this.serde.dumpsTyped(value);
      insert.run(threadId, checkpointNs, checkpointId, taskId, writeIndex, channel, valueType, valueBlob);
    }
  }

  async deleteThread(threadId) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('threadId is required');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM langgraph_checkpoint_writes WHERE thread_id=?').run(threadId);
      this.database.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id=?').run(threadId);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }
}

