#requires -Version 7.0
<#
.SYNOPSIS
  安全地卸载本项目已安装的 Agent，然后重新安装并同步 runtime。
.DESCRIPTION
  默认只输出计划。Apply 前会验证每个待删除 Agent 的 workspace 和 agentDir
  均与当前 package manifest 计算出的本项目 runtime 路径完全一致；不匹配时
  失败退出，绝不删除同名的用户 Agent。Apply 会备份 OpenClaw 配置与受管理的
  workspace/state，再执行 `openclaw agents delete --force` 和 install.ps1。
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

function Remove-ManagedAgentWithRetry {
  param(
    [Parameter(Mandatory)][string]$AgentId,
    [int]$MaxAttempts = 5
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    $deleted = Invoke-OpenClaw @('agents','delete',$AgentId,'--force','--json')
    if ($deleted.ExitCode -eq 0) { return }

    $isRevisionConflict = $deleted.Output -match 'ConfigMutationConflictError'
    if (-not $isRevisionConflict -or $attempt -eq $MaxAttempts) {
      throw "删除 Agent '$AgentId' 失败：$($deleted.Output)"
    }

    # OpenClaw mutates configuration optimistically.  Refresh its config view before
    # retrying so a preceding delete has time to become the new revision.
    Write-Host "删除 $AgentId 时遇到配置版本冲突，正在重试 ($attempt/$MaxAttempts)..." -ForegroundColor Yellow
    $refresh = Invoke-OpenClaw @('config','get','agents.list','--json')
    if ($refresh.ExitCode -ne 0) {
      throw "删除 Agent '$AgentId' 后无法刷新 agents.list：$($refresh.Output)"
    }
    try { $remaining = @($refresh.Output | ConvertFrom-Json) }
    catch { throw "删除 Agent '$AgentId' 后 agents.list JSON 无法解析。" }
    if (@($remaining | Where-Object { [string]$_.id -eq $AgentId }).Count -eq 0) {
      # Some OpenClaw versions persist the deletion but report the stale-revision
      # conflict to the caller.  Treat the observed desired state as success.
      return
    }
    Start-Sleep -Milliseconds (300 * $attempt)
  }
}

function Get-ObjectProperty {
  param($Object, [string]$Name)
  if ($null -eq $Object -or $Object.PSObject.Properties.Name -notcontains $Name) { return $null }
  return $Object.$Name
}

function Assert-ManagedAgentIdentity {
  param($ConfiguredAgent, $Package)
  if ($null -eq $ConfiguredAgent) { return }
  $workspace = Get-ObjectProperty $ConfiguredAgent 'workspace'
  $agentDir = Get-ObjectProperty $ConfiguredAgent 'agentDir'
  if (-not $workspace -or -not $agentDir) {
    throw "拒绝删除 '$($Package.id)'：当前 OpenClaw 配置缺少 workspace 或 agentDir。"
  }
  $actualWorkspace = Get-NormalizedPath ([string]$workspace)
  $actualAgentDir = Get-NormalizedPath ([string]$agentDir)
  $workspaceMatches = $actualWorkspace.Equals($Package.workspace, [System.StringComparison]::OrdinalIgnoreCase)
  $agentDirMatches = $actualAgentDir.Equals($Package.agentDir, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $workspaceMatches -or -not $agentDirMatches) {
    throw "拒绝删除 '$($Package.id)'：配置路径不属于本项目 runtime。实际 workspace=$actualWorkspace；agentDir=$actualAgentDir。"
  }
}

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) { throw '未找到 openclaw CLI。' }
$configFile = (Invoke-OpenClaw @('config','file'))
if ($configFile.ExitCode -ne 0) { throw "无法读取 OpenClaw 配置路径：$($configFile.Output)" }
$configPath = $configFile.Output.Trim()

$configList = Invoke-OpenClaw @('config','get','agents.list','--json')
if ($configList.ExitCode -ne 0) { throw "无法读取 agents.list：$($configList.Output)" }
try { $configuredAgents = @($configList.Output | ConvertFrom-Json) }
catch { throw 'agents.list JSON 无法解析。' }

$packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs -ModelConfig $ModelConfig | Where-Object register)
$configuredById = @{}
foreach ($agent in $configuredAgents) { $configuredById[[string]$agent.id] = $agent }

$targets = @()
foreach ($package in $packages) {
  $configured = if ($configuredById.ContainsKey($package.id)) { $configuredById[$package.id] } else { $null }
  if ($configured) {
    Assert-ManagedAgentIdentity -ConfiguredAgent $configured -Package $package
    $targets += [pscustomobject]@{ Package = $package; Configured = $configured; Installed = $true }
  }
}
if ($targets.Count -eq 0) { throw '未发现可安全重装的已安装项目 Agent。' }
if (@($targets | Where-Object { $_.Package.role -eq 'manager' }).Count -ne 1) { throw '重装目标必须且只能包含一个 manager-agent。' }

Write-Host "== openclaw-sdlc-multi-agent 重新安装 ($Mode) ==" -ForegroundColor Cyan
Write-Host "ProjectRoot : $ProjectRoot"
Write-Host "RuntimeRoot : $RuntimeRootAbs"
Write-Host "Config      : $configPath"
foreach ($target in $targets) {
  Write-Host ("  {0,-24} DELETE + ADD" -f $target.Package.id)
}

