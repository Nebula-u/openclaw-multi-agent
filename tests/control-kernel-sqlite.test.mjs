import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openKernelDatabase, resolveKernelConfig } from '../scripts/control-kernel/database.mjs';

test('SQLite kernel initializes eight fact tables with durable local pragmas', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-sqlite-'));
  const databasePath = join(root, 'control', 'kernel.db');
  const database = openKernelDatabase({ databasePath });
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });

  const tables = database.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((row) => row.name);
  assert.deepEqual(tables, ['approvals', 'artifacts', 'executions', 'hr_jobs', 'notifications', 'runs', 'snapshots', 'tasks']);
  assert.equal(database.get('PRAGMA foreign_keys').foreign_keys, 1);
  assert.equal(database.get('PRAGMA journal_mode').journal_mode, 'wal');
  assert.equal(database.get('PRAGMA synchronous').synchronous, 2);
  const runColumns = database.all("PRAGMA table_info('runs')").map((row) => row.name);
  assert.equal(runColumns.includes('workflow_id'), true);
  assert.equal(runColumns.includes('langgraph_thread_id'), false);
  assert.equal(database.get('PRAGMA user_version').user_version, 1);
});

test('SQLite kernel migrates the legacy LangGraph run column without losing facts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-legacy-'));
  const databasePath = join(root, 'kernel.db');
  const schema = readFileSync(new URL('../scripts/control-kernel/schema.sql', import.meta.url), 'utf8');
  const legacySchema = schema.replace('  run_id TEXT PRIMARY KEY,', '  run_id TEXT PRIMARY KEY,\n  langgraph_thread_id TEXT NOT NULL UNIQUE,');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(legacySchema);
  legacy.prepare(`INSERT INTO runs (
    run_id, langgraph_thread_id, workflow_id, state, request, request_sha256,
    target_project_root_abs, base_commit, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'RUN-legacy', 'WF-legacy', 'WF-legacy', 'ACTIVE', '{}', 'a'.repeat(64),
    'F:/repo', '1'.repeat(40), '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
  );
  legacy.prepare(`INSERT INTO tasks (
    task_id, run_id, kind, step_id, title, agent_id, state, task_group_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'TASK-legacy', 'RUN-legacy', 'REQUIREMENTS', 'requirements', 'Requirements',
    'requirement-agent', 'READY', 'RUN-legacy:requirements',
    '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z',
  );
  legacy.close();

  const database = openKernelDatabase({ databasePath });
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });

  assert.equal(database.get('PRAGMA user_version').user_version, 1);
  assert.equal(database.all("PRAGMA table_info('runs')").some((column) => column.name === 'langgraph_thread_id'), false);
  assert.equal(database.get('SELECT workflow_id FROM runs WHERE run_id=?', ['RUN-legacy']).workflow_id, 'WF-legacy');
  assert.equal(database.get('SELECT run_id FROM tasks WHERE task_id=?', ['TASK-legacy']).run_id, 'RUN-legacy');
  database.run(`INSERT INTO runs (
    run_id, workflow_id, state, request, request_sha256,
    target_project_root_abs, base_commit, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'RUN-current', 'WF-current', 'ACTIVE', '{}', 'b'.repeat(64),
    'F:/repo', '2'.repeat(40), '2026-08-22T00:00:00.000Z', '2026-08-22T00:00:00.000Z',
  ]);
  assert.equal(database.get('SELECT COUNT(*) AS count FROM runs').count, 2);
});

test('SQLite kernel config defaults below runtime/control and has no PostgreSQL fields', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kernel-config-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const config = resolveKernelConfig({ projectRoot });
  assert.equal(config.databasePath, join(projectRoot, 'runtime', 'control', 'kernel.db'));
  assert.equal(config.busyTimeoutMs, 5000);
  assert.equal(config.testSandboxEnabled, true);
  writeFileSync(join(projectRoot, '.env'), 'OPENCLAW_TEST_SANDBOX_ENABLED=false\n');
  assert.equal(resolveKernelConfig({ projectRoot }).testSandboxEnabled, false);
  assert.throws(() => resolveKernelConfig({ projectRoot, testSandboxEnabled: 'sometimes' }),
    (error) => error.code === 'ENVIRONMENT_BOOLEAN_INVALID');
  assert.equal('url' in config, false);
  assert.equal('kernelSchema' in config, false);
  assert.equal(resolveKernelConfig({ projectRoot, databasePath: 'custom/kernel.db' }).databasePath,
    join(projectRoot, 'custom', 'kernel.db'));
  assert.equal(resolveKernelConfig({ projectRoot, runtimeRoot: join(projectRoot, 'alternate-runtime') }).databasePath,
    join(projectRoot, 'alternate-runtime', 'control', 'kernel.db'));
  assert.throws(() => resolveKernelConfig({ projectRoot, databasePath: '\\\\server\\share\\kernel.db' }),
    (error) => error.code === 'KERNEL_DB_NETWORK_PATH_FORBIDDEN');
});

test('a second connection can read WAL facts but readonly mode rejects writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-connections-')); const databasePath = join(root, 'kernel.db');
  const writer = openKernelDatabase({ databasePath });
  const reader = openKernelDatabase({ databasePath, readonly: true, initialize: false });
  t.after(() => { reader.close(); writer.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(reader.get("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='snapshots'").count, 1);
  assert.throws(() => reader.run("INSERT INTO runs (run_id,workflow_id,state,request,request_sha256,target_project_root_abs,base_commit,created_at,updated_at) VALUES ('RUN-x','WF-x','ACTIVE','{}',?,'F:/repo',?,datetime('now'),datetime('now'))", ['a'.repeat(64), '1'.repeat(40)]), /readonly|read-only/iu);
});

test('Kernel run contract uses workflow identity without StateGraph compatibility fields', () => {
  const contract = JSON.parse(readFileSync(new URL('../contracts/kernel-run.schema.json', import.meta.url), 'utf8'));
  assert.equal(contract.required.includes('workflow_id'), true);
  assert.equal(contract.required.includes('langgraph_thread_id'), false);
  assert.equal('workflow_id' in contract.properties, true);
  assert.equal('langgraph_thread_id' in contract.properties, false);
});
