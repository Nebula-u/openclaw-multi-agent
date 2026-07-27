#requires -Version 7.0
<#
.SYNOPSIS
  按 Agent package manifest 安装/同步 OpenClaw Agent。
.DESCRIPTION
  默认 dry-run。Agent ID、workspace、角色、sandbox 与 manager 白名单均从
  agents/packages 下的 package manifest 计算，不在脚本中维护固定 Agent 清单。
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$RuntimeRoot = 'runtime',
  [string]$ModelConfig,
  [switch]$SetManagerAsDefault,
  [string]$ManagerBinding,
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
. (Join-Path $ScriptDir 'component-lib.ps1')

$RuntimeRootAbs = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  Get-NormalizedPath $RuntimeRoot
} else {
  Get-NormalizedPath (Join-Path $ProjectRoot $RuntimeRoot)
}
$Mode = if ($Apply) { 'APPLY' } else { 'DRYRUN' }

function Invoke-OpenClaw {
  param([Parameter(Mandatory)][string[]]$OcArgs)
  $out = & openclaw @OcArgs 2>&1
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

function Get-AgentIndex {
  param($List, [string]$Id)
  for ($i = 0; $i -lt @($List).Count; $i++) {
    if ([string]$List[$i].id -eq $Id) { return $i }
  }
  return -1
}

function Set-OpenClawJson {
  param([string]$Path, $Value, [System.Collections.Generic.List[string]]$Changes)
  $json = $Value | ConvertTo-Json -Depth 10 -Compress
  $dry = Invoke-OpenClaw @('config','set',$Path,$json,'--strict-json','--dry-run')
  if ($dry.ExitCode -ne 0) { throw "config set dry-run 失败：$Path`n$($dry.Output)" }
  $write = Invoke-OpenClaw @('config','set',$Path,$json,'--strict-json')
  if ($write.ExitCode -ne 0) { throw "config set 写入失败：$Path`n$($write.Output)" }
  $Changes.Add("set $Path")
}

function Restore-ConfigOnFailure {
  param([string]$BackupPath, [string]$ConfigPath, [string]$Reason)
  Write-Host "`n[恢复] $Reason" -ForegroundColor Red
  if ($BackupPath -and (Test-Path -LiteralPath $BackupPath)) {
    Copy-Item -LiteralPath $BackupPath -Destination $ConfigPath -Force
    Write-Host "[恢复] 已恢复 OpenClaw 配置：$BackupPath" -ForegroundColor Yellow
  } else {
    Write-Host '[恢复] 没有可用的配置备份。' -ForegroundColor Yellow
  }
}

Write-Host "== openclaw-sdlc-multi-agent package 同步 ($Mode) ==" -ForegroundColor Cyan
Write-Host "ProjectRoot : $ProjectRoot"
Write-Host "RuntimeRoot : $RuntimeRootAbs"
Write-Host "调用时 PWD  : $((Get-Location).Path)（不用于路径解析）"

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) { throw '未找到 openclaw CLI。' }
$versionResult = Invoke-OpenClaw @('--version')
$configFileResult = Invoke-OpenClaw @('config','file')
if ($configFileResult.ExitCode -ne 0) { throw "无法获取 OpenClaw 配置文件：$($configFileResult.Output)" }
$ConfigFilePath = $configFileResult.Output.Trim()

$Packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs -ModelConfig $ModelConfig)
$RegisteredPackages = @($Packages | Where-Object register)
$Manager = Get-ManagerPackage $Packages
if (-not $Manager.register -or -not $Manager.active) { throw 'manager package 必须 register=true 且 active=true。' }
$ManagerAllow = @(Get-ManagerAllowAgents $Packages)

$existingResult = Invoke-OpenClaw @('agents','list','--json')
$ExistingAgents = @()
if ($existingResult.ExitCode -eq 0) {
  try { $ExistingAgents = @($existingResult.Output | ConvertFrom-Json) } catch { throw 'openclaw agents list --json 输出不可解析。' }
}
$ExistingIds = @($ExistingAgents | ForEach-Object { [string]$_.id })

