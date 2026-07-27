#requires -Version 7.0
<#
.SYNOPSIS
  清单驱动的静态安装验证；不修改 OpenClaw 配置。
#>
[CmdletBinding()]
param([switch]$SkipOpenClaw)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
. (Join-Path $ScriptDir 'component-lib.ps1')
$RuntimeRootAbs = Get-NormalizedPath (Join-Path $ProjectRoot 'runtime')

$Results = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Pass, [string]$Detail = '') {
  $status = if ($Pass) { 'PASS' } else { 'FAIL' }
  $Results.Add([pscustomobject]@{ check = $Name; status = $status; detail = $Detail })
  Write-Host ("[{0}] {1}{2}" -f $status, $Name, $(if ($Detail) { " — $Detail" } else { '' })) -ForegroundColor $(if ($Pass) { 'Green' } else { 'Red' })
}
function Test-Json([string]$Path) {
  try { Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -ErrorAction Stop | Out-Null; return $true } catch { return $false }
}
function Test-Throws([scriptblock]$Action) {
  try { & $Action; return $false } catch { return $true }
}

Write-Host '== package 驱动静态验证 ==' -ForegroundColor Cyan
Write-Host "ProjectRoot: $ProjectRoot"

$Packages = @()
try {
  $Packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs)
  Add-Check 'Agent package catalog 可加载' $true "packages=$($Packages.Count)"
} catch {
  Add-Check 'Agent package catalog 可加载' $false $_.Exception.Message
}

if ($Packages.Count -gt 0) {
  $core = @('AGENTS.md','SOUL.md','TOOLS.md','IDENTITY.md')
  foreach ($p in $Packages) {
    Add-Check "package workspace 存在: $($p.id)" (Test-Path -LiteralPath $p.workspace_source -PathType Container) $p.workspace_source
    foreach ($name in $core) { Add-Check "  $($p.id)/$name" (Test-Path -LiteralPath (Join-Path $p.workspace_source $name)) }
    if ($p.origin -eq 'builtin') {
      Add-Check "内置保护: $($p.id)" ($p.protected -and -not $p.deletable)
      Add-Check "内置 workspace 保持原目录: $($p.id)" (Test-PathWithin -Path $p.workspace_source -Root (Join-Path $ProjectRoot "agents\$($p.id)")) $p.workspace_source
    } else {
      Add-Check "生成 Agent 可修改标记: $($p.id)" (-not $p.protected -and $p.deletable)
      Add-Check "生成 workspace 位于隔离根: $($p.id)" (Test-PathWithin -Path $p.workspace_source -Root (Join-Path $ProjectRoot 'agents\packages\generated\agents'))
    }
  }
  $manager = Get-ManagerPackage $Packages
  $allow = @(Get-ManagerAllowAgents $Packages)
  Add-Check 'catalog 中唯一 manager' ($null -ne $manager) $manager.id
  Add-Check 'manager allowAgents 由 active/callable packages 计算' ($allow.Count -eq @($Packages | Where-Object { $_.role -ne 'manager' -and $_.register -and $_.active -and $_.callable_by_manager }).Count) ($allow -join ',')
  Add-Check '工作 Agent 默认不派生' (@($Packages | Where-Object { $_.role -ne 'manager' -and @($_.allow_agents).Count -ne 0 }).Count -eq 0)
}

$contractsDir = Join-Path $ProjectRoot 'contracts'
Get-ChildItem -LiteralPath $contractsDir -Filter '*.json' -File | ForEach-Object { Add-Check "contracts JSON: $($_.Name)" (Test-Json $_.FullName) }
$templatesDir = Join-Path $ProjectRoot 'templates'
Get-ChildItem -LiteralPath $templatesDir -Filter '*.json' -File | ForEach-Object { Add-Check "templates JSON: $($_.Name)" (Test-Json $_.FullName) }

