// Thin wrapper around the REAL validator (scripts/runtime-guard.mjs).
// Every validation in this harness goes through the guard's `validate-file`
// command via a child process, so we exercise the exact production path an
// agent artifact would take, not a re-implemented validator.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
export const GUARD = join(PROJECT_ROOT, 'scripts', 'runtime-guard.mjs');
export const CONTRACTS = join(PROJECT_ROOT, 'contracts');

export function schemaPath(schemaFile) {
  return join(CONTRACTS, schemaFile);
}

function parseGuardProcess(proc) {
  let report;
  try {
    report = JSON.parse(proc.stdout);
  } catch {
    report = { ok: false, parseFailure: true, stdout: proc.stdout, stderr: proc.stderr };
  }
  return {
    ok: Boolean(report.ok),
    status: proc.status,
    errors: report.errors ?? [],
    codes: (report.errors ?? []).map((error) => error.code),
    report,
    stderr: proc.stderr,
  };
}

// Validate an artifact already written by an Agent. This is the production
// path used by the live harness; no JSON is reconstructed in this function.
export function validateFile(file, { schemaFile, jsonl = false, allowPlaceholders = false } = {}) {
  const args = ['validate-file', '--schema', schemaPath(schemaFile), '--file', file];
  if (jsonl) args.push('--jsonl');
  if (allowPlaceholders) args.push('--allow-placeholders');
  const proc = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  });
  return parseGuardProcess(proc);
}

// Serialize a value to the on-disk text an agent would emit.
// - object  -> pretty JSON
// - array + jsonl -> one JSON object per line
function serialize(value, jsonl) {
  if (jsonl) {
    const lines = Array.isArray(value) ? value : [value];
    return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  }
  // A raw string means "emit exactly this" (used for malformed-JSON cases).
  if (typeof value === 'string') return value;
  return `${JSON.stringify(value, null, 2)}\n`;
}

// Run the real guard against an in-memory artifact. Returns the parsed guard
// JSON report plus process metadata.
export function validate(value, { schemaFile, jsonl = false, allowPlaceholders = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-json-'));
  const file = join(dir, jsonl ? 'artifact.jsonl' : 'artifact.json');
  try {
    writeFileSync(file, serialize(value, jsonl), 'utf8');
    return validateFile(file, { schemaFile, jsonl, allowPlaceholders });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