$workspaceSeen = @($RegisteredPackages | ForEach-Object workspace | Sort-Object -Unique)
$agentDirSeen = @($RegisteredPackages | ForEach-Object agentDir | Sort-Object -Unique)
if ($workspaceSeen.Count -ne $RegisteredPackages.Count) { throw '注册计划中 workspace 路径重复。' }
if ($agentDirSeen.Count -ne $RegisteredPackages.Count) { throw '注册计划中 agentDir 路径重复。' }

$conflicts = [System.Collections.Generic.List[string]]::new()
foreach ($p in $RegisteredPackages) {
  if ($ExistingIds -contains $p.id) {
    $existing = @($ExistingAgents | Where-Object { [string]$_.id -eq $p.id })[0]
    if ($existing.PSObject.Properties.Name -contains 'workspace' -and $existing.workspace) {
      $existingWs = Get-NormalizedPath ([string]$existing.workspace)
      if (-not $existingWs.Equals($p.workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        $conflicts.Add("$($p.id): 现有 workspace=$existingWs，期望=$($p.workspace)")
      }
    }
  }
}
if ($conflicts.Count -gt 0) { throw "发现同名 Agent 冲突，不会覆盖用户 Agent：`n$($conflicts -join "`n")" }

$RuntimeDirs = [System.Collections.Generic.List[string]]::new()
foreach ($relative in @('control\workflows','control\config-snapshots','control\component-requests','control\component-builds','worktrees','artifacts')) {
  $RuntimeDirs.Add((Join-Path $RuntimeRootAbs $relative))
}
foreach ($p in $RegisteredPackages) {
  $RuntimeDirs.Add($p.workspace)
  $RuntimeDirs.Add($p.agentDir)
  if ($p.include_common_rules) { $RuntimeDirs.Add((Join-Path $p.workspace 'rules')) }
}

Write-Host "`n== 发现的 Agent packages ==" -ForegroundColor Cyan
foreach ($p in $Packages) {
  $state = if (-not $p.register) { 'DRAFT' } elseif (-not $p.active) { 'REGISTERED_INACTIVE' } else { 'ACTIVE' }
  Write-Host ("  {0,-24} {1,-9} {2,-20} {3}" -f $p.id, $p.origin, $state, ($p.capabilities -join ','))
}
Write-Host "  manager allowAgents = $($ManagerAllow -join ', ')"

$Manifest = [ordered]@{
  schema_version = 2
  generated_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  mode = $Mode
  openclaw_version = $versionResult.Output
  config_file = $ConfigFilePath
  project_root_abs = $ProjectRoot
  runtime_root_abs = $RuntimeRootAbs
  package_catalog_root_abs = (Join-Path $ProjectRoot 'agents\packages')
  agents = @()
  config_backup = $null
  config_changes = @()
  validation = $null
}
foreach ($p in $Packages) {
  $Manifest.agents += [ordered]@{
    id = $p.id
    origin = $p.origin
    protected = $p.protected
    manifest_abs = $p.manifest_path
    workspace_source_abs = $p.workspace_source
    workspace_abs = $p.workspace
    agentDir_abs = $p.agentDir
    model = $p.model
    capabilities = @($p.capabilities)
    register = $p.register
    active = $p.active
    subagents_allow = @(if ($p.role -eq 'manager') { $ManagerAllow } else { $p.allow_agents })
    require_agent_id = ($p.role -eq 'manager' -and $p.require_agent_id)
    sandbox_mode = $p.sandbox_mode
  }
}

if (-not $Apply) {
  Write-Host "`n[DRYRUN] 将同步 $($RegisteredPackages.Count) 个 Agent；未修改 runtime 或 OpenClaw 配置。" -ForegroundColor Yellow
  foreach ($p in $RegisteredPackages) {
    $verb = if ($ExistingIds -contains $p.id) { 'KEEP' } else { 'ADD ' }
    Write-Host "  $verb $($p.id) -> $($p.workspace)"
  }
  $dryDir = Join-Path $ProjectRoot 'artifacts\install-dryrun'
  New-Item -ItemType Directory -Force -Path $dryDir | Out-Null
  $dryPath = Join-Path $dryDir 'install-manifest.dryrun.json'
  Write-JsonAtomic -Value $Manifest -Path $dryPath -Depth 12
  Write-Host "[DRYRUN] 清单：$dryPath" -ForegroundColor Green
  return
}

if (-not $Yes) {
  $answer = Read-Host "即将同步 $($RegisteredPackages.Count) 个 package 并修改 OpenClaw 配置。输入 yes 继续"
  if ($answer -ne 'yes') { Write-Host '已取消。'; return }
}

foreach ($dir in $RuntimeDirs) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$snapshotDir = Join-Path $RuntimeRootAbs 'control\config-snapshots'
$backupPath = $null
if (Test-Path $ConfigFilePath) {
  $backupPath = Join-Path $snapshotDir ("openclaw.json.{0}.bak" -f (Get-Date).ToString('yyyyMMdd-HHmmss'))
  Copy-Item -Path $ConfigFilePath -Destination $backupPath -Force
  $Manifest.config_backup = $backupPath
}

$changes = [System.Collections.Generic.List[string]]::new()
try {
  $commonSource = Join-Path $ProjectRoot 'agents\common'
  $templatesSource = Join-Path $ProjectRoot 'templates'
  $systemSkillsSource = Join-Path $ProjectRoot 'agents\packages\system\skills'
  foreach ($p in $RegisteredPackages) {
    New-Item -ItemType Directory -Force -Path $p.workspace, $p.agentDir | Out-Null
    Copy-Item -Path (Join-Path $p.workspace_source '*') -Destination $p.workspace -Recurse -Force
    if ($p.include_common_rules) {
      $rulesTarget = Join-Path $p.workspace 'rules'
      New-Item -ItemType Directory -Force -Path $rulesTarget | Out-Null
      Copy-Item -Path (Join-Path $commonSource '*.md') -Destination $rulesTarget -Force
    }
    if ($p.include_templates) {
      $templatesTarget = Join-Path $p.workspace 'templates'
      New-Item -ItemType Directory -Force -Path $templatesTarget | Out-Null
      Copy-Item -Path (Join-Path $templatesSource '*') -Destination $templatesTarget -Recurse -Force
    }
    foreach ($skill in $p.skills) {
      $managedSkillSource = Join-Path $systemSkillsSource $skill
      if (Test-Path -LiteralPath $managedSkillSource -PathType Container) {
        $managedSkillTarget = Join-Path $p.workspace ("skills\$skill")
        New-Item -ItemType Directory -Force -Path $managedSkillTarget | Out-Null
        Copy-Item -Path (Join-Path $managedSkillSource '*') -Destination $managedSkillTarget -Recurse -Force
      }
    }
  }

  foreach ($p in $RegisteredPackages) {
    if ($ExistingIds -contains $p.id) { continue }
    $args = @('agents','add',$p.id,'--non-interactive','--workspace',$p.workspace,'--agent-dir',$p.agentDir,'--json')
    if ($p.model) { $args += @('--model',$p.model) }
    $created = Invoke-OpenClaw $args
    if ($created.ExitCode -ne 0) { throw "创建 Agent '$($p.id)' 失败：$($created.Output)" }
    $changes.Add("agents add $($p.id)")
  }

  $listNowResult = Invoke-OpenClaw @('config','get','agents.list','--json')
  if ($listNowResult.ExitCode -ne 0) { throw "无法读取 agents.list：$($listNowResult.Output)" }
  $listNow = @($listNowResult.Output | ConvertFrom-Json)
  foreach ($p in $RegisteredPackages) {
    $idx = Get-AgentIndex -List $listNow -Id $p.id
    if ($idx -lt 0) { throw "配置中未找到 Agent '$($p.id)'。" }
    $currentAgent = $listNow[$idx]
    $subagents = if ($p.role -eq 'manager') {
      [ordered]@{ delegationMode = 'prefer'; requireAgentId = $true; allowAgents = @($ManagerAllow) }
    } else {
      [ordered]@{ allowAgents = @($p.allow_agents) }
    }
    $currentAllow = @()
    $currentDelegationMode = ''
    $currentRequireAgentId = $false
    if ($currentAgent.PSObject.Properties.Name -contains 'subagents' -and $currentAgent.subagents) {
      if ($currentAgent.subagents.PSObject.Properties.Name -contains 'allowAgents') { $currentAllow = @($currentAgent.subagents.allowAgents | ForEach-Object { [string]$_ }) }
      if ($currentAgent.subagents.PSObject.Properties.Name -contains 'delegationMode') { $currentDelegationMode = [string]$currentAgent.subagents.delegationMode }
      if ($currentAgent.subagents.PSObject.Properties.Name -contains 'requireAgentId') { $currentRequireAgentId = [bool]$currentAgent.subagents.requireAgentId }
    }
    $desiredAllow = @(if ($p.role -eq 'manager') { $ManagerAllow } else { $p.allow_agents })
    $allowMatches = @($currentAllow).Count -eq @($desiredAllow).Count -and @($desiredAllow | Where-Object { @($currentAllow) -notcontains $_ }).Count -eq 0
    $subagentsMatch = if ($p.role -eq 'manager') {
      $allowMatches -and $currentDelegationMode -eq 'prefer' -and $currentRequireAgentId
    } else {
      $allowMatches
    }
    if (-not $subagentsMatch) {
      Set-OpenClawJson -Path "agents.list[$idx].subagents" -Value $subagents -Changes $changes
    }
    if ($p.sandbox_mode) {
      $currentSandboxMode = ''
      if ($currentAgent.PSObject.Properties.Name -contains 'sandbox' -and $currentAgent.sandbox -and $currentAgent.sandbox.PSObject.Properties.Name -contains 'mode') {
        $currentSandboxMode = [string]$currentAgent.sandbox.mode
      }
      if ($currentSandboxMode -ne $p.sandbox_mode) {
        Set-OpenClawJson -Path "agents.list[$idx].sandbox" -Value ([ordered]@{ mode = $p.sandbox_mode }) -Changes $changes
      }
    }
  }

  if ($SetManagerAsDefault) {
    $idx = Get-AgentIndex -List $listNow -Id $Manager.id
    $setDefault = Invoke-OpenClaw @('config','set',"agents.list[$idx].default",'true','--strict-json')
    if ($setDefault.ExitCode -ne 0) { throw "设置 manager 默认失败：$($setDefault.Output)" }
    $changes.Add("set $($Manager.id).default=true")
  }
  if ($ManagerBinding) {
    $bind = Invoke-OpenClaw @('agents','bind',$Manager.id,'--bind',$ManagerBinding)
    if ($bind.ExitCode -ne 0) { throw "manager binding 失败：$($bind.Output)" }
    $changes.Add("bind $($Manager.id) $ManagerBinding")
  }

  $validate = Invoke-OpenClaw @('config','validate','--json')
  $Manifest.validation = [ordered]@{ config_validate_exit = $validate.ExitCode; config_validate_out = $validate.Output }
  if ($validate.ExitCode -ne 0) { throw "OpenClaw 配置校验失败：$($validate.Output)" }
} catch {
  Restore-ConfigOnFailure -BackupPath $backupPath -ConfigPath $ConfigFilePath -Reason $_.Exception.Message
  throw
}

$Manifest.config_changes = @($changes)
$manifestPath = Join-Path $RuntimeRootAbs 'control\install-manifest.json'
Write-JsonAtomic -Value $Manifest -Path $manifestPath -Depth 12
Write-Host "`n同步完成；配置校验通过。" -ForegroundColor Green
Write-Host "安装清单：$manifestPath"
