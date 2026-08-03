import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..', '..');
const GUARD = join(PROJECT_ROOT, 'scripts', 'runtime-guard.mjs');

function invoke(args) {
  const proc = spawnSync(process.execPath, [GUARD, ...args], { cwd: PROJECT_ROOT, encoding: 'utf8' });
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return {
      ok: false,
      errors: [{
        code: 'HARNESS_GUARD_PROCESS_ERROR', path: '$',
        message: proc.stderr.trim() || 'Runtime Guard did not emit JSON.',
      }],
    };
  }
}

export function assertRuntimeGuardReady() {
  const result = invoke(['self-check', '--project-root', PROJECT_ROOT]);
  if (!result.ok) throw new Error(`Runtime Guard preflight failed: ${JSON.stringify(result.errors)}`);
}

export function validateLlmResponse(response, scenario) {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-llm-json-'));
  const artifact = join(directory, scenario.jsonl ? 'response.jsonl' : 'response.json');
  try {
    writeFileSync(artifact, response ?? '', 'utf8');
    const args = ['validate-file', '--schema', join(PROJECT_ROOT, 'contracts', scenario.schemaFile), '--file', artifact];
    if (scenario.jsonl) args.push('--jsonl');
    return invoke(args);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
