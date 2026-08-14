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
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(ROOT, 'scripts', 'validate-install.sh');
const POWERSHELL_VALIDATOR = join(ROOT, 'scripts', 'validate-install.ps1');
const DRY_MANIFEST = join(ROOT, 'artifacts', 'install-dryrun', 'install-manifest.dryrun.json');
const PWSH_AVAILABLE = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
  encoding: 'utf8',
}).status === 0;

test('installers materialize an explicit empty worker delegation allowlist', () => {
  const powershell = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  const bash = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
  assert.match(powershell, /\$currentHasSubagents -and \$allowMatches/u);
  assert.match(powershell, /agents\.list\[\$idx\]\.subagents/u);
  assert.match(powershell, /function Get-OpenClawAgentsWithFallback/u);
  assert.match(powershell, /agents\.list 后备配置输出/u);
  assert.match(bash, /set_json "agents\.list\[\$idx\]\.subagents"/u);
  assert.match(bash, /ALLOW_JSON\[\$id\]/u);
});

test('installers synchronize model catalog limits and protect raw artifact storage', () => {
  const powershell = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  const componentLib = readFileSync(join(ROOT, 'scripts', 'component-lib.ps1'), 'utf8');
  const bash = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
  assert.match(powershell, /function Sync-ModelCatalog/u);
  assert.match(powershell, /models\.providers\.\$provider\.models\[\$modelIndex\]\.contextWindow/u);
  assert.match(powershell, /Set-RawArtifactAccessControl/u);
  assert.match(componentLib, /SetAccessRuleProtection\(\$true, \$false\)/u);
  assert.match(componentLib, /OPENCLAW_LLM_CONTEXT_WINDOW_TOKENS' -Default '200000'/u);
  assert.match(componentLib, /OPENCLAW_LLM_MAX_OUTPUT_TOKENS' -Default '32000'/u);
  assert.match(bash, /MODEL_SYNC_SEEN/u);
  assert.match(bash, /ARTIFACT_ACL_MODE="protected-dacl"/u);
  assert.match(bash, /chmod 700 "\$ARTIFACT_ROOT"/u);
});

test(
  'PowerShell artifact ACL helper applies and verifies the platform protection',
  { skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment' },
  () => {
    const temp = mkdtempSync(join(tmpdir(), 'openclaw-artifact-acl-'));
    try {
      const result = spawnSync('pwsh', [
        '-NoProfile',
        '-Command',
        '. $env:COMPONENT_LIB; Set-RawArtifactAccessControl -Path $env:ARTIFACT_ROOT | ConvertTo-Json -Compress',
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPONENT_LIB: join(ROOT, 'scripts', 'component-lib.ps1'),
          ARTIFACT_ROOT: temp,
        },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const acl = JSON.parse(result.stdout.trim());
      assert.equal(acl.protected, true);
      assert.equal(acl.mode, process.platform === 'win32' ? 'protected-dacl' : '0700');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

test('project Agent reinstall requires an explicit stopped-Gateway acknowledgement and deletes only verified runtime paths', () => {
  const reinstall = readFileSync(join(ROOT, 'scripts', 'reinstall-agents.ps1'), 'utf8');
  assert.match(reinstall, /\[switch\]\$GatewayStopped/u);
  assert.match(reinstall, /if \(-not \$GatewayStopped\)/u);
  assert.match(reinstall, /Assert-ManagedAgentIdentity/u);
  assert.match(reinstall, /function Remove-ManagedRuntimeDirectory/u);
  assert.match(reinstall, /Test-PathWithin -Path \$pathAbs -Root \$RuntimeRootAbs/u);
  assert.match(reinstall, /'agents','delete',\$AgentId,'--force','--json'/u);
  assert.match(reinstall, /reinstall-result\.json/u);
});

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
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[PASS\].*install\.sh 非项目 cwd dry-run 可执行/);
    const manifest = JSON.parse(readFileSync(DRY_MANIFEST, 'utf8'));
    assert.equal(manifest.schema_version, 2);
    assert.equal(manifest.project_root_abs, ROOT);
    assert.equal(manifest.artifact_access_control.applied, false);
    assert.ok(manifest.agents.every((agent) => agent.context_window_tokens === 200000));
    assert.ok(manifest.agents.every((agent) => agent.max_output_tokens === 32000));
    assert.ok(manifest.agents.every((agent) => agent.max_tokens_field === 'max_output_tokens'));
  } finally {
    if (previousManifest === null) {
      rmSync(DRY_MANIFEST, { force: true });
    } else {
      writeFileSync(DRY_MANIFEST, previousManifest);
    }
    rmSync(bin, { recursive: true, force: true });
  }
});

test(
  'PowerShell validator isolates its installer dry-run from conflicting outer openclaw agents',
  { skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment' },
  () => {
    const bin = mkdtempSync(join(tmpdir(), 'openclaw-validator-fake-bin-'));
    const fakeOpenClaw = join(bin, 'openclaw');
    const fakeOpenClawCmd = join(bin, 'openclaw.cmd');
    const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;

    try {
      writeFileSync(fakeOpenClaw, `#!/usr/bin/env sh
case "\${1:-}" in
  --version) printf 'fake-openclaw 0\\n' ;;
  config) printf '/tmp/fake-openclaw-config.json\\n' ;;
  agents) printf '[{"id":"manager-agent","workspace":"/host/conflicting-runtime/manager-agent"}]\\n' ;;
  *) exit 0 ;;
esac
`, 'utf8');
      chmodSync(fakeOpenClaw, 0o755);
      writeFileSync(fakeOpenClawCmd, `@echo off
if "%~1"=="--version" (echo fake-openclaw 0 & exit /b 0)
if "%~1"=="config" (echo C:\\fake-openclaw-config.json & exit /b 0)
if "%~1"=="agents" (echo [{"id":"manager-agent","workspace":"C:\\host\\conflicting-runtime\\manager-agent"}] & exit /b 0)
exit /b 0
`, 'utf8');
      mkdirSync(dirname(DRY_MANIFEST), { recursive: true });
      writeFileSync(DRY_MANIFEST, '{"schema_version":999}\n', 'utf8');

      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', POWERSHELL_VALIDATOR, '-SkipOpenClaw'],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
        },
      );

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /\[PASS\].*install\.ps1 非项目 cwd dry-run 可执行/);
      const manifest = JSON.parse(readFileSync(DRY_MANIFEST, 'utf8'));
      assert.equal(manifest.schema_version, 2);
      assert.equal(manifest.project_root_abs, ROOT);
      assert.equal(manifest.artifact_access_control.applied, false);
      assert.ok(manifest.agents.every((agent) => agent.context_window_tokens === 200000));
      assert.ok(manifest.agents.every((agent) => agent.max_output_tokens === 32000));
      assert.ok(manifest.agents.every((agent) => agent.max_tokens_field === 'max_output_tokens'));
    } finally {
      if (previousManifest === null) {
        rmSync(DRY_MANIFEST, { force: true });
      } else {
        writeFileSync(DRY_MANIFEST, previousManifest);
      }
      rmSync(bin, { recursive: true, force: true });
    }
  },
);
