-- Control Kernel 数据库结构。
-- PostgreSQL 中的 kernel schema 是 workflow、task、execution 和审批事实的唯一来源。
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
    'READY','RUNNING','SUCCEEDED','FAILED','WAITING_HUMAN','CANCELLED'))
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

-- ══════════════════════════════════════════════════════════════
-- Orchestrator 最小 workflow 扩展。ALTER 均为向后兼容迁移：已存在的
-- StateGraph run 保留原字段，但新的 Orchestrator 不读取 checkpoint。
-- ══════════════════════════════════════════════════════════════
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS workflow_id TEXT;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS route_plan JSONB;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS current_step_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS manager_session_id TEXT;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS manager_session_key TEXT;
ALTER TABLE __KERNEL_SCHEMA__.runs ADD COLUMN IF NOT EXISTS manager_delivery JSONB;
UPDATE __KERNEL_SCHEMA__.runs SET workflow_id = langgraph_thread_id WHERE workflow_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_workflow_id_unique ON __KERNEL_SCHEMA__.runs(workflow_id);
ALTER TABLE __KERNEL_SCHEMA__.tasks ADD COLUMN IF NOT EXISTS task_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE __KERNEL_SCHEMA__.tasks ADD COLUMN IF NOT EXISTS context_manifest JSONB;

-- 旧运行时曾把派发细节暴露成 task state。它们没有可安全恢复的
-- Orchestrator 语义，因此先冻结对应 run，再把 task 标为失败并保留原因；
-- 这使最小对外状态约束可以在已有数据库上安全收紧。
UPDATE __KERNEL_SCHEMA__.runs AS run
SET state = 'HOLD', status_reason = 'LEGACY_TASK_STATE_REQUIRES_REVIEW', updated_at = now()
WHERE run.state <> 'TERMINAL'
  AND EXISTS (
    SELECT 1 FROM __KERNEL_SCHEMA__.tasks AS task
    WHERE task.run_id = run.run_id
      AND task.state IN ('REPAIR_READY', 'DISPATCHED', 'STARTING')
  );

UPDATE __KERNEL_SCHEMA__.tasks
SET state = 'FAILED',
    last_error = COALESCE(last_error, '{}'::jsonb) || jsonb_build_object(
      'code', 'LEGACY_TASK_STATE_REQUIRES_REVIEW',
      'legacy_state', state
    ),
    updated_at = now()
WHERE state IN ('REPAIR_READY', 'DISPATCHED', 'STARTING');

ALTER TABLE __KERNEL_SCHEMA__.tasks DROP CONSTRAINT IF EXISTS tasks_state_check;
ALTER TABLE __KERNEL_SCHEMA__.tasks ADD CONSTRAINT tasks_state_check
  CHECK (state IN ('READY','RUNNING','SUCCEEDED','FAILED','WAITING_HUMAN','CANCELLED'));

CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.approvals (
  decision_id     TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES __KERNEL_SCHEMA__.tasks(task_id) ON DELETE SET NULL,
  step_id         TEXT,
  trigger         TEXT NOT NULL,
  request         JSONB NOT NULL,
  response        JSONB,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  CONSTRAINT approvals_status_check CHECK (status IN ('PENDING','RESOLVED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS approvals_run_status ON __KERNEL_SCHEMA__.approvals(run_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.notifications (
  notification_id TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES __KERNEL_SCHEMA__.tasks(task_id) ON DELETE SET NULL,
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  CONSTRAINT notifications_status_check CHECK (status IN ('PENDING','SENT','DELIVERED','FAILED'))
);
CREATE INDEX IF NOT EXISTS notifications_pending ON __KERNEL_SCHEMA__.notifications(status, created_at)
  WHERE status IN ('PENDING','FAILED');

CREATE TABLE IF NOT EXISTS __KERNEL_SCHEMA__.hr_jobs (
  job_id          TEXT PRIMARY KEY,
  run_id          TEXT REFERENCES __KERNEL_SCHEMA__.runs(run_id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES __KERNEL_SCHEMA__.tasks(task_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  source_agent_id TEXT,
  source_session_id TEXT,
  source_event_id TEXT,
  input           JSONB NOT NULL,
  hr_session_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  CONSTRAINT hr_jobs_kind_check CHECK (kind IN ('OUTPUT_REVIEW','TASK_DAILY_REPORT')),
  CONSTRAINT hr_jobs_status_check CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED'))
);
CREATE INDEX IF NOT EXISTS hr_jobs_pending ON __KERNEL_SCHEMA__.hr_jobs(status, created_at)
  WHERE status IN ('PENDING','FAILED');
