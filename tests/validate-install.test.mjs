import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(ROOT, 'scripts', 'validate-install.sh');
const DRY_MANIFEST = join(ROOT, 'artifacts', 'install-dryrun', 'install-manifest.dryrun.json');

test('Bash validator isolates its installer dry-run from conflicting outer openclaw agents', () => {
  const bin = mkdtempSync(join(tmpdir(), 'openclaw-validator-fake-bin-'));
  const fakeOpenClaw = join(bin, 'openclaw');
  const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;

  try {
    writeFileSync(fakeOpenClaw, `#!/usr/bin/env bash
case "\${1:-}" in
  --version) printf 'fake-openclaw 0\\n' ;;
  config) printf '/tmp/fake-openclaw-config.json\\n' ;;
  agents) printf '[{"id":"manager-agent","workspace":"/host/conflicting-runtime/manager-agent"}]\\n' ;;
  *) exit 0 ;;
esac
    `, 'utf8');
    chmodSync(fakeOpenClaw, 0o755);
    mkdirSync(dirname(DRY_MANIFEST), { recursive: true });
    writeFileSync(DRY_MANIFEST, '{"schema_version":999}\n', 'utf8');

    const result = spawnSync('bash', [VALIDATOR, '--skip-openclaw'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[PASS\].*install\.sh 非项目 cwd dry-run 可执行/);
    const manifest = JSON.parse(readFileSync(DRY_MANIFEST, 'utf8'));
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.project_root_abs, ROOT);
  } finally {
    if (previousManifest === null) {
      rmSync(DRY_MANIFEST, { force: true });
    } else {
      writeFileSync(DRY_MANIFEST, previousManifest);
    }
    rmSync(bin, { recursive: true, force: true });
  }
});
