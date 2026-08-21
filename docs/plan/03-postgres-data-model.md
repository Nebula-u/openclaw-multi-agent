# 03 · PostgreSQL 数据模型

> 历史计划：当前实现使用单机 SQLite，不部署本文 PostgreSQL 模型，也不迁移其历史数据。

> 目标：一个数据库实例、两个 schema。`kernel` 存事实，`langgraph` 存决策投影。

---

## 1. 总览

```text
PostgreSQL: openclaw
│
├── schema kernel      ← Control Kernel，唯一可信数据源
│   ├── runs
│   ├── tasks
│   ├── executions
│   ├── artifacts
│   └── events
│
└── schema langgraph   ← LangGraph Checkpointer
    ├── checkpoints
    └── checkpoint_writes
```

### 核心数据关系

严格对应用户给的图：

```text
Run
 ├── run_id (PK)
 ├── langgraph_thread_id  ← 唯一，等于 workflowId
 └── Tasks
      ├── task_id (PK)
      ├── Executions
      │    ├── execution_id (PK)
      │    ├── worker_id
      │    ├── heartbeat_at
      │    ├── lease_expires_at
      │    └── attempt
      └── Artifacts
           ├── artifact_id (PK)
           ├── uri
           └── sha256
```

---

## 2. 连接与配置

### 2.1 环境变量

```bash
# 必填
OPENCLAW_PG_URL=postgres://openclaw:<pw>@127.0.0.1:5432/openclaw

# 可选（有默认值）
OPENCLAW_PG_POOL_MAX=8
OPENCLAW_PG_STATEMENT_TIMEOUT_MS=15000
OPENCLAW_PG_CONNECT_TIMEOUT_MS=5000
OPENCLAW_KERNEL_LEASE_SECONDS=120
OPENCLAW_WORKER_ID=<hostname>-<pid>
```

同时支持项目根 `.env`（`monitor/config.mjs` 已有 `readEnvironmentFile()`，复用同一套解析）。

### 2.2 依赖

`package.json` 新增唯一一个依赖：

```json
"pg": "^8.13.1"
```

不引入 ORM、不引入迁移框架。DDL 用幂等 `CREATE ... IF NOT EXISTS`，由 `scripts/control-kernel/schema.sql` 一次性 apply。

### 2.3 连接池

`scripts/control-kernel/pool.mjs`：

```js
import { Pool } from 'pg';

export function createKernelPool({ url, max = 8, statementTimeoutMs = 15000,
  connectTimeoutMs = 5000 } = {}) {
  if (!url) throw Object.assign(new Error('OPENCLAW_PG_URL is required'),
    { code: 'KERNEL_PG_URL_MISSING' });
  return new Pool({
    connectionString: url,
    max,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 30000,
    application_name: 'openclaw-control-kernel',
  });
}
```

---

## 3. kernel schema DDL

