param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$RuntimeRoot = '',
  [int]$Port = 4319
)

$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $resolvedProject 'runtime' }
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeRoot)

$env:OPENCLAW_PROJECT_ROOT = $resolvedProject
$env:OPENCLAW_RUNTIME_ROOT = $resolvedRuntime
$env:MONITOR_PORT = [string]$Port

& node (Join-Path $resolvedProject 'monitor\main.mjs')
exit $LASTEXITCODE
