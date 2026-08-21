import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'scripts', 'orchestrator-cli.mjs');

function invoke(args, environment) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...environment } });
  return { ...result, json: JSON.parse(result.stdout) };
}

test('CLI initializes an empty SQLite kernel and manual HR remains available in auto-off mode', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'orchestrator-cli-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const environment = { OPENCLAW_KERNEL_DB_PATH: join(temp, 'kernel.db'), OPENCLAW_SESSION_ROOT: join(temp, 'sessions'), OPENCLAW_HR_AUTO_MODE: 'off' };
  const initialized = invoke(['init', '--project-root', ROOT], environment);
  assert.equal(initialized.status, 0, initialized.stderr); assert.equal(initialized.json.runtime, 'orchestrator-sqlite');
  const status = invoke(['kernel-status', '--project-root', ROOT], environment);
  assert.equal(status.status, 0, status.stderr); assert.equal(status.json.journal_mode, 'wal'); assert.equal(status.json.tables.length, 8);
  const manual = invoke(['hr-review', '--project-root', ROOT, '--date', '2026-08-21'], environment);
  assert.equal(manual.status, 0, manual.stderr); assert.deepEqual(manual.json.queued, []); assert.deepEqual(manual.json.jobs, []);
});

test('CLI snapshot revert requires exact confirmation before snapshot lookup', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'orchestrator-cli-confirm-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const environment = { OPENCLAW_KERNEL_DB_PATH: join(temp, 'kernel.db') };
  assert.equal(invoke(['init', '--project-root', ROOT], environment).status, 0);
  const result = invoke(['snapshot-revert', '--project-root', ROOT, '--snapshot-id', 'SNP-missing'], environment);
  assert.equal(result.status, 1); assert.equal(result.json.error.code, 'SNAPSHOT_REVERT_CONFIRMATION_REQUIRED');
});
