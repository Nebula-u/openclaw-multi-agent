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
const BASH_AVAILABLE = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' }).status === 0;
const PWSH_AVAILABLE = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
  encoding: 'utf8',
}).status === 0;

test('installers materialize an explicit empty worker delegation allowlist', () => {
  const powershell = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  const bash = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
  assert.match(powershell, /\$currentHasSubagents -and \$allowMatches/u);
  assert.match(powershell, /agents\.list\[\$idx\]\.subagents/u);
  assert.match(powershell, /function Get-OpenClawAgentsWithFallback/u);
  assert.match(powershell, /function Resolve-OpenClawConfigFilePath/u);
  assert.match(powershell, /\$candidate = \$Result\.Output\.Trim\(\)[\s\S]*?\$candidate\.StartsWith\('~'\)[\s\S]*?Join-Path \$HOME/u);
  assert.match(powershell, /function Remove-RetiredStateGraphWebChatReferences/u);
  assert.match(powershell, /remove retired stategraph-webchat plugin references/u);
  assert.match(powershell, /agents\.list 后备配置输出/u);
  assert.match(powershell, /delegationMode = 'prefer'/u);
  assert.doesNotMatch(powershell, /delegationMode = 'off'/u);
  assert.match(bash, /set_json "agents\.list\[\$idx\]\.subagents"/u);
  assert.match(bash, /ALLOW_JSON\[\$id\]/u);
  assert.match(bash, /remove_retired_stategraph_webchat_config/u);
  assert.match(bash, /jq -c '\.agents\.list \/\/ \[\]'/u);
});

test('install validators provision the temporary OpenClaw config they report', () => {
  const powershell = readFileSync(POWERSHELL_VALIDATOR, 'utf8');
  const bash = readFileSync(VALIDATOR, 'utf8');
  assert.match(powershell, /\$validationConfig = Join-Path \$validationBin 'validation-openclaw-config\.json'/u);
  assert.match(bash, /VALIDATION_OPENCLAW_CONFIG="\$VALIDATION_OPENCLAW_BIN\/validation-openclaw-config\.json"/u);
});

test('install validators accept and forward the documented runtime-root parameter', () => {
  const powershell = readFileSync(POWERSHELL_VALIDATOR, 'utf8');
  const bash = readFileSync(VALIDATOR, 'utf8');
  assert.match(powershell, /\[string\]\$RuntimeRoot = 'runtime'/u);
  assert.match(powershell, /-RuntimeRoot \$RuntimeRoot/u);
  assert.match(bash, /--runtime-root\) RUNTIME_ROOT=/u);
  assert.match(bash, /--runtime-root "\$RUNTIME_ROOT"/u);
});

test('install validators require the Node version that provides stable node:sqlite', () => {
  const powershell = readFileSync(POWERSHELL_VALIDATOR, 'utf8');
  const bash = readFileSync(VALIDATOR, 'utf8');
  assert.match(powershell, /22\.13\.0/u);
  assert.match(powershell, /Node\.js 22\.13\.0\+/u);
  assert.match(bash, /22\.13\.0/u);
  assert.match(bash, /Node\.js 22\.13\.0\+/u);
});

test('active architecture documents describe Orchestrator dispatch, SQLite, and the Docker test sandbox', () => {
  const configNotes = readFileSync(join(ROOT, 'config', 'openclaw-config-notes.md'), 'utf8');
  const nativeIntegration = readFileSync(join(ROOT, 'docs', 'native-openclaw-integration.md'), 'utf8');
  const compatibility = readFileSync(join(ROOT, 'docs', 'compatibility-report.md'), 'utf8');
  const jsonFlow = readFileSync(join(ROOT, 'docs', 'architect', 'JSON处理流程.md'), 'utf8');
  const deliveryReport = readFileSync(join(ROOT, 'DELIVERY-REPORT.md'), 'utf8');
  const modelRouting = readFileSync(join(ROOT, 'docs', 'model-routing.md'), 'utf8');
  const resultContract = JSON.parse(readFileSync(join(ROOT, 'contracts', 'result.schema.json'), 'utf8'));

  assert.match(configNotes, /Manager.*Node Orchestrator/su);
  assert.match(configNotes, /test-agent.*sandbox\.mode.*all.*docker/isu);
  assert.doesNotMatch(configNotes, /本项目 test-agent 用 "off"/u);
  assert.match(nativeIntegration, /Manager.*不.*sessions_spawn/su);
  assert.doesNotMatch(nativeIntegration, /manager-agent` 调度依赖的原生会话工具/u);
  assert.match(compatibility, /当前架构.*Node Orchestrator.*SQLite/su);
  assert.match(jsonFlow, /SQLite.*runs.*tasks.*executions/su);
  assert.doesNotMatch(jsonFlow, /PostgreSQL 创建\/更新 workflow、task、event/u);
  assert.match(deliveryReport, /历史交付快照.*不代表当前架构/su);
  assert.match(modelRouting, /manager-agent.*用户交互.*路线确认/su);
  assert.doesNotMatch(resultContract.properties.summary_for_manager.description, /Manager.*调度/u);
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

test('Bash validator isolates its installer dry-run from conflicting outer openclaw agents', {
  skip: BASH_AVAILABLE ? false : 'bash unavailable in this environment',
}, () => {
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
