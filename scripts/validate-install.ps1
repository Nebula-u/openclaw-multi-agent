#requires -Version 7.0
<#
.SYNOPSIS
  openclaw-sdlc-multi-agent 静态安装验证（不修改任何配置）。
.DESCRIPTION
  纯静态 + 只读校验，覆盖项目规范“安装和项目自身验证”条目：
  源 workspace 完整性、契约/模板 JSON 合法性、安装计划绝对路径与互异、
  manager 白名单 / 工作 Agent 空白名单、manager 调度协议存在、
  运行时 Prompt 无 sdlcctl/Python 控制平面依赖、test-agent 含 UNSANDBOXED_LOCAL、
  非项目 cwd dry-run 路径仍正确、openclaw config validate。
  任何硬性检查失败则退出码非 0；完整日志写入 artifacts/validation/。
#>
[CmdletBinding()]
param(
  [switch]$SkipOpenClaw   # 跳过需要 openclaw CLI 的检查（离线静态校验）
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir   = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
$AgentIds = @('manager-agent','requirement-agent','architect-agent','developer-agent','review-agent','test-agent','release-agent')
$WorkerIds = $AgentIds | Where-Object { $_ -ne 'manager-agent' }

$Results = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Pass, [string]$Detail='') {
  $status = if ($Pass) { 'PASS' } else { 'FAIL' }
  $Results.Add([pscustomobject]@{ check=$Name; status=$status; detail=$Detail })
  $c = if ($Pass) { 'Green' } else { 'Red' }
  $suffix = if ($Detail) { " — $Detail" } else { '' }
  Write-Host ("[{0}] {1}{2}" -f $status, $Name, $suffix) -ForegroundColor $c
}
function Test-Json([string]$Path) {
  try { Get-Content -Raw -Path $Path -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop | Out-Null; return $true }
  catch { return $false }
}

Write-Host "== 静态安装验证 ==" -ForegroundColor Cyan
Write-Host "ProjectRoot: $ProjectRoot"

# 1 + 2. 7 个源 workspace 存在，且各含 4 个核心文件
$core = @('AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md')
foreach ($id in $AgentIds) {
  $ws = Join-Path $ProjectRoot "agents\$id\workspace"
  Add-Check "workspace 存在: $id" (Test-Path $ws) $ws
  foreach ($f in $core) {
    $p = Join-Path $ws $f
    Add-Check "  $id/$f" (Test-Path $p) ''
  }
}

# 3. contracts JSON 合法
$contractsDir = Join-Path $ProjectRoot 'contracts'
if (Test-Path $contractsDir) {
  Get-ChildItem $contractsDir -Filter *.json | ForEach-Object {
    Add-Check "contracts JSON: $($_.Name)" (Test-Json $_.FullName)
  }
} else { Add-Check "contracts 目录存在" $false $contractsDir }

# 4. templates JSON / JSONL 合法
$templatesDir = Join-Path $ProjectRoot 'templates'
if (Test-Path $templatesDir) {
  Get-ChildItem $templatesDir -Filter *.json | ForEach-Object {
    Add-Check "templates JSON: $($_.Name)" (Test-Json $_.FullName)
  }
  Get-ChildItem $templatesDir -Filter *.jsonl | ForEach-Object {
    $ok = $true; $ln = 0
    foreach ($line in (Get-Content -Path $_.FullName)) {
      $ln++
      if ($line.Trim() -eq '') { continue }
      try { $line | ConvertFrom-Json -ErrorAction Stop | Out-Null } catch { $ok=$false; break }
    }
    $jd = if ($ok) { '' } else { "第 $ln 行非法" }
    Add-Check "templates JSONL: $($_.Name)" $ok $jd
  }
} else { Add-Check "templates 目录存在" $false "$templatesDir（可能仍在生成）" }

# 5-9 + 15. 运行 install.ps1 dry-run（从非项目目录，验证 cwd 无关）并检查计划
$installPs1 = Join-Path $ScriptDir 'install.ps1'
$dryManifest = Join-Path $ProjectRoot 'artifacts\install-dryrun\install-manifest.dryrun.json'
$nonProjectCwd = if (Test-Path (Join-Path $env:SystemRoot 'System32')) { Join-Path $env:SystemRoot 'System32' } else { [System.IO.Path]::GetTempPath() }
try {
  Push-Location $nonProjectCwd
  & pwsh -NoProfile -File $installPs1 -RuntimeRoot 'runtime' | Out-Null
} catch {
  Add-Check "install.ps1 dry-run 可执行" $false $_.Exception.Message
} finally {
  Pop-Location
}