```sql
CREATE SCHEMA IF NOT EXISTS kernel;

-- ══════════════════════════════════════════════════════════════
-- 3.1 runs
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kernel.runs (
  run_id                  TEXT        PRIMARY KEY,
  langgraph_thread_id     TEXT        NOT NULL UNIQUE,
  state                   TEXT        NOT NULL DEFAULT 'ACTIVE',
  outcome                 TEXT,
  status_reason           TEXT,
  request                 JSONB       NOT NULL,
  request_sha256          TEXT        NOT NULL,
  target_project_root_abs TEXT        NOT NULL,
  base_commit             TEXT        NOT NULL,
  candidate_commit        TEXT,
  route_hash              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  CONSTRAINT runs_state_check
    CHECK (state IN ('ACTIVE','WAITING_HUMAN','HOLD','TERMINAL'))
);

CREATE INDEX IF NOT EXISTS runs_state_updated
  ON kernel.runs(state, updated_at DESC);

-- ══════════════════════════════════════════════════════════════
-- 3.2 tasks
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kernel.tasks (
  task_id              TEXT        PRIMARY KEY,
  run_id               TEXT        NOT NULL
                         REFERENCES kernel.runs(run_id) ON DELETE CASCADE,
  kind                 TEXT        NOT NULL,
  step_id              TEXT        NOT NULL,
  title                TEXT        NOT NULL,
  agent_id             TEXT        NOT NULL,
  state                TEXT        NOT NULL DEFAULT 'READY',
  attempt              INTEGER     NOT NULL DEFAULT 1,
  max_attempts         INTEGER     NOT NULL DEFAULT 3,
  json_regenerations   INTEGER     NOT NULL DEFAULT 0,
  execution_round      INTEGER     NOT NULL DEFAULT 1,
  route_hash           TEXT,
  input_commit         TEXT,
  -- 并行预留：串行下 task_group_id=task_id, parallel_slot=0
  task_group_id        TEXT        NOT NULL,
  parallel_slot        INTEGER     NOT NULL DEFAULT 0,
  depends_on           TEXT[]      NOT NULL DEFAULT '{}',
  last_error           JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_state_check CHECK (state IN (
    'READY','REPAIR_READY','DISPATCHED','STARTING','RUNNING',
    'SUCCEEDED','FAILED','WAITING_HUMAN','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS tasks_run       ON kernel.tasks(run_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_state     ON kernel.tasks(state)
  WHERE state IN ('READY','REPAIR_READY','DISPATCHED','STARTING','RUNNING');
CREATE INDEX IF NOT EXISTS tasks_group     ON kernel.tasks(task_group_id);

-- ══════════════════════════════════════════════════════════════
-- 3.3 executions  ← worker_id / heartbeat / lease / attempt
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kernel.executions (
  execution_id          TEXT        PRIMARY KEY,
  task_id               TEXT        NOT NULL
                          REFERENCES kernel.tasks(task_id) ON DELETE CASCADE,
  run_id                TEXT        NOT NULL
                          REFERENCES kernel.runs(run_id) ON DELETE CASCADE,
  attempt               INTEGER     NOT NULL,
  cycle                 INTEGER     NOT NULL DEFAULT 0,
  worker_id             TEXT        NOT NULL,
  state                 TEXT        NOT NULL DEFAULT 'LEASED',
  phase                 TEXT,
  agent_id              TEXT        NOT NULL,
  session_id            TEXT,
  pid                   INTEGER,
  worktree_path_abs     TEXT,
  artifact_root_abs     TEXT,
  lease_expires_at      TIMESTAMPTZ NOT NULL,
  heartbeat_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at           TIMESTAMPTZ,
  exit_code             INTEGER,
  error                 JSONB,
  sandbox_attestation   JSONB,
  CONSTRAINT executions_state_check CHECK (state IN (
    'LEASED','RUNNING','SUCCEEDED','FAILED','LEASE_EXPIRED','CANCELLED'))
);

-- ★ 并发闸门：一个 task 同时只能有一个活跃 execution
CREATE UNIQUE INDEX IF NOT EXISTS executions_active_lease
  ON kernel.executions(task_id)
  WHERE state IN ('LEASED','RUNNING');

CREATE INDEX IF NOT EXISTS executions_task     ON kernel.executions(task_id, attempt, cycle);
CREATE INDEX IF NOT EXISTS executions_run      ON kernel.executions(run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS executions_reap     ON kernel.executions(lease_expires_at)
  WHERE state IN ('LEASED','RUNNING');
CREATE INDEX IF NOT EXISTS executions_worker   ON kernel.executions(worker_id, state);

-- ══════════════════════════════════════════════════════════════
-- 3.4 artifacts  ← artifact_id / uri / hash
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kernel.artifacts (
  artifact_id    TEXT        PRIMARY KEY,
  run_id         TEXT        NOT NULL
                   REFERENCES kernel.runs(run_id) ON DELETE CASCADE,
  task_id        TEXT        NOT NULL
                   REFERENCES kernel.tasks(task_id) ON DELETE CASCADE,
  execution_id   TEXT        REFERENCES kernel.executions(execution_id) ON DELETE SET NULL,
  kind           TEXT        NOT NULL,
  uri            TEXT        NOT NULL,
  sha256         TEXT        NOT NULL,
  size_bytes     BIGINT      NOT NULL,
  media_type     TEXT        NOT NULL DEFAULT 'application/json',
  commit_sha     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_kind_check CHECK (kind IN (
    'ROUTE_PLAN','RESULT','EVIDENCE','GATE_RESULT','COMMAND_RECORD',
    'CONTEXT_MANIFEST','INGESTION_RECEIPT','REVIEW_FINDINGS',
    'RELEASE_DECISION','RAW_OUTPUT','LOG')),
  CONSTRAINT artifacts_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS artifacts_task ON kernel.artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_run  ON kernel.artifacts(run_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_sha  ON kernel.artifacts(sha256);

-- ══════════════════════════════════════════════════════════════
-- 3.5 events  ← 哈希链账本
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS kernel.events (
  event_seq      BIGSERIAL   PRIMARY KEY,
  event_id       TEXT        NOT NULL UNIQUE,
  run_id         TEXT        NOT NULL
                   REFERENCES kernel.runs(run_id) ON DELETE CASCADE,
  task_id        TEXT,
  execution_id   TEXT,
  type           TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      TEXT,
  event_hash     TEXT        NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_hash_check CHECK (event_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS events_run ON kernel.events(run_id, event_seq);
```

