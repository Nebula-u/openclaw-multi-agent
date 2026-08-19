-- Control Kernel + LangGraph Checkpointer 数据库结构
-- 一个数据库实例、两个 schema：__KERNEL_SCHEMA__ 存事实，__LANGGRAPH_SCHEMA__ 存决策投影。
-- 全部 DDL 幂等（CREATE ... IF NOT EXISTS），可重复 apply。
-- schema 名以占位符注入，由 apply-schema.mjs / pool.mjs 在运行时替换。

-- ══════════════════════════════════════════════════════════════
-- kernel schema：Control Kernel，唯一可信数据源
-- ══════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS __KERNEL_SCHEMA__;

-- ══════════════════════════════════════════════════════════════
-- runs
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.runs (
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
  ON __KERNEL_SCHEMA__.runs(state, updated_at DESC);

-- ══════════════════════════════════════════════════════════════
-- tasks
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.tasks (
  task_id              TEXT        PRIMARY KEY,
  run_id               TEXT        NOT NULL
                         REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS tasks_run       ON __KERNEL_SCHEMA__.tasks(run_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_state     ON __KERNEL_SCHEMA__.tasks(state)
  WHERE state IN ('READY','REPAIR_READY','DISPATCHED','STARTING','RUNNING');
CREATE INDEX IF NOT EXISTS tasks_group     ON __KERNEL_SCHEMA__.tasks(task_group_id);

-- ══════════════════════════════════════════════════════════════
-- executions  ← worker_id / heartbeat / lease / attempt
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.executions (
  execution_id          TEXT        PRIMARY KEY,
  task_id               TEXT        NOT NULL
                          REFERENCES __KERNEL_SCHEMA__.tasks(task_id) ON DELETE CASCADE,
  run_id                TEXT        NOT NULL
                          REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
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
  ON __KERNEL_SCHEMA__.executions(task_id)
  WHERE state IN ('LEASED','RUNNING');

CREATE INDEX IF NOT EXISTS executions_task     ON __KERNEL_SCHEMA__.executions(task_id, attempt, cycle);
CREATE INDEX IF NOT EXISTS executions_run      ON __KERNEL_SCHEMA__.executions(run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS executions_reap     ON __KERNEL_SCHEMA__.executions(lease_expires_at)
  WHERE state IN ('LEASED','RUNNING');
CREATE INDEX IF NOT EXISTS executions_worker   ON __KERNEL_SCHEMA__.executions(worker_id, state);

-- ══════════════════════════════════════════════════════════════
-- artifacts  ← artifact_id / uri / hash
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.artifacts (
  artifact_id    TEXT        PRIMARY KEY,
  run_id         TEXT        NOT NULL
                   REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
  task_id        TEXT        NOT NULL
                   REFERENCES __KERNEL_SCHEMA__.tasks(task_id) ON DELETE CASCADE,
  execution_id   TEXT        REFERENCES __KERNEL_SCHEMA__.executions(execution_id) ON DELETE SET NULL,
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

CREATE INDEX IF NOT EXISTS artifacts_task ON __KERNEL_SCHEMA__.artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_run  ON __KERNEL_SCHEMA__.artifacts(run_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_sha  ON __KERNEL_SCHEMA__.artifacts(sha256);

-- ══════════════════════════════════════════════════════════════
-- events  ← 哈希链账本
-- ══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.events (
  event_seq      BIGSERIAL   PRIMARY KEY,
  event_id       TEXT        NOT NULL UNIQUE,
  run_id         TEXT        NOT NULL
                   REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
  task_id        TEXT,
  execution_id   TEXT,
  type           TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  prev_hash      TEXT,
  event_hash     TEXT        NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT events_hash_check CHECK (event_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS events_run ON __KERNEL_SCHEMA__.events(run_id, event_seq);
