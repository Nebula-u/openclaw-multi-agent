#requires -Version 7.0
<#
.SYNOPSIS
  管理 package catalog、审批式生成 Agent，以及 OpenClaw Skill Workshop 生命周期。
.DESCRIPTION
  任何创建、激活或删除操作都要求 approval-response.json。内置 Agent 永远只读，
  只有 agents/packages/generated 下的组件可以被修改或删除。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet('List','Validate','NewAgent','SetAgentState','RemoveAgent','ProposeSkill','ApplySkill','RemoveSkill')]
  [string]$Command,
  [string]$Id,
  [string]$Request,
  [string]$ApprovalResponse,
  [ValidateSet('RegisteredInactive','Active','Inactive')]
  [string]$State,
  [string]$TargetAgent,
  [string]$ProposalId,
  [string]$RuntimeRoot = 'runtime',
  [switch]$Apply,
  [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = $PSScriptRoot
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $ScriptDir '..'))
. (Join-Path $ScriptDir 'component-lib.ps1')
$RuntimeRootAbs = if ([System.IO.Path]::IsPathRooted($RuntimeRoot)) { Get-NormalizedPath $RuntimeRoot } else { Get-NormalizedPath (Join-Path $ProjectRoot $RuntimeRoot) }
$GeneratedAgentsRoot = Get-NormalizedPath (Join-Path $ProjectRoot 'agents\packages\generated\agents')
$GeneratedSkillsRoot = Get-NormalizedPath (Join-Path $ProjectRoot 'agents\packages\generated\skills')

function Require-Value([string]$Value, [string]$Name) {
  if (-not $Value) { throw "缺少参数 -$Name。" }
}

function Invoke-OpenClaw {
  param([Parameter(Mandatory)][string[]]$OcArgs)
  $out = & openclaw @OcArgs 2>&1
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
}

function Get-PackageById([string]$AgentId) {
  $packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs)
  $matches = @($packages | Where-Object id -eq $AgentId)
  if ($matches.Count -ne 1) { throw "未找到唯一 Agent package：$AgentId" }
  return $matches[0]
}

function Invoke-CatalogSync {
  & (Join-Path $ScriptDir 'install.ps1') -Apply -Yes -RuntimeRoot $RuntimeRootAbs
}

function Confirm-DestructiveAction([string]$Message) {
  if (-not $Apply) { return }
  if ($Yes) { return }
  $answer = Read-Host "$Message 输入 yes 继续"
  if ($answer -ne 'yes') { throw '操作已取消。' }
}