$installPs1 = Join-Path $ScriptDir 'install.ps1'
$dryManifest = Join-Path $ProjectRoot 'artifacts\install-dryrun\install-manifest.dryrun.json'
$nonProjectCwd = if ($env:SystemRoot -and (Test-Path (Join-Path $env:SystemRoot 'System32'))) { Join-Path $env:SystemRoot 'System32' } else { [System.IO.Path]::GetTempPath() }
try {
  Push-Location $nonProjectCwd
  & pwsh -NoProfile -File $installPs1 -RuntimeRoot runtime | Out-Null
  Add-Check 'install.ps1 非项目 cwd dry-run 可执行' $true $nonProjectCwd
} catch {
  Add-Check 'install.ps1 非项目 cwd dry-run 可执行' $false $_.Exception.Message
} finally {
  Pop-Location
}

if (Test-Path -LiteralPath $dryManifest) {
  $manifest = Read-JsonFile $dryManifest
  Add-Check 'dry-run 清单 schema_version=2' ([int]$manifest.schema_version -eq 2)
  Add-Check 'dry-run runtime 路径与 cwd 无关' ([string]$manifest.runtime_root_abs -eq $RuntimeRootAbs) ([string]$manifest.runtime_root_abs)
  $expectedRegistered = @($Packages | Where-Object register)
  Add-Check 'dry-run Agent 数量来自 register=true packages' (@($manifest.agents).Count -eq $expectedRegistered.Count) "manifest=$(@($manifest.agents).Count), expected=$($expectedRegistered.Count)"
  $allAbsolute = $true
  foreach ($a in $manifest.agents) {
    foreach ($field in @('manifest_abs','workspace_source_abs','workspace_abs','agentDir_abs')) {
      if (-not [System.IO.Path]::IsPathRooted([string]$a.$field)) { $allAbsolute = $false }
    }
  }
  Add-Check 'dry-run package/source/runtime 路径全为绝对路径' $allAbsolute
  if ($Packages.Count -gt 0) {
    $manager = Get-ManagerPackage $Packages
    $managerManifest = @($manifest.agents | Where-Object id -eq $manager.id)[0]
    $expectedAllow = @(Get-ManagerAllowAgents $Packages)
    $actualAllow = @($managerManifest.subagents_allow)
    $sameAllow = $actualAllow.Count -eq $expectedAllow.Count -and @($expectedAllow | Where-Object { $actualAllow -notcontains $_ }).Count -eq 0
    Add-Check 'dry-run manager 白名单来自 catalog' $sameAllow ($actualAllow -join ',')
  }
} else {
  Add-Check 'dry-run 清单生成' $false $dryManifest
}

$componentSkill = Join-Path $ProjectRoot 'agents\packages\system\skills\agent-package-manager\SKILL.md'
if (Test-Path $componentSkill) {
  $text = Get-Content -Raw -LiteralPath $componentSkill
  Add-Check 'agent-package-manager Skill 含审批和保护协议' ($text -match 'manage-components' -and $text -match 'generated' -and $text -match 'approval')
} else {
  Add-Check 'agent-package-manager Skill 存在' $false $componentSkill
}

