#requires -Version 7.0
<#
.SYNOPSIS
  从 openclaw-sdlc-multi-agent 生成的配置快照恢复 OpenClaw 配置。
.DESCRIPTION
  仅恢复用户明确选择的快照；在覆盖当前配置前，先再次备份当前配置文件。
  不删除任何 Agent、workspace、会话或用户后续创建的数据。
  注意：恢复配置与删除 workspace 是两件不同的事——本脚本只处理 openclaw.json 配置文件。
.EXAMPLE
  # 列出可用快照
  pwsh -File .\scripts\restore-openclaw-config.ps1
.EXAMPLE
  # 恢复指定快照（会先备份当前配置）
  pwsh -File .\scripts\restore-openclaw-config.ps1 -SnapshotPath "C:\...\config-snapshots\openclaw.json.20260723-101500.bak" -Yes
#>
[CmdletBinding()]
param(
  [string]$SnapshotPath,                 # 要恢复的快照绝对路径；缺省则仅列出可选快照
  [string]$RuntimeRoot = "runtime",      # 相对值相对项目根解析
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot)) {
  $RuntimeRootAbs = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $RuntimeRoot))
} else {
  $RuntimeRootAbs = [System.IO.Path]::GetFullPath($RuntimeRoot)
}
$SnapDir = Join-Path $RuntimeRootAbs 'control\config-snapshots'

$oc = Get-Command openclaw -ErrorAction SilentlyContinue
if (-not $oc) { throw "未找到 openclaw CLI。" }
$ConfigFilePath = (& openclaw config file 2>$null | Select-Object -First 1).Trim()
Write-Host "当前配置文件 : $ConfigFilePath"
Write-Host "快照目录     : $SnapDir"

# 未指定快照：列出可选项后退出
if (-not $SnapshotPath) {
  if (-not (Test-Path $SnapDir)) { Write-Host "没有快照目录（尚未 Apply 安装过？）：$SnapDir" -ForegroundColor Yellow; return }
  $snaps = Get-ChildItem $SnapDir -Filter 'openclaw.json.*.bak' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
  if (-not $snaps -or $snaps.Count -eq 0) { Write-Host "没有可用快照。" -ForegroundColor Yellow; return }
  Write-Host "`n可用快照（用 -SnapshotPath 选择其一恢复）：" -ForegroundColor Cyan
  $snaps | ForEach-Object { Write-Host ("  {0}  ({1})" -f $_.FullName, $_.LastWriteTime) }
  Write-Host "`n提示：恢复配置不会删除任何 workspace / Agent 数据。" -ForegroundColor Yellow
  return
}

# 校验快照
if (-not [System.IO.Path]::IsPathRooted($SnapshotPath)) {
  $SnapshotPath = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $SnapshotPath))
}
if (-not (Test-Path $SnapshotPath)) { throw "快照不存在：$SnapshotPath" }
try { Get-Content -Raw $SnapshotPath | ConvertFrom-Json | Out-Null }
catch { throw "快照不是合法 JSON，拒绝恢复：$SnapshotPath" }

Write-Host "`n将用以下快照覆盖当前配置：" -ForegroundColor Yellow
Write-Host "  快照 : $SnapshotPath"
Write-Host "  目标 : $ConfigFilePath"
Write-Host "覆盖前会自动再次备份当前配置。不会删除任何 workspace / Agent 数据。" -ForegroundColor Yellow

if (-not $Yes) {
  $ans = Read-Host "确认恢复？输入 yes 继续，其它取消"
  if ($ans -ne 'yes') { Write-Host "已取消。"; return }
}

# 覆盖前再次备份当前配置
New-Item -ItemType Directory -Force -Path $SnapDir | Out-Null
if (Test-Path $ConfigFilePath) {
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $preRestore = Join-Path $SnapDir ("openclaw.json.$stamp.pre-restore.bak")
  Copy-Item -Path $ConfigFilePath -Destination $preRestore -Force
  Write-Host "已备份当前配置到：$preRestore" -ForegroundColor Green
} else {
  Write-Warning "当前配置文件不存在，恢复将直接写入：$ConfigFilePath"
}

Copy-Item -Path $SnapshotPath -Destination $ConfigFilePath -Force
Write-Host "已恢复配置。" -ForegroundColor Green

# 恢复后校验
$out = & openclaw config validate --json 2>&1
$ec = $LASTEXITCODE
Write-Host "config validate exit=$ec"
Write-Host $out
if ($ec -ne 0) { Write-Host "警告：恢复后 config validate 未通过，请检查。" -ForegroundColor Red }
Write-Host "`n提醒：如需清理 runtime workspace/worktree/artifacts，请手动删除；本脚本不做删除。" -ForegroundColor Yellow
