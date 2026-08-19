import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { storeCasArtifact } from '../scripts/stategraph/output-ingestion.mjs';

test('CAS stores an artifact by SHA-256 and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'control-kernel-cas-'));
  try {
    const source = join(root, 'source.json');
    mkdirSync(join(root, 'runtime', 'artifacts'), { recursive: true });
    writeFileSync(source, '{"ok":true}\n', 'utf8');
    const first = storeCasArtifact(root, source);
    const second = storeCasArtifact(root, source);
    assert.equal(first.sha256, second.sha256);
    assert.equal(first.path_abs, second.path_abs);
    assert.equal(readFileSync(first.path_abs, 'utf8'), readFileSync(source, 'utf8'));
    assert.match(first.path_abs, /runtime[\\/]artifacts[\\/]cas[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
