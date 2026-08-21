CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','WAITING_HUMAN','HOLD','TERMINAL')),
  outcome TEXT,
  status_reason TEXT,
  request TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  target_project_root_abs TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  candidate_commit TEXT,
  route_hash TEXT,
  route_plan TEXT,
  current_step_index INTEGER NOT NULL DEFAULT 0,
  manager_session_id TEXT,
  manager_session_key TEXT,
  manager_delivery TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_state_updated ON runs(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  step_id TEXT NOT NULL,
  title TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','RUNNING','SUCCEEDED','FAILED','WAITING_HUMAN','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 1,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  json_regenerations INTEGER NOT NULL DEFAULT 0,
  execution_round INTEGER NOT NULL DEFAULT 1,
  route_hash TEXT,
  input_commit TEXT,
  task_group_id TEXT NOT NULL,
  parallel_slot INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  task_payload TEXT NOT NULL DEFAULT '{}',
  context_manifest TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_run ON tasks(run_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state) WHERE state IN ('READY','RUNNING');
CREATE INDEX IF NOT EXISTS tasks_group ON tasks(task_group_id);

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  cycle INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'LEASED' CHECK (state IN ('LEASED','RUNNING','SUCCEEDED','FAILED','LEASE_EXPIRED','CANCELLED')),
  phase TEXT,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  pid INTEGER,
  worktree_path_abs TEXT,
  artifact_root_abs TEXT,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_code INTEGER,
  error TEXT,
  sandbox_attestation TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS executions_active_lease ON executions(task_id) WHERE state IN ('LEASED','RUNNING');
CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id, attempt, cycle);
CREATE INDEX IF NOT EXISTS executions_run ON executions(run_id, started_at DESC);
CREATE INDEX IF NOT EXISTS executions_reap ON executions(lease_expires_at) WHERE state IN ('LEASED','RUNNING');

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES executions(execution_id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ROUTE_PLAN','RESULT','EVIDENCE','GATE_RESULT','COMMAND_RECORD','CONTEXT_MANIFEST','INGESTION_RECEIPT','REVIEW_FINDINGS','RELEASE_DECISION','RAW_OUTPUT','LOG')),
  uri TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'application/json',
  commit_sha TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task ON artifacts(task_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_sha ON artifacts(sha256);

CREATE TABLE IF NOT EXISTS approvals (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  step_id TEXT,
  trigger TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','CANCELLED')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS approvals_run_status ON approvals(run_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DELIVERED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(status, created_at) WHERE status IN ('PENDING','FAILED');

CREATE TABLE IF NOT EXISTS hr_jobs (
  job_id TEXT PRIMARY KEY,
  review_key TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(task_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SESSION_REVIEW','TASK_REVIEW','DAILY_REVIEW')),
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('MANUAL','AUTO_TASK','AUTO_DAILY')),
  source_agent_id TEXT,
  source_session_id TEXT,
  input TEXT NOT NULL,
  result TEXT,
  hr_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS hr_jobs_pending ON hr_jobs(status, created_at) WHERE status IN ('PENDING','FAILED');
CREATE INDEX IF NOT EXISTS hr_jobs_scope ON hr_jobs(run_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES executions(execution_id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  input_commit TEXT NOT NULL,
  output_commit TEXT NOT NULL,
  parent_snapshot_id TEXT REFERENCES snapshots(snapshot_id) ON DELETE SET NULL,
  git_ref TEXT NOT NULL UNIQUE,
  snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('ACCEPTED','FAILED_RECOVERY','NO_CHANGE','RESTORE','REVERT')),
  change_summary TEXT NOT NULL,
  worktree_path_abs TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_run ON snapshots(run_id, created_at);
CREATE INDEX IF NOT EXISTS snapshots_task ON snapshots(task_id, attempt, created_at);
CREATE INDEX IF NOT EXISTS snapshots_session ON snapshots(agent_id, session_id, created_at);