function New-BuildResult {
  param($ComponentRequest, [string]$Type, [string]$ComponentId, [string]$Status, [string]$PackagePath)
  return [ordered]@{
    schema_version = 1
    request_id = [string]$ComponentRequest.request_id
    component_type = $Type
    component_id = $ComponentId
    status = $Status
    package_path_abs = $PackagePath
    validation = [ordered]@{
      passed = $true
      checks = @(
        [ordered]@{ name = 'approval'; status = 'PASS' },
        [ordered]@{ name = 'generated-path-boundary'; status = 'PASS' },
        [ordered]@{ name = 'package-structure'; status = 'PASS' }
      )
    }
    created_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
}

function Write-BuildResult($Result) {
  $path = Join-Path $RuntimeRootAbs ("control\component-builds\{0}.json" -f $Result.request_id)
  Write-JsonAtomic -Value $Result -Path $path -Depth 12
  return $path
}

switch ($Command) {
  'List' {
    $packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs)
    $rows = foreach ($p in $packages) {
      [pscustomobject]@{
        id = $p.id
        origin = $p.origin
        protected = $p.protected
        register = $p.register
        active = $p.active
        capabilities = ($p.capabilities -join ',')
        manifest = $p.manifest_path
      }
    }
    $rows | Format-Table -AutoSize
    break
  }

  'Validate' {
    $packages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs)
    Write-Host "Agent package 校验通过：$($packages.Count) 个。" -ForegroundColor Green
    Write-Host "Manager allowAgents: $((Get-ManagerAllowAgents $packages) -join ', ')"
    break
  }

  'NewAgent' {
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.component_type -ne 'agent') { throw '组件申请类型不是 agent。' }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices @('BUILD') -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $agentId = [string]$componentRequest.proposed_id
    if ($Id -and $Id -ne $agentId) { throw "-Id 与 request.proposed_id 不一致。" }

    $allPackages = @(Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs)
    if (@($allPackages | Where-Object id -eq $agentId).Count -gt 0) { throw "Agent ID 已存在：$agentId" }
    $packageRoot = Get-NormalizedPath (Join-Path $GeneratedAgentsRoot $agentId)
    if (-not (Test-PathWithin -Path $packageRoot -Root $GeneratedAgentsRoot)) { throw '生成 Agent 路径逃逸。' }
    if (Test-Path -LiteralPath $packageRoot) { throw "生成目录已存在：$packageRoot" }

    if (-not $Apply) {
      Write-Host "[PLAN] 将在 $packageRoot 创建未注册、未激活 Agent '$agentId'。"
      return
    }
    Confirm-DestructiveAction "将创建生成 Agent '$agentId'。"

    $workspace = Join-Path $packageRoot 'workspace'
    New-Item -ItemType Directory -Force -Path $workspace | Out-Null
    $templateRoot = Join-Path $ProjectRoot 'templates\generated-agent\workspace'
    Copy-Item -Path (Join-Path $templateRoot '*') -Destination $workspace -Recurse -Force
    $capabilities = @($componentRequest.capabilities | ForEach-Object { [string]$_ })
    $capabilityText = if ($capabilities.Count -gt 0) { $capabilities -join ', ' } else { '未声明' }
    foreach ($file in Get-ChildItem -LiteralPath $workspace -File) {
      $text = Get-Content -Raw -LiteralPath $file.FullName
      $text = $text.Replace('{{AGENT_ID}}', $agentId).Replace('{{PURPOSE}}', [string]$componentRequest.purpose).Replace('{{CAPABILITIES}}', $capabilityText)
      Set-Content -LiteralPath $file.FullName -Value $text -Encoding utf8
    }

    $model = if ($componentRequest.PSObject.Properties.Name -contains 'model') { [string]$componentRequest.model } else { '' }
    $workflowId = if ($componentRequest.PSObject.Properties.Name -contains 'workflow_id') { $componentRequest.workflow_id } else { $null }
    $manifest = [ordered]@{
      schema_version = 1
      kind = 'openclaw-agent-package'
      id = $agentId
      display_name = $agentId
      description = [string]$componentRequest.purpose
      origin = 'generated'
      protected = $false
      deletable = $true
      workspace_source_rel = "agents/packages/generated/agents/$agentId/workspace"
      runtime_subdir = "agents/generated/$agentId"
      role = 'worker'
      capabilities = @($capabilities)
      model = $model
      delegation = [ordered]@{ callable_by_manager = $true; allow_agents = @() }
      sandbox_mode = $null
      assembly = [ordered]@{ include_common_rules = $true; include_templates = $false }
      skills = @()
      lifecycle = [ordered]@{ register = $false; active = $false }
      created_by = 'manager-agent'
      created_from_workflow = $workflowId
      created_from_request = [string]$componentRequest.request_id
    }
    $manifestPath = Join-Path $packageRoot 'agent.json'
    Write-JsonAtomic -Value $manifest -Path $manifestPath -Depth 12

    $hashLines = foreach ($file in Get-ChildItem -LiteralPath $workspace -File -Recurse | Sort-Object FullName) {
      $relative = [System.IO.Path]::GetRelativePath($packageRoot, $file.FullName).Replace('\','/')
      "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant(), $relative
    }
    $hashLines | Set-Content -LiteralPath (Join-Path $packageRoot 'checksums.sha256') -Encoding utf8

    Get-AgentPackages -ProjectRoot $ProjectRoot -RuntimeRootAbs $RuntimeRootAbs | Out-Null
    $result = New-BuildResult -ComponentRequest $componentRequest -Type 'agent' -ComponentId $agentId -Status 'VALIDATED' -PackagePath $packageRoot
    $resultPath = Write-BuildResult $result
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = $result.created_at; action = 'BUILD'; component_type = 'agent'; component_id = $agentId
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = $packageRoot
    })
    Write-Host "生成 Agent 已构建并校验，尚未注册或激活：$packageRoot" -ForegroundColor Green
    Write-Host "构建结果：$resultPath"
    break
  }

  'SetAgentState' {
    Require-Value $Id 'Id'
    Require-Value $State 'State'
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.proposed_id -ne $Id) { throw '组件申请与 Agent ID 不匹配。' }
    $allowed = switch ($State) {
      'RegisteredInactive' { @('REGISTER','KEEP_INACTIVE') }
      'Active' { @('ACTIVATE') }
      'Inactive' { @('DEACTIVATE','KEEP_INACTIVE') }
    }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices $allowed -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $package = Get-PackageById $Id
    Assert-GeneratedAgentPackage -Package $package -ProjectRoot $ProjectRoot
    $raw = $package.raw
    $previousRaw = Read-JsonFile $package.manifest_path
    switch ($State) {
      'RegisteredInactive' { $raw.lifecycle.register = $true; $raw.lifecycle.active = $false }
      'Active' { $raw.lifecycle.register = $true; $raw.lifecycle.active = $true }
      'Inactive' { $raw.lifecycle.register = $true; $raw.lifecycle.active = $false }
    }
    if (-not $Apply) {
      Write-Host "[PLAN] 将 Agent '$Id' 状态设为 $State，并重新计算 manager allowAgents。"
      return
    }
    Write-JsonAtomic -Value $raw -Path $package.manifest_path -Depth 12
    try {
      Invoke-CatalogSync
    } catch {
      Write-JsonAtomic -Value $previousRaw -Path $package.manifest_path -Depth 12
      throw
    }
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = $now; action = $State.ToUpperInvariant(); component_type = 'agent'; component_id = $Id
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = (Split-Path -Parent $package.manifest_path)
    })
    Write-Host "Agent '$Id' 状态已更新为 $State。" -ForegroundColor Green
    break
  }

  'RemoveAgent' {
    Require-Value $Id 'Id'
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.proposed_id -ne $Id) { throw '组件申请与 Agent ID 不匹配。' }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices @('DELETE') -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $package = Get-PackageById $Id
    Assert-GeneratedAgentPackage -Package $package -ProjectRoot $ProjectRoot
    $packageRoot = Get-NormalizedPath (Split-Path -Parent $package.manifest_path)
    if (-not (Test-PathWithin -Path $packageRoot -Root $GeneratedAgentsRoot)) { throw '拒绝删除：package 路径不在 generated 根。' }
    if (-not $Apply) {
      Write-Host "[PLAN] 将先从 manager allowAgents 移除，再删除 OpenClaw Agent 和生成目录：$packageRoot"
      return
    }
    Confirm-DestructiveAction "将永久删除生成 Agent '$Id' 的 package、runtime workspace 和 state。"

    $original = Read-JsonFile $package.manifest_path
    try {
      $original.lifecycle.active = $false
      Write-JsonAtomic -Value $original -Path $package.manifest_path -Depth 12
      if ($package.register) { Invoke-CatalogSync }
      $listed = Invoke-OpenClaw @('agents','list','--json')
      if ($listed.ExitCode -eq 0) {
        $ids = @(ConvertFrom-OpenClawJsonOutput -Output $listed.Output -Description 'openclaw agents list --json 输出' |
          ForEach-Object { [string]$_.id })
        if ($ids -contains $Id) {
          $deleted = Invoke-OpenClaw @('agents','delete',$Id,'--force','--json')
          if ($deleted.ExitCode -ne 0) { throw "OpenClaw Agent 删除失败：$($deleted.Output)" }
        }
      }
      Remove-Item -LiteralPath $packageRoot -Recurse -Force
      # 刷新 install-manifest，使最终期望状态不再包含已删除组件。
      Invoke-CatalogSync
    } catch {
      if (Test-Path -LiteralPath $packageRoot) { Write-JsonAtomic -Value $package.raw -Path $package.manifest_path -Depth 12 }
      throw
    }
    $now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = $now; action = 'DELETE'; component_type = 'agent'; component_id = $Id
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = $packageRoot
    })
    Write-Host "生成 Agent '$Id' 已删除；审计记录已保留。" -ForegroundColor Yellow
    break
  }

  'ProposeSkill' {
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    Require-Value $TargetAgent 'TargetAgent'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.component_type -ne 'skill') { throw '组件申请类型不是 skill。' }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices @('BUILD') -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $skillId = [string]$componentRequest.proposed_id
    if ($componentRequest.PSObject.Properties.Name -contains 'target_agent_id' -and $componentRequest.target_agent_id -and [string]$componentRequest.target_agent_id -ne $TargetAgent) {
      throw '组件申请的 target_agent_id 与 -TargetAgent 不一致。'
    }
    $target = Get-PackageById $TargetAgent
    Assert-GeneratedAgentPackage -Package $target -ProjectRoot $ProjectRoot
    if (-not $target.register) { throw '目标生成 Agent 必须先注册为 inactive，才能使用 OpenClaw Skill Workshop。' }
    $skillRoot = Get-NormalizedPath (Join-Path $GeneratedSkillsRoot $skillId)
    if (-not (Test-PathWithin -Path $skillRoot -Root $GeneratedSkillsRoot)) { throw 'Skill 路径逃逸 generated 根。' }
    $skillMd = Join-Path $skillRoot 'SKILL.md'
    if (-not (Test-Path -LiteralPath $skillMd)) {
      throw "缺少 $skillMd。请先使用 OpenClaw bundled skill-creator 在该目录生成并验证 Skill。"
    }
    $proposalMd = Join-Path $skillRoot 'PROPOSAL.md'
    $manifestPath = Join-Path $skillRoot 'skill.json'
    $workflowId = if ($componentRequest.PSObject.Properties.Name -contains 'workflow_id') { $componentRequest.workflow_id } else { $null }
    $manifest = [ordered]@{
      schema_version = 1; kind = 'openclaw-skill-package'; name = $skillId; origin = 'generated'; protected = $false; deletable = $true
      description = [string]$componentRequest.purpose; created_by = 'manager-agent'; created_from_workflow = $workflowId
      created_from_request = [string]$componentRequest.request_id; target_agent_id = $TargetAgent; workshop_proposal_id = $null
      lifecycle = [ordered]@{ status = 'DRAFT' }
    }
    if (-not $Apply) {
      Write-Host "[PLAN] 将为生成 Agent '$TargetAgent' 提交 Skill Workshop proposal：$skillRoot"
      return
    }
    if (-not (Test-Path -LiteralPath $proposalMd)) {
      @("# $skillId",'',[string]$componentRequest.purpose,'',"目标 Agent: $TargetAgent") | Set-Content -LiteralPath $proposalMd -Encoding utf8
    }
    Write-JsonAtomic -Value $manifest -Path $manifestPath -Depth 10
    $proposed = Invoke-OpenClaw @('skills','workshop','--agent',$TargetAgent,'propose-create','--name',$skillId,'--description',[string]$componentRequest.purpose,'--goal',[string]$componentRequest.purpose,'--proposal-dir',$skillRoot,'--json')
    if ($proposed.ExitCode -ne 0) { throw "Skill Workshop proposal 创建失败：$($proposed.Output)" }
    $proposal = $proposed.Output | ConvertFrom-Json
    $proposalValue = if ($proposal.PSObject.Properties.Name -contains 'proposalId') { [string]$proposal.proposalId } elseif ($proposal.PSObject.Properties.Name -contains 'id') { [string]$proposal.id } else { '' }
    if (-not $proposalValue) { throw 'Skill Workshop 输出中缺少 proposal id。' }
    $manifest.workshop_proposal_id = $proposalValue
    $manifest.lifecycle.status = 'PROPOSED'
    Write-JsonAtomic -Value $manifest -Path $manifestPath -Depth 10
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); action = 'PROPOSE'; component_type = 'skill'; component_id = $skillId
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = $skillRoot; target_agent_id = $TargetAgent
    })
    Write-Host "Skill proposal 已创建：$proposalValue。应用前仍需第二次用户审批。" -ForegroundColor Green
    break
  }

  'ApplySkill' {
    Require-Value $Id 'Id'
    Require-Value $ProposalId 'ProposalId'
    Require-Value $TargetAgent 'TargetAgent'
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.component_type -ne 'skill' -or [string]$componentRequest.proposed_id -ne $Id) { throw 'Skill 申请与 -Id 不匹配。' }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices @('ACTIVATE','APPLY') -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $target = Get-PackageById $TargetAgent
    Assert-GeneratedAgentPackage -Package $target -ProjectRoot $ProjectRoot
    $skillRoot = Get-NormalizedPath (Join-Path $GeneratedSkillsRoot $Id)
    $manifestPath = Join-Path $skillRoot 'skill.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Skill package 不存在：$Id" }
    $manifest = Read-JsonFile $manifestPath
    if ([string]$manifest.origin -ne 'generated' -or [bool]$manifest.protected -or -not [bool]$manifest.deletable) { throw "Skill package '$Id' 不是可修改的生成 Skill。" }
    if ([string]$manifest.target_agent_id -ne $TargetAgent) { throw 'Skill package 与目标 Agent 不一致。' }
    if ([string]$manifest.workshop_proposal_id -ne $ProposalId) { throw 'Skill package 与 proposal id 不一致。' }
    if (-not $Apply) { Write-Host "[PLAN] 将 proposal '$ProposalId' 应用到生成 Agent '$TargetAgent'。"; return }
    $applied = Invoke-OpenClaw @('skills','workshop','--agent',$TargetAgent,'apply',$ProposalId,'--json')
    if ($applied.ExitCode -ne 0) { throw "Skill Workshop apply 失败：$($applied.Output)" }
    $check = Invoke-OpenClaw @('skills','check','--agent',$TargetAgent,'--json')
    if ($check.ExitCode -ne 0) { throw "Skill 应用后检查失败：$($check.Output)" }
    $manifest.lifecycle.status = 'APPLIED'
    Write-JsonAtomic -Value $manifest -Path $manifestPath -Depth 10
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); action = 'APPLY'; component_type = 'skill'; component_id = $Id
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = $skillRoot; target_agent_id = $TargetAgent
    })
    Write-Host "Skill '$Id' 已应用到生成 Agent '$TargetAgent'。" -ForegroundColor Green
    break
  }

  'RemoveSkill' {
    Require-Value $Id 'Id'
    Require-Value $TargetAgent 'TargetAgent'
    Require-Value $Request 'Request'
    Require-Value $ApprovalResponse 'ApprovalResponse'
    $componentRequest = Read-ComponentRequest $Request
    if ([string]$componentRequest.component_type -ne 'skill' -or [string]$componentRequest.proposed_id -ne $Id) { throw 'Skill 申请与 -Id 不匹配。' }
    Assert-ApprovalResponse -Path $ApprovalResponse -DecisionId ([string]$componentRequest.decision_id) -AllowedChoices @('DELETE') -ExpectedWorkflowId (Get-ComponentWorkflowId $componentRequest) | Out-Null
    $target = Get-PackageById $TargetAgent
    Assert-GeneratedAgentPackage -Package $target -ProjectRoot $ProjectRoot
    $skillRoot = Get-NormalizedPath (Join-Path $GeneratedSkillsRoot $Id)
    if (-not (Test-PathWithin -Path $skillRoot -Root $GeneratedSkillsRoot)) { throw '拒绝删除：Skill source 不在 generated 根。' }
    $manifestPath = Join-Path $skillRoot 'skill.json'
    if (Test-Path -LiteralPath $manifestPath) {
      $manifest = Read-JsonFile $manifestPath
      if ([string]$manifest.origin -ne 'generated' -or [bool]$manifest.protected -or -not [bool]$manifest.deletable) { throw "Skill package '$Id' 不是可删除的生成 Skill。" }
      if ([string]$manifest.target_agent_id -ne $TargetAgent) { throw 'Skill package 与目标 Agent 不一致。' }
    }
    $runtimeSkill = Get-NormalizedPath (Join-Path $target.workspace ("skills\$Id"))
    if (-not (Test-PathWithin -Path $runtimeSkill -Root $target.workspace)) { throw '拒绝删除：runtime Skill 路径逃逸目标 Agent workspace。' }
    if (-not $Apply) { Write-Host "[PLAN] 将删除生成 Skill source 和目标生成 Agent 中的 Skill：$Id"; return }
    Confirm-DestructiveAction "将永久删除生成 Skill '$Id'。"
    if (Test-Path -LiteralPath $runtimeSkill) { Remove-Item -LiteralPath $runtimeSkill -Recurse -Force }
    if (Test-Path -LiteralPath $skillRoot) { Remove-Item -LiteralPath $skillRoot -Recurse -Force }
    Update-GeneratedComponentAudit -RuntimeRootAbs $RuntimeRootAbs -Entry ([ordered]@{
      timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); action = 'DELETE'; component_type = 'skill'; component_id = $Id
      request_id = [string]$componentRequest.request_id; decision_id = [string]$componentRequest.decision_id; package_path_abs = $skillRoot; target_agent_id = $TargetAgent
    })
    Write-Host "生成 Skill '$Id' 已删除。" -ForegroundColor Yellow
    break
  }
}
