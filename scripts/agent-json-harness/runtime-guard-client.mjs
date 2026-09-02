import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestJsonText } from '../runtime-core/json-ingestion.mjs';

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
    let content = response ?? '';
    let ingestion = null;
    if (typeof response === 'string' && response.trim()) {
      try {
        ingestion = ingestJsonText(response, { jsonl: Boolean(scenario.jsonl) });
        content = ingestion.text;
      } catch (error) {
        // Preserve raw text: Runtime Guard produces the canonical parse error and failure package.
        ingestion = {
          raw_sha256: createHash('sha256').update(response, 'utf8').digest('hex'),
          cleaned_sha256: null,
          transformations: [],
          error: { diagnostic: error.diagnostic ?? 'JSON_PARSE_ERROR', message: error.message },
        };
      }
    }
    writeFileSync(artifact, content, 'utf8');
    const args = ['validate-file', '--schema', join(PROJECT_ROOT, 'contracts', scenario.schemaFile), '--file', artifact];
    if (scenario.jsonl) args.push('--jsonl');
    return {
      ...invoke(args),
      ingestion: ingestion ? {
        raw_sha256: ingestion.raw_sha256,
        cleaned_sha256: ingestion.cleaned_sha256,
        cleaned_text: ingestion.text ?? null,
        transformations: ingestion.transformations,
        error: ingestion.error ?? null,
      } : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
