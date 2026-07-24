#requires -Version 7.0
<#
.SYNOPSIS
  安装/注册 openclaw-sdlc-multi-agent 的 7 个原生 OpenClaw Agent。
.DESCRIPTION
  默认只做 dry-run（不修改任何 OpenClaw 配置）。仅在 -Apply 且用户确认后写入配置。
  绝对路径处理：所有 workspace/agentDir/runtime 路径基于项目根目录（本脚本所在目录的父目录）解析，
  再规范化为绝对路径，绝不依赖当前工作目录（即使从 C:\Windows\System32 调用）。
  不安装依赖、不联网、不启用 sandbox、不安装 Docker、不删除用户已有 Agent、不执行 doctor --fix。
.NOTES
  探测版本基准：OpenClaw 2026.7.1-2。以真实 --help / config schema 为准。
#>
[CmdletBinding()]
param(
  [switch]$Apply,                       # 缺省 = DryRun。仅 -Apply 时写配置。
  [string]$RuntimeRoot = "runtime",     # 相对值相对“项目根目录”解析，而非 $PWD
  [string]$ModelConfig,                 # 可选：agent-models.json 路径（每 Agent 模型）
  [switch]$SetManagerAsDefault,         # 可选：把 manager-agent 设为默认 Agent
  [string]$ManagerBinding,              # 可选：manager-agent 的用户渠道 binding，如 "discord:acct"
  [switch]$Yes                          # 非交互确认（配合 -Apply）
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 0. 绝对路径解析（System32 防护核心）
# ---------------------------------------------------------------------------
$ScriptDir   = $PSScriptRoot                                   # scripts/
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  # 相对 RuntimeRoot 相对“项目根目录”解析，不相对 $PWD
  $RuntimeRootAbs = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $RuntimeRoot))
} else {
  $RuntimeRootAbs = [System.IO.Path]::GetFullPath($RuntimeRoot)
}

function Assert-Absolute([string]$Path, [string]$Label) {
  if (-not [System.IO.Path]::IsPathRooted($Path)) {
    throw "路径必须为绝对路径 ($Label): $Path"
  }
}
Assert-Absolute $ProjectRoot    'ProjectRoot'
Assert-Absolute $RuntimeRootAbs 'RuntimeRoot'

$Mode = if ($Apply) { 'APPLY' } else { 'DRYRUN' }
Write-Host "== openclaw-sdlc-multi-agent 安装 ($Mode) ==" -ForegroundColor Cyan
Write-Host "ProjectRoot   : $ProjectRoot"
Write-Host "RuntimeRoot   : $RuntimeRootAbs"
Write-Host "调用时 PWD    : $((Get-Location).Path)  (仅供参考，不用于路径解析)"

# ---------------------------------------------------------------------------
# 1. 7 个 Agent 的规范定义
# ---------------------------------------------------------------------------
$AgentIds = @(
  'manager-agent','requirement-agent','architect-agent',
  'developer-agent','review-agent','test-agent','release-agent'
)
$WorkerIds = $AgentIds | Where-Object { $_ -ne 'manager-agent' }

# 每个 Agent 的绝对 workspace / agentDir（基于绝对 RuntimeRoot 拼接并规范化）
$AgentPlan = [ordered]@{}
foreach ($id in $AgentIds) {
  $ws  = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRootAbs "agents\$id\workspace"))
  $dir = [System.IO.Path]::GetFullPath((Join-Path $RuntimeRootAbs "agents\$id\state"))
  Assert-Absolute $ws  "$id.workspace"
  Assert-Absolute $dir "$id.agentDir"
  $AgentPlan[$id] = [pscustomobject]@{ id = $id; workspace = $ws; agentDir = $dir; model = '' }
}

# 可选模型配置
if ($ModelConfig) {
  if (-not [System.IO.Path]::IsPathRooted($ModelConfig)) {
    $ModelConfig = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $ModelConfig))
  }
  if (Test-Path $ModelConfig) {
    $mc = Get-Content -Raw -Path $ModelConfig | ConvertFrom-Json
    foreach ($id in $AgentIds) {
      if ($mc.agents.$id -and $mc.agents.$id.model) { $AgentPlan[$id].model = [string]$mc.agents.$id.model }
    }
  } else {
    Write-Warning "ModelConfig 不存在，忽略：$ModelConfig"
  }
}

# 校验 7 个 workspace / agentDir 彼此不同
$wsList  = $AgentPlan.Values.workspace
$dirList = $AgentPlan.Values.agentDir
if (($wsList | Sort-Object -Unique).Count -ne $AgentIds.Count) { throw "workspace 路径存在重复" }
if (($dirList | Sort-Object -Unique).Count -ne $AgentIds.Count) { throw "agentDir 路径存在重复" }