### 3.6 与现有 JS 命名的对应

现有代码用 camelCase / 现有 task 对象用 snake_case，PG 列名统一 snake_case。映射在 `repository.mjs` 内部完成，**不外泄**：

| PG 列 | 现有 JS |
| --- | --- |
| `runs.langgraph_thread_id` | `state.workflowId` |
| `runs.base_commit` | `state.baseCommit` |
| `runs.candidate_commit` | `state.candidateCommit` |
| `tasks.state` | `task.status` |
| `tasks.kind` | `task.kind` |
| `executions.cycle` | `task.current_cycle` |
| `executions.worktree_path_abs` | `task.worktree_path_abs` |
| `executions.artifact_root_abs` | `task.artifact_root_abs` |

注意 `tasks.state` ↔ `task.status`：**PG 用 `state`，JS 保持 `status`**。因为 Monitor 的 `publicTask.status` 字段名已冻结（见文档 2 §8.2），不能改 JS 侧。

---

## 4. langgraph schema DDL

保持与现有 SQLite 表结构**逐字段一致**，只做类型映射，让迁移风险最小：

```sql
CREATE SCHEMA IF NOT EXISTS langgraph;

CREATE TABLE IF NOT EXISTS langgraph.checkpoints (
  thread_id             TEXT        NOT NULL,
  checkpoint_ns         TEXT        NOT NULL DEFAULT '',
  checkpoint_id         TEXT        NOT NULL,
  parent_checkpoint_id  TEXT,
  checkpoint_type       TEXT        NOT NULL,
  checkpoint_blob       BYTEA       NOT NULL,
  metadata_type         TEXT        NOT NULL,
  metadata_blob         BYTEA       NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE INDEX IF NOT EXISTS checkpoints_latest
  ON langgraph.checkpoints(thread_id, checkpoint_ns, checkpoint_id DESC);

CREATE TABLE IF NOT EXISTS langgraph.checkpoint_writes (
  thread_id      TEXT    NOT NULL,
  checkpoint_ns  TEXT    NOT NULL DEFAULT '',
  checkpoint_id  TEXT    NOT NULL,
  task_id        TEXT    NOT NULL,
  write_index    INTEGER NOT NULL,
  channel        TEXT    NOT NULL,
  value_type     TEXT    NOT NULL,
  value_blob     BYTEA   NOT NULL,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
);
```

### 类型映射对照

| SQLite | PostgreSQL |
| --- | --- |
| `TEXT` | `TEXT` |
| `BLOB` | `BYTEA` |
| `INTEGER` | `INTEGER` |
| `created_at TEXT`（ISO 串） | `TIMESTAMPTZ` |
| `STRICT` | 无（PG 本身强类型） |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` |
| `ON CONFLICT ... DO UPDATE SET` | 同（PG 语法一致） |

---

## 5. acquireLease 的实现

这是 Kernel 唯一有并发风险的操作，必须一条 SQL 搞定，**不能"先 SELECT 再 INSERT"**。

```sql
-- 依赖 executions_active_lease 这个 partial unique index
INSERT INTO kernel.executions (
  execution_id, task_id, run_id, attempt, cycle, worker_id,
  agent_id, state, lease_expires_at, heartbeat_at, started_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, 'LEASED',
  now() + make_interval(secs => $8), now(), now()
)
ON CONFLICT DO NOTHING
RETURNING *;
```

JS 侧：

```js
async function acquireLease({ taskId, runId, attempt, cycle = 0,
  agentId, workerId, leaseSeconds = 120 }) {
  const executionId = `EXE-${taskId.slice(5)}-A${attempt}-C${cycle}-${randomUUID().slice(0, 8)}`;
  const { rows } = await pool.query(ACQUIRE_SQL, [
    executionId, taskId, runId, attempt, cycle, workerId, agentId, leaseSeconds,
  ]);
  if (rows.length === 0) {
    // partial unique index 拦住了 → 已有活跃 execution
    const active = await activeExecution(taskId);
    throw Object.assign(
      new Error(`task ${taskId} already has an active execution`),
      { code: 'LEASE_HELD', details: { active_execution_id: active?.execution_id ?? null,
        worker_id: active?.worker_id ?? null } },
    );
  }
  return rows[0];
}
```

**为什么 `ON CONFLICT DO NOTHING` 能生效**：`executions_active_lease` 是带 `WHERE state IN ('LEASED','RUNNING')` 的 partial unique index。当同 task 已有活跃行时，INSERT 触发唯一冲突 → `DO NOTHING` → `rows.length === 0`。终态行（`SUCCEEDED` 等）不在索引里，所以历史 attempt 不会阻塞新 lease。

### 5.1 heartbeat

```sql
UPDATE kernel.executions
SET heartbeat_at = now(),
    lease_expires_at = now() + make_interval(secs => $2),
    state = 'RUNNING',
    phase = COALESCE($3, phase)
