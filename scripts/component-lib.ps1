#requires -Version 7.0

Set-StrictMode -Version Latest

function Get-NormalizedPath {
  param([Parameter(Mandatory)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-PathWithin {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Root
  )
  $pathAbs = Get-NormalizedPath $Path
  $rootAbs = (Get-NormalizedPath $Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  if ($pathAbs.Equals($rootAbs, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  $prefix = $rootAbs + [System.IO.Path]::DirectorySeparatorChar
  return $pathAbs.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Read-JsonFile {
  param([Parameter(Mandatory)][string]$Path)
  try {
    return Get-Content -Raw -LiteralPath $Path -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "JSON 文件不可解析：$Path — $($_.Exception.Message)"
  }
}

function ConvertFrom-OpenClawJsonOutput {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$Output,
    [string]$Description = 'OpenClaw JSON output'
  )

  $ingestionCli = Join-Path $PSScriptRoot 'runtime-core\json-ingestion-cli.mjs'
  if (-not (Test-Path -LiteralPath $ingestionCli)) { throw "$Description 无法调用统一 JSON 入库器：$ingestionCli" }
  $rawResult = $Output | & node $ingestionCli 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$Description 不可解析；统一 JSON 入库器拒绝了输出：$($rawResult -join "`n")" }
  try { $result = ($rawResult -join "`n") | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "$Description 的统一 JSON 入库器返回无效：$($_.Exception.Message)" }
  if (-not $result.ok) { throw "$Description 不可解析；诊断=$($result.diagnostic)" }
  return $result.value
}

function Write-JsonAtomic {
  param(
    [Parameter(Mandatory)]$Value,
    [Parameter(Mandatory)][string]$Path,
    [int]$Depth = 12
  )
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $temp = Join-Path $parent ('.tmp-' + [guid]::NewGuid().Guid + '.json')
  try {
    ($Value | ConvertTo-Json -Depth $Depth) | Set-Content -LiteralPath $temp -Encoding utf8
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
  }
}

function Get-AgentPackageManifestPaths {
  param([Parameter(Mandatory)][string]$ProjectRoot)
  $builtinRoot = Join-Path $ProjectRoot 'agents\packages\builtin'
  $generatedRoot = Join-Path $ProjectRoot 'agents\packages\generated\agents'
  $paths = @()
  if (Test-Path -LiteralPath $builtinRoot) {
    $paths += @(Get-ChildItem -LiteralPath $builtinRoot -Filter '*.json' -File | Sort-Object FullName | ForEach-Object FullName)
  }
  if (Test-Path -LiteralPath $generatedRoot) {
    $paths += @(Get-ChildItem -LiteralPath $generatedRoot -Recurse -Filter 'agent.json' -File | Sort-Object FullName | ForEach-Object FullName)
  }
  return @($paths)
}

function Get-AgentPackages {
  param(
    [Parameter(Mandatory)][string]$ProjectRoot,
    [Parameter(Mandatory)][string]$RuntimeRootAbs,
    [string]$ModelConfig
  )

  $projectAbs = Get-NormalizedPath $ProjectRoot
  $runtimeAbs = Get-NormalizedPath $RuntimeRootAbs
  $builtinRoot = Get-NormalizedPath (Join-Path $projectAbs 'agents\packages\builtin')
  $generatedRoot = Get-NormalizedPath (Join-Path $projectAbs 'agents\packages\generated\agents')
  $manifestPaths = @(Get-AgentPackageManifestPaths -ProjectRoot $projectAbs)
  if ($manifestPaths.Count -eq 0) { throw '未发现任何 Agent package manifest。' }

  $modelOverrides = $null
  if ($ModelConfig) {
    $modelPath = if ([System.IO.Path]::IsPathRooted($ModelConfig)) {
      Get-NormalizedPath $ModelConfig
    } else {
      Get-NormalizedPath (Join-Path $projectAbs $ModelConfig)
    }
    if (-not (Test-Path -LiteralPath $modelPath)) { throw "ModelConfig 不存在：$modelPath" }
    $modelOverrides = Read-JsonFile $modelPath
  }

  $seen = @{}
  $packages = [System.Collections.Generic.List[object]]::new()
  foreach ($manifestPath in $manifestPaths) {
    $m = Read-JsonFile $manifestPath
    foreach ($required in @('schema_version','kind','id','display_name','origin','protected','deletable','workspace_source_rel','runtime_subdir','role','capabilities','delegation','assembly','lifecycle')) {
      if ($m.PSObject.Properties.Name -notcontains $required) { throw "Agent package 缺少字段 '$required'：$manifestPath" }
    }
    if ([int]$m.schema_version -ne 1 -or [string]$m.kind -ne 'openclaw-agent-package') { throw "Agent package 版本或 kind 不支持：$manifestPath" }
    $id = [string]$m.id
    if ($id -notmatch '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$') { throw "非法 Agent ID '$id'：$manifestPath" }
    if ($seen.ContainsKey($id)) { throw "重复 Agent ID '$id'：$manifestPath 与 $($seen[$id])" }
    $seen[$id] = $manifestPath

    $isBuiltinManifest = Test-PathWithin -Path $manifestPath -Root $builtinRoot
    $isGeneratedManifest = Test-PathWithin -Path $manifestPath -Root $generatedRoot
    if (-not $isBuiltinManifest -and -not $isGeneratedManifest) { throw "Agent package 不在允许目录：$manifestPath" }
    if ($isBuiltinManifest) {
      if ([string]$m.origin -ne 'builtin' -or -not [bool]$m.protected -or [bool]$m.deletable) {
        throw "内置 Agent 必须 origin=builtin、protected=true、deletable=false：$manifestPath"
      }
    } else {
      if ([string]$m.origin -ne 'generated' -or [bool]$m.protected -or -not [bool]$m.deletable) {
        throw "生成 Agent 必须 origin=generated、protected=false、deletable=true：$manifestPath"
      }
    }

    $workspaceSource = Get-NormalizedPath (Join-Path $projectAbs ([string]$m.workspace_source_rel))
    if (-not (Test-PathWithin -Path $workspaceSource -Root $projectAbs)) { throw "workspace_source_rel 逃逸项目根：$manifestPath" }
    if (-not (Test-Path -LiteralPath $workspaceSource -PathType Container)) { throw "workspace source 不存在：$workspaceSource" }
    if ($isGeneratedManifest -and -not (Test-PathWithin -Path $workspaceSource -Root $generatedRoot)) {
      throw "生成 Agent workspace 必须位于 generated 根：$workspaceSource"
    }

    $runtimeBase = Get-NormalizedPath (Join-Path $runtimeAbs ([string]$m.runtime_subdir))
    if (-not (Test-PathWithin -Path $runtimeBase -Root $runtimeAbs)) { throw "runtime_subdir 逃逸 runtime 根：$manifestPath" }
    if ($isGeneratedManifest) {
      $generatedRuntimeRoot = Get-NormalizedPath (Join-Path $runtimeAbs 'agents\generated')
      if (-not (Test-PathWithin -Path $runtimeBase -Root $generatedRuntimeRoot)) {
        throw "生成 Agent runtime_subdir 必须位于 runtime/agents/generated：$manifestPath"
      }
    }

    $model = if ($m.PSObject.Properties.Name -contains 'model') { [string]$m.model } else { '' }
    if ($modelOverrides -and $modelOverrides.PSObject.Properties.Name -contains 'agents') {
      $agentProperty = $modelOverrides.agents.PSObject.Properties[$id]
      if ($agentProperty -and $agentProperty.Value -and $agentProperty.Value.PSObject.Properties.Name -contains 'model') {
        $override = [string]$agentProperty.Value.model
        if ($override) { $model = $override }
      }
    }

    $sandbox = $null
    if ($m.PSObject.Properties.Name -contains 'sandbox_mode' -and $null -ne $m.sandbox_mode) { $sandbox = [string]$m.sandbox_mode }
    $sandboxConfig = if ($m.PSObject.Properties.Name -contains 'sandbox_config') { $m.sandbox_config } else { $null }
    $toolsConfig = if ($m.PSObject.Properties.Name -contains 'tools_config') { $m.tools_config } else { $null }
    $skills = @()
    if ($m.PSObject.Properties.Name -contains 'skills') { $skills = @($m.skills | ForEach-Object { [string]$_ }) }

    $packages.Add([pscustomobject]@{
      id = $id
      display_name = [string]$m.display_name
      description = if ($m.PSObject.Properties.Name -contains 'description') { [string]$m.description } else { '' }
      origin = [string]$m.origin
      protected = [bool]$m.protected
      deletable = [bool]$m.deletable
      manifest_path = Get-NormalizedPath $manifestPath
      workspace_source = $workspaceSource
      runtime_base = $runtimeBase
      workspace = Get-NormalizedPath (Join-Path $runtimeBase 'workspace')
      agentDir = Get-NormalizedPath (Join-Path $runtimeBase 'state')
      role = [string]$m.role
      capabilities = @($m.capabilities | ForEach-Object { [string]$_ })
      model = $model
      callable_by_manager = [bool]$m.delegation.callable_by_manager
      allow_agents = @($m.delegation.allow_agents | ForEach-Object { [string]$_ })
      require_agent_id = if ($m.delegation.PSObject.Properties.Name -contains 'require_agent_id') { [bool]$m.delegation.require_agent_id } else { $false }
      delegation_mode = if ($m.delegation.PSObject.Properties.Name -contains 'delegation_mode') { [string]$m.delegation.delegation_mode } else { '' }
      sandbox_mode = $sandbox
      sandbox_config = $sandboxConfig
      tools_config = $toolsConfig
      include_common_rules = [bool]$m.assembly.include_common_rules
      include_templates = [bool]$m.assembly.include_templates
      skills = $skills
      register = [bool]$m.lifecycle.register
      active = [bool]$m.lifecycle.active
      raw = $m
    })
  }

  $managers = @($packages | Where-Object role -eq 'manager')
  if ($managers.Count -ne 1) { throw "必须且只能有一个 role=manager 的 Agent package，当前为 $($managers.Count)。" }
  foreach ($p in $packages) {
    if ($p.active -and -not $p.register) { throw "Agent '$($p.id)' active=true 但 register=false。" }
  }
  return @($packages)
}

function Get-ManagerPackage {
  param([Parameter(Mandatory)]$Packages)
  return @($Packages | Where-Object role -eq 'manager')[0]
}

function Get-ManagerAllowAgents {
  param([Parameter(Mandatory)]$Packages)
  return @($Packages | Where-Object {
    $_.role -ne 'manager' -and $_.register -and $_.active -and $_.callable_by_manager
  } | Sort-Object id | ForEach-Object id)
}

function Assert-GeneratedAgentPackage {
  param(
    [Parameter(Mandatory)]$Package,
    [Parameter(Mandatory)][string]$ProjectRoot
  )
  $generatedRoot = Get-NormalizedPath (Join-Path $ProjectRoot 'agents\packages\generated\agents')
  if ($Package.origin -ne 'generated' -or $Package.protected -or -not $Package.deletable) {
    throw "Agent '$($Package.id)' 不是可修改的生成 Agent。"
  }
  if (-not (Test-PathWithin -Path $Package.manifest_path -Root $generatedRoot)) {
    throw "Agent '$($Package.id)' manifest 不在 generated 根。"
  }
}

function Read-ComponentRequest {
  param([Parameter(Mandatory)][string]$Path)
  $request = Read-JsonFile $Path
  foreach ($field in @('schema_version','request_id','decision_id','component_type','proposed_id','purpose','capabilities','requested_by','created_at')) {
    if ($request.PSObject.Properties.Name -notcontains $field) { throw "组件申请缺少字段 '$field'：$Path" }
  }
  if ([int]$request.schema_version -ne 1 -or [string]$request.requested_by -ne 'manager-agent') { throw "组件申请版本或 requested_by 非法：$Path" }
  if ([string]$request.request_id -notmatch '^CMP-[A-Za-z0-9-]+$') { throw "组件 request_id 非法：$($request.request_id)" }
  if ([string]$request.decision_id -notmatch '^DEC-[A-Za-z0-9-]+$') { throw "组件 decision_id 非法：$($request.decision_id)" }
  if ([string]$request.component_type -notin @('agent','skill')) { throw "组件 component_type 非法：$($request.component_type)" }
  if ([string]$request.proposed_id -notmatch '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$') { throw "组件 proposed_id 非法：$($request.proposed_id)" }
  if ([string]::IsNullOrWhiteSpace([string]$request.purpose)) { throw '组件 purpose 不能为空。' }
  $capabilities = @($request.capabilities | ForEach-Object { [string]$_ })
  if (@($capabilities | Where-Object { $_ -notmatch '^[a-z0-9][a-z0-9._-]*$' }).Count -gt 0) { throw '组件 capabilities 含非法值。' }
  if (@($capabilities | Sort-Object -Unique).Count -ne $capabilities.Count) { throw '组件 capabilities 不允许重复。' }
  return $request
}

function Get-ComponentWorkflowId {
  param([Parameter(Mandatory)]$ComponentRequest)
  if ($ComponentRequest.PSObject.Properties.Name -contains 'workflow_id' -and $ComponentRequest.workflow_id) {
    return [string]$ComponentRequest.workflow_id
  }
  return ''
}

function Assert-ApprovalResponse {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$DecisionId,
    [Parameter(Mandatory)][string[]]$AllowedChoices,
    [string]$ExpectedWorkflowId
  )
  $approval = Read-JsonFile $Path
  foreach ($field in @('decision_id','workflow_id','outcome','raw_user_reply_summary','decided_by','decided_at')) {
    if ($approval.PSObject.Properties.Name -notcontains $field) { throw "审批响应缺少字段 '$field'：$Path" }
  }
  if ([string]$approval.decision_id -ne $DecisionId) { throw "审批 decision_id 不匹配：期望=$DecisionId 实际=$($approval.decision_id)" }
  $outcome = ([string]$approval.outcome).ToUpperInvariant()
  if ($outcome -eq 'REJECTED') { throw '审批结果为 REJECTED，拒绝执行操作。' }
  if ($outcome -notin @('APPROVED','MODIFIED')) { throw "审批 outcome '$outcome' 非法。" }
  if ([string]::IsNullOrWhiteSpace([string]$approval.workflow_id)) { throw '审批 workflow_id 不能为空。' }
  if ($ExpectedWorkflowId -and [string]$approval.workflow_id -ne $ExpectedWorkflowId) {
    throw "审批 workflow_id 不匹配：期望=$ExpectedWorkflowId 实际=$($approval.workflow_id)"
  }
  if ([string]::IsNullOrWhiteSpace([string]$approval.raw_user_reply_summary)) { throw '审批 raw_user_reply_summary 不能为空。' }
  if ([string]::IsNullOrWhiteSpace([string]$approval.decided_by)) { throw '审批 decided_by 不能为空。' }
  if ([string]::IsNullOrWhiteSpace([string]$approval.decided_at)) { throw '审批 decided_at 不能为空。' }
  if ($approval.PSObject.Properties.Name -notcontains 'chosen_option_id' -or -not $approval.chosen_option_id) { throw '审批未选择允许的操作。' }
  $choice = ([string]$approval.chosen_option_id).ToUpperInvariant()
  if ($AllowedChoices -notcontains $choice) { throw "审批选项 '$choice' 不允许，期望：$($AllowedChoices -join ', ')" }
  return $approval
}

function Update-GeneratedComponentAudit {
  param(
    [Parameter(Mandatory)][string]$RuntimeRootAbs,
    [Parameter(Mandatory)]$Entry
  )
  $auditPath = Join-Path $RuntimeRootAbs 'control\generated-components.json'
  $entries = @()
  if (Test-Path -LiteralPath $auditPath) {
    $parsed = Read-JsonFile $auditPath
    if ($parsed -is [array]) { $entries = @($parsed) } else { $entries = @($parsed) }
  }
  $entries += $Entry
  Write-JsonAtomic -Value @($entries) -Path $auditPath -Depth 12
}
