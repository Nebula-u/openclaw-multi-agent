import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});

test('SQLite kernel config defaults below runtime/control and has no PostgreSQL fields', (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'kernel-config-'));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const config = resolveKernelConfig({ projectRoot });
  assert.equal(config.databasePath, join(projectRoot, 'runtime', 'control', 'kernel.db'));
  assert.equal(config.busyTimeoutMs, 5000);
  assert.equal('url' in config, false);
  assert.equal('kernelSchema' in config, false);
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