WHERE execution_id = $1
  AND state IN ('LEASED','RUNNING')
RETURNING execution_id, lease_expires_at;
```

返回 0 行 = lease 已被回收，Harness 必须**立即自杀**（防止两个进程写同一 worktree）。

### 5.2 releaseLease

```sql
UPDATE kernel.executions
SET state = $2, exit_code = $3, error = $4,
    finished_at = now(), lease_expires_at = now()
WHERE execution_id = $1
  AND state IN ('LEASED','RUNNING')
RETURNING *;
```

`lease_expires_at = now()` 让行立刻退出 partial index，下一个 attempt 可以马上领 lease。

### 5.3 reapExpiredLeases

由 `reconcile` 节点与 Monitor 的 `reconcileCycle` 各自调用（幂等）：

```sql
UPDATE kernel.executions
SET state = 'LEASE_EXPIRED',
    finished_at = now(),
    error = jsonb_build_object(
      'code', 'EXECUTION_LEASE_EXPIRED',
      'message', 'worker heartbeat stopped before lease expiry',
      'last_heartbeat_at', to_jsonb(heartbeat_at))
WHERE state IN ('LEASED','RUNNING')
  AND lease_expires_at < now()
RETURNING execution_id, task_id, run_id, worker_id, attempt;
```

---

## 6. 事件哈希链

沿用现有 `scripts/stategraph/events.mjs` 的 `canonicalJson()` + `sha256()`，**保证 checkpoint 内事件链与 Kernel 事件链算法一致**。

```js
async function appendEvent({ runId, taskId = null, executionId = null, type, payload = {} }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 行级锁住 run，串行化同 run 的事件写入
    await client.query('SELECT 1 FROM kernel.runs WHERE run_id=$1 FOR UPDATE', [runId]);
    const { rows: [tail] } = await client.query(
      `SELECT event_hash FROM kernel.events
       WHERE run_id=$1 ORDER BY event_seq DESC LIMIT 1`, [runId]);
    const prevHash = tail?.event_hash ?? null;
    const occurredAt = clock().toISOString();
    const eventId = `EVT-${runId.slice(4)}-${randomUUID().slice(0, 8)}`;
    const body = { event_id: eventId, run_id: runId, task_id: taskId,
      execution_id: executionId, type, payload, prev_hash: prevHash,
      occurred_at: occurredAt };
    const eventHash = sha256(canonicalJson(body));
    const { rows: [row] } = await client.query(
      `INSERT INTO kernel.events (event_id, run_id, task_id, execution_id,
         type, payload, prev_hash, event_hash, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [eventId, runId, taskId, executionId, type, payload, prevHash, eventHash, occurredAt]);
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
```

### 审计

```js
async function auditEvents(runId) {
  const { rows } = await pool.query(
    'SELECT * FROM kernel.events WHERE run_id=$1 ORDER BY event_seq', [runId]);
  let prev = null;
  const broken = [];
  for (const row of rows) {
    const body = { event_id: row.event_id, run_id: row.run_id, task_id: row.task_id,
      execution_id: row.execution_id, type: row.type, payload: row.payload,
      prev_hash: prev, occurred_at: row.occurred_at.toISOString() };
    if (row.prev_hash !== prev || sha256(canonicalJson(body)) !== row.event_hash) {
      broken.push({ event_seq: row.event_seq, event_id: row.event_id });
    }
    prev = row.event_hash;
  }
  return { ok: broken.length === 0, run_id: runId, count: rows.length, broken };
}
```

`/api/health` 的 `audit` 字段合并 checkpoint 链审计 + Kernel 链审计两个结果。

---

## 7. Checkpointer 迁移的具体改造

### 7.1 逐方法改造清单

本项目采用官方 `@langchain/langgraph-checkpoint-postgres@1.0.4` 的 `PostgresSaver`，不再维护一份手写 saver。官方实现包含标准的 `checkpoints`、`checkpoint_blobs`、`checkpoint_writes`、`checkpoint_migrations` 四表迁移；本项目只提供 `KernelPostgresSaver` 包装，补充 `threadIds()` 查询并复用 Control Kernel 的共享 `pg.Pool`。

| 方法 | 现状 | 改造 |
| --- | --- | --- |
| `constructor/setup` | 官方 saver 自带迁移 | `KernelPostgresSaver(pool, { schema })` 后显式 `await setup()` |
| `getTuple/list/put/putWrites` | 官方实现 | 直接沿用官方协议，官方负责 serde、BYTEA 与迁移兼容 |
| `threadIds` | 项目自定义查询 | `async` 查询 `checkpoints`，供 runtime/Monitor 列出 workflow |
| `deleteThread/end` | 官方实现 | `deleteThread` 可用；共享 pool 的生命周期由 runtime 管理，不调用 saver.end() |

### 7.2 `threadIds()` 改 async 的连带影响

这是**唯一的破坏性签名变更**。影响链：

```text
SqliteCheckpointSaver.threadIds()  ← 同步
        ↑
runtime.mjs list()                 ← for (const row of checkpointer.threadIds())
        ↑
monitor/server.mjs refresh()       ← await stateRuntime.list()  ← 已经是 async ✅
scripts/workflow.mjs               ← 命令处理已经是 async ✅
```

改造：

```js
// postgres-checkpointer.mjs（项目包装）
async threadIds() {
  const { rows } = await this.pool.query(
    `SELECT thread_id, MAX(created_at) AS updated_at
     FROM langgraph.checkpoints GROUP BY thread_id ORDER BY updated_at DESC`);
  return rows;
}

// runtime.mjs
async function list() {
  const values = [];
  for (const row of await checkpointer.threadIds()) {   // ← 只加一个 await
    const item = await state(row.thread_id);
    if (item) values.push(item);
  }
  return values;
}
```

**影响面：2 行代码。** 因为所有上游调用早已是 async。

### 7.3 `close()` 改 async

```js
// runtime.mjs 现状
close() { if (ownDatabase) connection.close(); }

// 改造后
async close() { if (ownPool) await pool.end(); }
```

调用点：`monitor/server.mjs` 的 `close()` 已是 async，加 `await` 即可。

### 7.4 putWrites 批量化

```js
async putWrites(config, writes, taskId) {
  const threadId = requiredConfig(config, 'thread_id');
  const checkpointNs = config.configurable?.checkpoint_ns ?? '';
  const checkpointId = requiredConfig(config, 'checkpoint_id');
  const values = [];
  const params = [];
  for (let index = 0; index < writes.length; index += 1) {
    const [channel, value] = writes[index];
    const writeIndex = WRITES_IDX_MAP[channel] ?? index;
    const [valueType, valueBlob] = await this.serde.dumpsTyped(value);
    const base = params.length;
    values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
    params.push(threadId, checkpointNs, checkpointId, taskId, writeIndex,
      channel, valueType, valueBlob);
  }
  if (values.length === 0) return;
  await this.pool.query(
    `INSERT INTO langgraph.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id,
       task_id, write_index, channel, value_type, value_blob)
     VALUES ${values.join(',')} ON CONFLICT DO NOTHING`, params);
}
```

---

## 8. 历史数据迁移

现有 `runtime/stategraph/checkpoints.db` 里有正在跑的 workflow。提供**可选**迁移脚本 `scripts/control-kernel/migrate-from-sqlite.mjs`：

```bash
node scripts/control-kernel/migrate-from-sqlite.mjs \
  --sqlite runtime/stategraph/checkpoints.db \
  --pg "$OPENCLAW_PG_URL" \
  --dry-run
```

### 迁移逻辑

1. 读 SQLite `langgraph_checkpoints` / `langgraph_checkpoint_writes` 全表
2. 按 `thread_id` 分组，逐 thread 在一个 PG 事务内插入
3. `created_at` 从 ISO 串 parse 为 `TIMESTAMPTZ`
4. `checkpoint_blob` / `metadata_blob` / `value_blob` 从 SQLite `Buffer` 直传 `BYTEA`
5. **同时反向重建 `kernel.runs` / `kernel.tasks`**：对每个 thread 取最新 checkpoint，反序列化 `state`，从 `state.workflowId` / `state.tasks[]` 补出 kernel 行。`executions` 无法反建（历史没有 worker_id），插入一条 `state='SUCCEEDED'` 的合成行，`worker_id='migrated'`
6. `--dry-run` 只打印统计，不写

### 不迁移也可以

如果没有必须延续的在跑 workflow，**推荐直接不迁移**：归档旧 db 然后新建。

```bash
mkdir -p runtime/archive
mv runtime/stategraph/checkpoints.db      runtime/archive/checkpoints-sqlite.db
mv runtime/stategraph/checkpoints.db-wal  runtime/archive/ 2>/dev/null || true
mv runtime/stategraph/checkpoints.db-shm  runtime/archive/ 2>/dev/null || true
mv runtime/control/control.db             runtime/archive/control-legacy.db
```

旧 `runtime/control/control.db` 是被 `2cc17ac` 删掉的旧三层框架的遗留，**直接归档，不迁移**。

---

## 9. 本地开发环境

### Docker 起 PG

```bash
docker run -d --name openclaw-pg \
  -e POSTGRES_USER=openclaw \
  -e POSTGRES_PASSWORD=openclaw \
  -e POSTGRES_DB=openclaw \
  -p 127.0.0.1:5432:5432 \
  -v openclaw-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

### 应用 schema

```bash
node scripts/control-kernel/apply-schema.mjs
# 或
psql "$OPENCLAW_PG_URL" -f scripts/control-kernel/schema.sql
```

### 测试环境隔离

测试**不能**污染开发库。方案：每个测试文件用独立 schema 前缀。

```js
// tests/helpers/kernel-fixture.mjs
const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
const kernelSchema = `kernel_t_${suffix}`;
const langgraphSchema = `langgraph_t_${suffix}`;
// schema.sql 里的 schema 名做占位符替换后 apply
// afterEach: DROP SCHEMA ... CASCADE
```

**若 `OPENCLAW_PG_URL` 未设置，PG 相关测试整体 `skip`**（`node:test` 的 `t.skip()`），保证 CI 无 PG 时 `npm test` 依然全绿。这一点在 P1 就要做进 fixture。

---

## 10. 容量与保留策略

| 表 | 增长速率 | 保留策略 |
| --- | --- | --- |
| `kernel.runs` | 每需求 1 行 | 永久 |
| `kernel.tasks` | 每阶段 1 行（回退时 ×N） | 永久 |
| `kernel.executions` | 每 attempt×cycle 1 行 | 永久（审计需要） |
| `kernel.artifacts` | 每产物 1 行 | 永久（索引很小） |
| `kernel.events` | 每状态变更 1 行，最大表 | 永久；`event_seq` 用 `BIGSERIAL` |
| `langgraph.checkpoints` | **每 graph turn 1 行，增长最快** | 可裁剪，见下 |
| `langgraph.checkpoint_writes` | 每 turn ×通道数 | 随 checkpoints 裁剪 |

### checkpoint 裁剪

`langgraph.checkpoints` 是唯一需要关注的表。一个 workflow 走完全流程约 60–120 个 turn，每个 checkpoint 序列化整个 state（含 `events[]` 和 `tasks[]`），单行可能到几十 KB。

裁剪脚本（P10，可选）：

```sql
-- 对已 TERMINAL 的 run，只保留最后 20 个 checkpoint
DELETE FROM langgraph.checkpoints c
USING kernel.runs r
WHERE r.langgraph_thread_id = c.thread_id
  AND r.state = 'TERMINAL'
  AND r.completed_at < now() - interval '30 days'
  AND c.checkpoint_id NOT IN (
    SELECT checkpoint_id FROM langgraph.checkpoints
    WHERE thread_id = c.thread_id
    ORDER BY checkpoint_id DESC LIMIT 20);
```

**注意**：裁剪会破坏 checkpoint 时间旅行能力，但 `kernel.events` 的哈希链仍然完整，审计不受影响。这正是「Kernel 是唯一可信数据源」的价值 —— checkpoint 可以裁，事实不能裁。