if (Test-Path $dryManifest) {
  $m = Get-Content -Raw $dryManifest | ConvertFrom-Json
  Add-Check "dry-run 清单生成" $true $dryManifest
  # 15. cwd 无关：runtime_root_abs 必须位于项目根下，而非 System32
  $rr = [string]$m.runtime_root_abs
  Add-Check "非项目 cwd dry-run 路径仍指向项目 (System32 防护)" ($rr.StartsWith($ProjectRoot)) "runtime_root_abs=$rr (from cwd=$nonProjectCwd)"
  # 5. 所有 workspace/agentDir 绝对
  $allAbs = $true; $wsSeen=@(); $dirSeen=@()
  foreach ($a in $m.agents) {
    if (-not [System.IO.Path]::IsPathRooted([string]$a.workspace_abs)) { $allAbs=$false }
    if (-not [System.IO.Path]::IsPathRooted([string]$a.agentDir_abs))  { $allAbs=$false }
    $wsSeen += [string]$a.workspace_abs; $dirSeen += [string]$a.agentDir_abs
  }
  Add-Check "安装计划中 workspace/agentDir 全为绝对路径" $allAbs
  # 6 + 7. 互异
  Add-Check "7 个 workspace 彼此不同" (($wsSeen | Sort-Object -Unique).Count -eq $AgentIds.Count)
  Add-Check "7 个 agentDir 彼此不同" (($dirSeen | Sort-Object -Unique).Count -eq $AgentIds.Count)
  # 8. manager 白名单 = 6 工作 Agent
  $mgr = $m.agents | Where-Object { $_.id -eq 'manager-agent' } | Select-Object -First 1
  $mgrAllow = @($mgr.subagents_allow)
  $allowOk = ($mgrAllow.Count -eq 6) -and (@($WorkerIds | Where-Object { $mgrAllow -notcontains $_ }).Count -eq 0)
  Add-Check "manager 白名单 = 6 个工作 Agent" $allowOk ($mgrAllow -join ',')
  Add-Check "manager requireAgentId = true" ([bool]$mgr.require_agent_id)
  # 9. 工作 Agent 空白名单
  $workersEmpty = $true
  foreach ($a in ($m.agents | Where-Object { $_.id -ne 'manager-agent' })) {
    if (@($a.subagents_allow).Count -ne 0) { $workersEmpty=$false }
  }
  Add-Check "工作 Agent allowAgents 均为空（禁止再派生）" $workersEmpty
  # test-agent sandbox=off
  $ta = $m.agents | Where-Object { $_.id -eq 'test-agent' } | Select-Object -First 1
  Add-Check "test-agent sandbox_mode = off" ([string]$ta.sandbox_mode -eq 'off')
} else {
  Add-Check "dry-run 清单生成" $false $dryManifest
}

# 11. manager Prompt 含原生调度协议关键词
$mgrAgents = Join-Path $ProjectRoot 'agents\manager-agent\workspace\AGENTS.md'
if (Test-Path $mgrAgents) {
  $txt = Get-Content -Raw $mgrAgents
  $hasSched = ($txt -match 'sessions_spawn' -or $txt -match 'agentId') -and ($txt -match '调度' -or $txt -match 'dispatch')
  Add-Check "manager AGENTS.md 含原生调度协议 (agentId/sessions_spawn + 调度)" $hasSched
} else { Add-Check "manager AGENTS.md 存在" $false }

# 12. 运行时 Prompt 无 sdlcctl / 旧 Python 控制平面依赖
$promptFiles = Get-ChildItem (Join-Path $ProjectRoot 'agents') -Recurse -Filter *.md -ErrorAction SilentlyContinue
$badSdlcctl = @(); $badPy = @()
foreach ($f in $promptFiles) {
  $t = Get-Content -Raw $f.FullName
  if ($t -match 'sdlcctl') { $badSdlcctl += $f.FullName }
  # 依赖式调用（区别于“禁止 Python 控制平面”的描述）
  if ($t -match 'python\s+-m\s+src\.openclaw_sdlc' -or $t -match 'openclaw_sdlc\.') { $badPy += $f.FullName }
}
Add-Check "运行时 Prompt 不含 sdlcctl" ($badSdlcctl.Count -eq 0) ($badSdlcctl -join '; ')
Add-Check "运行时 Prompt 不依赖旧 Python 控制平面 (openclaw_sdlc)" ($badPy.Count -eq 0) ($badPy -join '; ')

# 13. test-agent Prompt 含 UNSANDBOXED_LOCAL
$taAgents = Join-Path $ProjectRoot 'agents\test-agent\workspace\AGENTS.md'
if (Test-Path $taAgents) {
  Add-Check "test-agent AGENTS.md 含 UNSANDBOXED_LOCAL" ((Get-Content -Raw $taAgents) -match 'UNSANDBOXED_LOCAL')
} else { Add-Check "test-agent AGENTS.md 存在" $false }

# 14. 模板/契约要求绝对路径字段（抽查 task.schema.json 与 templates/task.json）
$taskSchema = Join-Path $contractsDir 'task.schema.json'
if (Test-Path $taskSchema) {
  $s = Get-Content -Raw $taskSchema
  Add-Check "task.schema.json 含 *_abs 绝对路径字段" ($s -match 'worktree_path_abs' -and $s -match 'artifact_root_abs')
}

# 16. openclaw config validate（可选）
if (-not $SkipOpenClaw) {
  $oc = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($oc) {
    $out = & openclaw config validate --json 2>&1
    $ec = $LASTEXITCODE
    Add-Check "openclaw config validate --json (记录退出码)" ($ec -eq 0) "exit=$ec"
  } else {
    Add-Check "openclaw CLI 可用" $false "未找到 openclaw，跳过 config validate（用 -SkipOpenClaw 显式跳过）"
  }
}

# 汇总 + 写日志
$fail = @($Results | Where-Object { $_.status -eq 'FAIL' })
$logDir = Join-Path $ProjectRoot 'artifacts\validation'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$logPath = Join-Path $logDir "validate-install.$stamp.json"
($Results | ConvertTo-Json -Depth 5) | Set-Content -Encoding UTF8 -Path $logPath

Write-Host "`n== 汇总：$($Results.Count) 项检查，失败 $($fail.Count) 项 ==" -ForegroundColor Cyan
Write-Host "日志：$logPath"
if ($fail.Count -gt 0) { exit 1 } else { Write-Host "全部通过。" -ForegroundColor Green; exit 0 }