$approvalTestRoot = Get-NormalizedPath (Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-component-approval-{0}" -f [guid]::NewGuid().Guid))
try {
  New-Item -ItemType Directory -Force -Path $approvalTestRoot | Out-Null
  $requestPath = Join-Path $approvalTestRoot 'request.json'
  $approvalPath = Join-Path $approvalTestRoot 'approval.json'
  $requestFixture = [ordered]@{
    schema_version = 1; request_id = 'CMP-validation'; decision_id = 'DEC-validation'; workflow_id = 'WF-validation'
    component_type = 'agent'; proposed_id = 'validation-agent'; purpose = '验证审批边界'; capabilities = @('validation.test')
    requested_by = 'manager-agent'; created_at = '2026-01-01T00:00:00Z'
  }
  Write-JsonAtomic -Value $requestFixture -Path $requestPath
  $parsedRequest = Read-ComponentRequest $requestPath
  Add-Check '组件申请契约可执行校验' ([string]$parsedRequest.proposed_id -eq 'validation-agent')

  $approvalFixture = [ordered]@{
    decision_id = 'DEC-validation'; workflow_id = 'WF-validation'; outcome = 'APPROVED'; chosen_option_id = 'BUILD'
    raw_user_reply_summary = '用户批准构建验证组件'; decided_by = 'validation-user'; decided_at = '2026-01-01T00:00:00Z'
  }
  Write-JsonAtomic -Value $approvalFixture -Path $approvalPath
  Assert-ApprovalResponse -Path $approvalPath -DecisionId 'DEC-validation' -AllowedChoices @('BUILD') -ExpectedWorkflowId 'WF-validation' | Out-Null
  Add-Check '审批响应允许匹配的人工批准' $true

  $approvalFixture.outcome = 'REJECTED'
  $approvalFixture.chosen_option_id = 'BUILD'
  Write-JsonAtomic -Value $approvalFixture -Path $approvalPath
  Add-Check '审批响应拒绝 REJECTED 结果' (Test-Throws { Assert-ApprovalResponse -Path $approvalPath -DecisionId 'DEC-validation' -AllowedChoices @('BUILD') -ExpectedWorkflowId 'WF-validation' | Out-Null })

  $approvalFixture.outcome = 'APPROVED'
  Write-JsonAtomic -Value $approvalFixture -Path $approvalPath
  Add-Check '审批响应拒绝跨 workflow 复用' (Test-Throws { Assert-ApprovalResponse -Path $approvalPath -DecisionId 'DEC-validation' -AllowedChoices @('BUILD') -ExpectedWorkflowId 'WF-other' | Out-Null })

  $requestFixture.proposed_id = 'invalid-'
  Write-JsonAtomic -Value $requestFixture -Path $requestPath
  Add-Check '组件申请拒绝尾部连字符 ID' (Test-Throws { Read-ComponentRequest $requestPath | Out-Null })
} catch {
  Add-Check '组件审批边界测试可执行' $false $_.Exception.Message
} finally {
  $tempRoot = Get-NormalizedPath ([System.IO.Path]::GetTempPath())
  if ((Test-Path -LiteralPath $approvalTestRoot) -and (Test-PathWithin -Path $approvalTestRoot -Root $tempRoot)) {
    Remove-Item -LiteralPath $approvalTestRoot -Recurse -Force
  }
}

$promptFiles = Get-ChildItem (Join-Path $ProjectRoot 'agents') -Recurse -Filter '*.md' -File
$badLegacy = @($promptFiles | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'python\s+-m\s+src\.openclaw_sdlc|sdlcctl' })
$badLegacyDetail = if ($badLegacy.Count -gt 0) { @($badLegacy | ForEach-Object FullName) -join '; ' } else { '' }
Add-Check '运行时 Prompt 不依赖旧 Python 控制面' ($badLegacy.Count -eq 0) $badLegacyDetail

if (-not $SkipOpenClaw) {
  if (Get-Command openclaw -ErrorAction SilentlyContinue) {
    $validateOut = & openclaw config validate --json 2>&1
    Add-Check 'openclaw config validate --json' ($LASTEXITCODE -eq 0) ($validateOut -join "`n")
    $skillOut = & openclaw skills info skill-creator --agent (Get-ManagerPackage $Packages).id --json 2>&1
    Add-Check '成熟 skill-creator 对 manager 可用' ($LASTEXITCODE -eq 0) (($skillOut -join "`n") | Select-Object -First 1)
  } else {
    Add-Check 'openclaw CLI 可用' $false '未找到 openclaw；离线验证请使用 -SkipOpenClaw'
  }
}

$failures = @($Results | Where-Object status -eq 'FAIL')
$logDir = Join-Path $ProjectRoot 'artifacts\validation'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("validate-install.{0}.json" -f (Get-Date).ToString('yyyyMMdd-HHmmss'))
Write-JsonAtomic -Value @($Results) -Path $logPath -Depth 6
Write-Host "`n== 汇总：$($Results.Count) 项，失败 $($failures.Count) 项 ==" -ForegroundColor Cyan
Write-Host "日志：$logPath"
if ($failures.Count -gt 0) { exit 1 }
Write-Host '全部通过。' -ForegroundColor Green
