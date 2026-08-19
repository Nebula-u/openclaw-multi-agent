import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const GUARD = join(ROOT, 'scripts', 'runtime-guard.mjs');

function runGuard(args) {
  const result = spawnSync(process.execPath, [GUARD, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-artifact-guard-'));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('self-check compiles the v2 contract and current template set', () => {
  const result = runGuard(['self-check', '--project-root', ROOT]);
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.command, 'self-check');
  assert.ok(result.json.contracts > 0);
  assert.ok(result.json.templates > 0);
});

test('validate-file accepts a valid JSON artifact', () => {
  const value = fixture();
  try {
    const schema = join(value.directory, 'sample.schema.json');
    const file = join(value.directory, 'sample.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }));
    writeFileSync(file, JSON.stringify({ id: 'A-1' }));
    const result = runGuard(['validate-file', '--schema', schema, '--file', file]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, { ok: true, command: 'validate-file', file, validator: 'ajv', records: 1 });
  } finally {
    value.cleanup();
  }
});

test('validate-file rejects invalid JSON and records structured errors', () => {
  const value = fixture();
  try {
    const schema = join(value.directory, 'sample.schema.json');
    const file = join(value.directory, 'sample.json');
    const log = join(value.directory, 'raw-logs', 'validation-errors.jsonl');
    writeFileSync(schema, JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }));
    writeFileSync(file, JSON.stringify({ id: 1 }));
    const result = runGuard(['validate-file', '--schema', schema, '--file', file, '--log-file', log, '--stage', 'agent_self_validation']);
    assert.equal(result.status, 1);
    assert.equal(result.json.ok, false);
    assert.ok(result.json.errors.some((error) => error.code === 'SCHEMA_TYPE'));
    const record = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(record.stage, 'agent_self_validation');
    assert.equal(record.final_status, 'FAILED');
    assert.match(record.invalid_content_sha256, /^[a-f0-9]{64}$/u);
  } finally {
    value.cleanup();
  }
});

test('validate-file rejects duplicate IDs in evidence JSONL', () => {
  const value = fixture();
  try {
    const schema = join(value.directory, 'evidence.schema.json');
    const file = join(value.directory, 'evidence.jsonl');
    writeFileSync(schema, JSON.stringify({ type: 'object', required: ['evidence_id'], properties: { evidence_id: { type: 'string' } } }));
    writeFileSync(file, '{"evidence_id":"E-1"}\n{"evidence_id":"E-1"}\n');
    const result = runGuard(['validate-file', '--schema', schema, '--file', file, '--jsonl']);
    assert.equal(result.status, 1);
    assert.ok(result.json.errors.some((error) => error.code === 'JSONL_DUPLICATE_ID'));
  } finally {
    value.cleanup();
  }
});

test('placeholders are rejected by default and allowed only explicitly', () => {
  const value = fixture();
  try {
    const schema = join(value.directory, 'sample.schema.json');
    const file = join(value.directory, 'sample.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', required: ['value'], properties: { value: { type: 'string' } } }));
    writeFileSync(file, JSON.stringify({ value: '<PLACEHOLDER:VALUE>' }));
    const rejected = runGuard(['validate-file', '--schema', schema, '--file', file]);
    assert.equal(rejected.status, 1);
    assert.ok(rejected.json.errors.some((error) => error.code === 'RUNTIME_PLACEHOLDER'));
    const allowed = runGuard(['validate-file', '--schema', schema, '--file', file, '--allow-placeholders']);
    assert.equal(allowed.status, 0);
  } finally {
    value.cleanup();
  }
});