# ---------------------------------------------------------------------------
# 2. 探测 OpenClaw CLI 与现有配置（只读）
# ---------------------------------------------------------------------------
function Invoke-OpenClaw {
  param([string[]]$OcArgs)
  $out = & openclaw @OcArgs 2>&1
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

# 失败时恢复配置备份（仅当已生成备份）。定义在使用点之前。
function Restore-OnFailure {
  param([string]$Reason)
  Write-Host "`n[恢复] $Reason" -ForegroundColor Red
  if ($script:Manifest -and $script:Manifest.config_backup -and (Test-Path $script:Manifest.config_backup)) {
    try {
      Copy-Item -Path $script:Manifest.config_backup -Destination $ConfigFilePath -Force
      Write-Host "[恢复] 已从备份还原配置：$($script:Manifest.config_backup)" -ForegroundColor Yellow
    } catch {
      Write-Host "[恢复] 还原配置失败：$($_.Exception.Message)" -ForegroundColor Red
    }
  } else {
    Write-Host "[恢复] 无可用配置备份（可能尚未进入写入阶段）。" -ForegroundColor Yellow
  }
  Write-Host "[恢复] 可能残留的本项目 runtime 目录（不会自动删除）：$RuntimeRootAbs" -ForegroundColor Yellow
}

$oc = Get-Command openclaw -ErrorAction SilentlyContinue
if (-not $oc) { throw "未找到 openclaw CLI，请先安装并确保在 PATH 中。" }

$verR = Invoke-OpenClaw @('--version')
Write-Host "OpenClaw 版本 : $($verR.Output)"
$cfgFileR = Invoke-OpenClaw @('config','file')
$ConfigFilePath = ($cfgFileR.Output).Trim()
Write-Host "配置文件      : $ConfigFilePath"

# 读取现有 Agent 列表（不修改）
$listR = Invoke-OpenClaw @('agents','list','--json')
$ExistingAgents = @()
if ($listR.ExitCode -eq 0) {
  try { $ExistingAgents = $listR.Output | ConvertFrom-Json } catch { $ExistingAgents = @() }
}
$ExistingIds = @()
if ($ExistingAgents) { $ExistingIds = @($ExistingAgents | ForEach-Object { $_.id }) }

# ---------------------------------------------------------------------------
# 3. 准备 runtime 目录结构（Apply 时创建；DryRun 只打印）
# ---------------------------------------------------------------------------
$RuntimeDirs = @(
  (Join-Path $RuntimeRootAbs 'control\workflows'),
  (Join-Path $RuntimeRootAbs 'control\config-snapshots'),
  (Join-Path $RuntimeRootAbs 'worktrees'),
  (Join-Path $RuntimeRootAbs 'artifacts')
)
foreach ($id in $AgentIds) {
  $RuntimeDirs += $AgentPlan[$id].workspace
  $RuntimeDirs += $AgentPlan[$id].agentDir
  $RuntimeDirs += (Join-Path $AgentPlan[$id].workspace 'rules')
}

# ---------------------------------------------------------------------------
# 4. 冲突检测：同名 Agent
# ---------------------------------------------------------------------------
$Conflicts = @()
foreach ($id in $AgentIds) {
  if ($ExistingIds -contains $id) {
    $existing = $ExistingAgents | Where-Object { $_.id -eq $id } | Select-Object -First 1
    $exWs  = if ($existing.PSObject.Properties.Name -contains 'workspace') { $existing.workspace } else { '' }
    if ($exWs -and ($exWs -ne $AgentPlan[$id].workspace)) {
      $Conflicts += "Agent '$id' 已存在且 workspace 不同：现有=$exWs 期望=$($AgentPlan[$id].workspace)"
    } else {
      Write-Host "Agent '$id' 已存在且兼容，安装将幂等跳过创建。" -ForegroundColor Yellow
    }
  }
}
if ($Conflicts.Count -gt 0) {
  Write-Host "`n检测到不兼容的同名 Agent，安装停止（不会覆盖用户已有 Agent）：" -ForegroundColor Red
  $Conflicts | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  throw "同名 Agent 冲突，请手动处理后重试。"
}

# ---------------------------------------------------------------------------
# 5. 生成 config patch（subagents 白名单 / requireAgentId / sandbox.mode）
#    通过 config get agents.list 定位真实索引，再逐字段 patch；不整体替换数组。
# ---------------------------------------------------------------------------
function New-AgentSubagentPatch {
  # 返回一个 JSON5 patch 对象文本（合并式），仅设置本项目拥有的字段。
  $items = @()
  foreach ($id in $AgentIds) {
    $node = [ordered]@{ id = $id }
    if ($id -eq 'manager-agent') {
      $node.subagents = [ordered]@{
        delegationMode = 'prefer'
        requireAgentId = $true
        allowAgents    = @($WorkerIds)
      }
    } else {
      $node.subagents = [ordered]@{ allowAgents = @() }
      if ($id -eq 'test-agent') {
        $node.sandbox = [ordered]@{ mode = 'off' }
      }
    }
    $items += $node
  }
  # 注意：agents.list 是数组；我们用 --replace-path 定位每个元素索引，避免整体替换。
  return $items
}

Write-Host "`n== 计划创建/配置的 Agent ==" -ForegroundColor Cyan
foreach ($id in $AgentIds) {
  $p = $AgentPlan[$id]
  $mdl = if ($p.model) { $p.model } else { '(继承默认)' }
  Write-Host ("  {0,-18} ws={1}" -f $id, $p.workspace)
  Write-Host ("  {0,-18} dir={1}  model={2}" -f '', $p.agentDir, $mdl)
}
Write-Host "  manager subagents.allowAgents = $($WorkerIds -join ', ')"
Write-Host "  manager subagents.requireAgentId = true ; delegationMode = prefer"
Write-Host "  worker  subagents.allowAgents = [] (禁止再派生)"
Write-Host "  test-agent sandbox.mode = off (本阶段无沙箱的显式声明)"

# ---------------------------------------------------------------------------
# 6. DryRun：到此为止只打印计划，不改任何东西
# ---------------------------------------------------------------------------
$Manifest = [ordered]@{
  schema_version   = 1
  generated_at     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  mode             = $Mode
  openclaw_version = ($verR.Output)
  config_file      = $ConfigFilePath
  project_root_abs = $ProjectRoot
  runtime_root_abs = $RuntimeRootAbs
  agents           = @()
  config_backup    = $null
  config_changes   = @()
  validation       = $null
  isolation_note   = 'test-agent sandbox.mode=off; test isolation_mode=UNSANDBOXED_LOCAL (本阶段无 sandbox)'
}
foreach ($id in $AgentIds) {
  $p = $AgentPlan[$id]
  $Manifest.agents += [ordered]@{
    id = $id; workspace_abs = $p.workspace; agentDir_abs = $p.agentDir
    model = $p.model
    subagents_allow = @(if ($id -eq 'manager-agent') { $WorkerIds } else { @() })
    require_agent_id = ($id -eq 'manager-agent')
    sandbox_mode = @(if ($id -eq 'test-agent') { 'off' } else { $null })[0]
  }
}

if (-not $Apply) {
  Write-Host "`n[DRYRUN] 将创建的 runtime 目录（示例，未创建）：" -ForegroundColor Yellow
  $RuntimeDirs | Select-Object -First 8 | ForEach-Object { Write-Host "  $_" }
  Write-Host "  ... 共 $($RuntimeDirs.Count) 个目录"
  Write-Host "`n[DRYRUN] 将执行的 openclaw agents add 语义（未执行）：" -ForegroundColor Yellow
  foreach ($id in $AgentIds) {
    $p = $AgentPlan[$id]
    $modelArg = if ($p.model) { " --model `"$($p.model)`"" } else { '' }
    Write-Host "  openclaw agents add $id --non-interactive --workspace `"$($p.workspace)`" --agent-dir `"$($p.agentDir)`"$modelArg --json"
  }
  Write-Host "`n[DRYRUN] 将通过 config patch --dry-run 校验 subagents/sandbox 字段（未写入）。" -ForegroundColor Yellow

  # DryRun 也把 manifest 写到项目 artifacts（不碰 runtime、不碰 openclaw 配置）
  $dryManifestDir = Join-Path $ProjectRoot 'artifacts\install-dryrun'
  New-Item -ItemType Directory -Force -Path $dryManifestDir | Out-Null
  $dryManifestPath = Join-Path $dryManifestDir 'install-manifest.dryrun.json'
  ($Manifest | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 -Path $dryManifestPath
  Write-Host "`n[DRYRUN] 计划清单已写入：$dryManifestPath" -ForegroundColor Green
  Write-Host "[DRYRUN] 未修改任何 OpenClaw 配置。要真正安装请加 -Apply。" -ForegroundColor Green
  return
}

# ---------------------------------------------------------------------------
# 7. APPLY：确认 -> 备份 -> 创建目录/复制文件 -> 创建 Agent -> patch -> 校验
# ---------------------------------------------------------------------------
if (-not $Yes) {
  Write-Host "`n即将修改 OpenClaw 配置并创建 7 个 Agent。" -ForegroundColor Yellow
  $ans = Read-Host "确认继续？输入 yes 继续，其它取消"
  if ($ans -ne 'yes') { Write-Host "已取消。"; return }
}

# 7.1 创建 runtime 目录
foreach ($d in $RuntimeDirs) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

# 7.2 备份当前 OpenClaw 配置到 runtime/control/config-snapshots
$snapDir = Join-Path $RuntimeRootAbs 'control\config-snapshots'
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
if (Test-Path $ConfigFilePath) {
  $backupPath = Join-Path $snapDir ("openclaw.json.$stamp.bak")
  Copy-Item -Path $ConfigFilePath -Destination $backupPath -Force
  $Manifest.config_backup = $backupPath
  Write-Host "已备份配置到：$backupPath" -ForegroundColor Green
} else {
  Write-Warning "未找到配置文件 $ConfigFilePath，跳过备份（首次配置？）"
}

# 7.3 复制 workspace prompt + 共享规则 + 模板 到绝对 workspace（自包含）
$srcAgents = Join-Path $ProjectRoot 'agents'
$srcCommon = Join-Path $srcAgents 'common'
$srcTemplates = Join-Path $ProjectRoot 'templates'
foreach ($id in $AgentIds) {
  $srcWs = Join-Path $srcAgents "$id\workspace"
  $dstWs = $AgentPlan[$id].workspace
  if (Test-Path $srcWs) {
    Copy-Item -Path (Join-Path $srcWs '*') -Destination $dstWs -Recurse -Force
  }
  # 复制 6 份共享规则到 workspace/rules（本地权威副本）
  $dstRules = Join-Path $dstWs 'rules'
  New-Item -ItemType Directory -Force -Path $dstRules | Out-Null
  Copy-Item -Path (Join-Path $srcCommon '*.md') -Destination $dstRules -Force
}
# manager 额外复制 templates
if (Test-Path $srcTemplates) {
  $mgrTpl = Join-Path $AgentPlan['manager-agent'].workspace 'templates'
  New-Item -ItemType Directory -Force -Path $mgrTpl | Out-Null
  Copy-Item -Path (Join-Path $srcTemplates '*') -Destination $mgrTpl -Recurse -Force
}
Write-Host "已复制 workspace prompt / 共享规则 / 模板到绝对 workspace。" -ForegroundColor Green

# 7.4 创建 7 个 Agent（幂等：已兼容存在则跳过）
foreach ($id in $AgentIds) {
  if ($ExistingIds -contains $id) {
    Write-Host "跳过已存在且兼容的 Agent：$id" -ForegroundColor Yellow
    continue
  }
  $p = $AgentPlan[$id]
  $addArgs = @('agents','add', $id, '--non-interactive', '--workspace', $p.workspace, '--agent-dir', $p.agentDir, '--json')
  if ($p.model) { $addArgs += @('--model', $p.model) }
  Write-Host "创建 Agent：$id" -ForegroundColor Cyan
  $r = Invoke-OpenClaw $addArgs
  if ($r.ExitCode -ne 0) {
    Write-Host $r.Output -ForegroundColor Red
    Restore-OnFailure -Reason "创建 Agent $id 失败"
    throw "创建 Agent $id 失败 (exit=$($r.ExitCode))。已尝试恢复配置备份。"
  }
  $Manifest.config_changes += "agents add $id"
}

# 7.5 定位真实索引并 patch subagents / sandbox（先 dry-run 校验，再写入，再 validate）
$listNow = (Invoke-OpenClaw @('config','get','agents.list','--json')).Output | ConvertFrom-Json
function Get-AgentIndex([object]$List, [string]$Id) {
  for ($i = 0; $i -lt $List.Count; $i++) { if ($List[$i].id -eq $Id) { return $i } }
  return -1
}

# 逐个 Agent 构造一个针对其索引的 patch 对象；用 --stdin + --replace-path 精确写入。
foreach ($id in $AgentIds) {
  $idx = Get-AgentIndex $listNow $id
  if ($idx -lt 0) { throw "配置中未找到 Agent $id 的索引，停止。" }

  if ($id -eq 'manager-agent') {
    $sub = [ordered]@{ delegationMode='prefer'; requireAgentId=$true; allowAgents=@($WorkerIds) }
    # 用 bracket 路径定位数组元素的 subagents 字段（不整体替换 agents.list 数组）
    $subPath = "agents.list[$idx].subagents"
    $subJson = ($sub | ConvertTo-Json -Depth 6 -Compress)
    $rc = Invoke-OpenClaw @('config','set', $subPath, $subJson, '--strict-json', '--dry-run')
    if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "manager subagents dry-run 失败"; throw "manager subagents dry-run 失败" }
    $rc = Invoke-OpenClaw @('config','set', $subPath, $subJson, '--strict-json')
    if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "manager subagents 写入失败"; throw "manager subagents 写入失败" }
    $Manifest.config_changes += "set $subPath"
  } else {
    $subPath = "agents.list[$idx].subagents"
    $subJson = ([ordered]@{ allowAgents=@() } | ConvertTo-Json -Depth 4 -Compress)
    $rc = Invoke-OpenClaw @('config','set', $subPath, $subJson, '--strict-json', '--dry-run')
    if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "$id subagents dry-run 失败"; throw "$id subagents dry-run 失败" }
    $rc = Invoke-OpenClaw @('config','set', $subPath, $subJson, '--strict-json')
    if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "$id subagents 写入失败"; throw "$id subagents 写入失败" }
    $Manifest.config_changes += "set $subPath"

    if ($id -eq 'test-agent') {
      $sbPath = "agents.list[$idx].sandbox"
      $sbJson = ([ordered]@{ mode='off' } | ConvertTo-Json -Depth 3 -Compress)
      $rc = Invoke-OpenClaw @('config','set', $sbPath, $sbJson, '--strict-json', '--dry-run')
      if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "test-agent sandbox dry-run 失败"; throw "test-agent sandbox dry-run 失败" }
      $rc = Invoke-OpenClaw @('config','set', $sbPath, $sbJson, '--strict-json')
      if ($rc.ExitCode -ne 0) { Write-Host $rc.Output -ForegroundColor Red; Restore-OnFailure -Reason "test-agent sandbox 写入失败"; throw "test-agent sandbox 写入失败" }
      $Manifest.config_changes += "set $sbPath"
    }
  }
}