if (-not $Apply) {
  Write-Host "`n[DRYRUN] 未删除 Agent，未修改 OpenClaw 配置或 runtime。使用 -Apply -Yes 执行。" -ForegroundColor Yellow
  return
}

if (-not $Yes) {
  $answer = Read-Host "将删除并重新创建 $(@($targets | Where-Object Installed).Count) 个项目 Agent。输入 yes 继续"
  if ($answer -ne 'yes') { Write-Host '已取消。'; return }
}

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupRoot = Join-Path $RuntimeRootAbs "control\reinstall-backups\$stamp"
$backupAgents = Join-Path $backupRoot 'agents'
New-Item -ItemType Directory -Force -Path $backupAgents | Out-Null
$configBackup = Join-Path $backupRoot 'openclaw.json.before-reinstall.bak'
if (Test-Path -LiteralPath $configPath) { Copy-Item -LiteralPath $configPath -Destination $configBackup -Force }

foreach ($target in @($targets | Where-Object Installed)) {
  $targetBackup = Join-Path $backupAgents $target.Package.id
  New-Item -ItemType Directory -Force -Path $targetBackup | Out-Null
  if (Test-Path -LiteralPath $target.Package.workspace) {
    Copy-Item -LiteralPath $target.Package.workspace -Destination (Join-Path $targetBackup 'workspace') -Recurse -Force
  }
  if (Test-Path -LiteralPath $target.Package.agentDir) {
    Copy-Item -LiteralPath $target.Package.agentDir -Destination (Join-Path $targetBackup 'state') -Recurse -Force
  }
}

# Package manifests may intentionally leave model blank so a normal install inherits
# the OpenClaw default.  A reinstall must retain an already configured per-Agent
# model instead of silently changing routing.  An explicit -ModelConfig remains the
# caller's override; otherwise persist the current values with this backup.
$installModelConfig = $ModelConfig
if (-not $installModelConfig) {
  $preservedAgents = [ordered]@{}
  foreach ($target in $targets) {
    $model = Get-ObjectProperty $target.Configured 'model'
    if ($model) { $preservedAgents[$target.Package.id] = [ordered]@{ model = [string]$model } }
  }
  if ($preservedAgents.Count -gt 0) {
    $installModelConfig = Join-Path $backupRoot 'agent-models.before-reinstall.json'
    Write-JsonAtomic -Value ([ordered]@{ schema_version = 1; agents = $preservedAgents }) -Path $installModelConfig -Depth 6
  }
}

try {
  foreach ($target in @($targets | Where-Object Installed)) {
    Remove-ManagedAgentWithRetry -AgentId $target.Package.id
    Write-Host "已卸载：$($target.Package.id)" -ForegroundColor Yellow
  }

  $installArgs = @('-NoProfile','-File',(Join-Path $ScriptDir 'install.ps1'),'-Apply','-RuntimeRoot',$RuntimeRootAbs,'-Yes','-AgentIds')
  # A child PowerShell script accepts the string[] parameter as one comma-delimited
  # argument here; passing trailing values separately makes later IDs positional.
  $installArgs += (@($targets | ForEach-Object { $_.Package.id }) -join ',')
  if ($installModelConfig) { $installArgs += @('-ModelConfig',$installModelConfig) }
  if ($SetManagerAsDefault) { $installArgs += '-SetManagerAsDefault' }
  if ($ManagerBinding) { $installArgs += @('-ManagerBinding',$ManagerBinding) }
  & pwsh @installArgs
  if ($LASTEXITCODE -ne 0) { throw "install.ps1 重新安装失败，退出码：$LASTEXITCODE" }

  $bundle = & node (Join-Path $ScriptDir 'runtime-bundle.mjs') verify --project-root $ProjectRoot --runtime-root $RuntimeRootAbs
  if ($LASTEXITCODE -ne 0) { throw "runtime bundle 校验失败：$bundle" }
  $validate = Invoke-OpenClaw @('config','validate','--json')
  if ($validate.ExitCode -ne 0) { throw "OpenClaw 配置校验失败：$($validate.Output)" }
  Write-Host "`n重新安装完成；配置和 runtime bundle 已验证。" -ForegroundColor Green
  Write-Host "恢复备份：$backupRoot"
} catch {
  $reason = $_.Exception.Message
  Write-Host "`n重新安装失败，尝试恢复配置与 runtime Agent 备份：$reason" -ForegroundColor Red
  if (Test-Path -LiteralPath $configBackup) { Copy-Item -LiteralPath $configBackup -Destination $configPath -Force }
  foreach ($target in @($targets | Where-Object Installed)) {
    $targetBackup = Join-Path $backupAgents $target.Package.id
    $workspaceBackup = Join-Path $targetBackup 'workspace'
    $stateBackup = Join-Path $targetBackup 'state'
    if (Test-Path -LiteralPath $workspaceBackup) { Copy-Item -LiteralPath $workspaceBackup -Destination $target.Package.workspace -Recurse -Force }
    if (Test-Path -LiteralPath $stateBackup) { Copy-Item -LiteralPath $stateBackup -Destination $target.Package.agentDir -Recurse -Force }
  }
  throw
}