# 7.6 可选：默认 Agent / binding
if ($SetManagerAsDefault) {
  $mi = Get-AgentIndex ((Invoke-OpenClaw @('config','get','agents.list','--json')).Output | ConvertFrom-Json) 'manager-agent'
  $rc = Invoke-OpenClaw @('config','set', "agents.list[$mi].default", 'true', '--strict-json')
  if ($rc.ExitCode -eq 0) { $Manifest.config_changes += 'set manager-agent.default=true' }
  else { Write-Warning "设置 manager 默认失败：$($rc.Output)" }
}
if ($ManagerBinding) {
  $rc = Invoke-OpenClaw @('agents','bind','manager-agent','--bind', $ManagerBinding)
  if ($rc.ExitCode -eq 0) { $Manifest.config_changes += "bind manager-agent $ManagerBinding" }
  else { Write-Warning "manager binding 失败：$($rc.Output)" }
}

# ---------------------------------------------------------------------------
# 8. 校验：config validate / agents list / doctor lint（不 --fix）
# ---------------------------------------------------------------------------
$validateR = Invoke-OpenClaw @('config','validate','--json')
$Manifest.validation = [ordered]@{
  config_validate_exit = $validateR.ExitCode
  config_validate_out  = $validateR.Output
}
Write-Host "`nconfig validate exit=$($validateR.ExitCode)"
Write-Host $validateR.Output

$agentsListR = Invoke-OpenClaw @('agents','list','--json')
Write-Host "agents list exit=$($agentsListR.ExitCode)"

# doctor lint 仅记录，绝不 --fix
$doctorR = Invoke-OpenClaw @('doctor','--lint','--json')
$Manifest.validation.doctor_lint_exit = $doctorR.ExitCode

# ---------------------------------------------------------------------------
# 9. 写 install-manifest.json（Apply）
# ---------------------------------------------------------------------------
$manifestDir  = Join-Path $RuntimeRootAbs 'control'
$manifestPath = Join-Path $manifestDir 'install-manifest.json'
($Manifest | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 -Path $manifestPath
Write-Host "`n安装清单已写入：$manifestPath" -ForegroundColor Green

if ($validateR.ExitCode -ne 0) {
  Write-Host "config validate 未通过，请检查上面输出。配置备份位于：$($Manifest.config_backup)" -ForegroundColor Red
} else {
  Write-Host "== 安装完成（APPLY）。config validate 通过。 ==" -ForegroundColor Green
}




