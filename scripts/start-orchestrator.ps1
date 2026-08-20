param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$RuntimeRoot = '',
  [int]$PollMs = 1000,
  [int]$ShutdownTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $resolvedProject 'runtime' }
$env:OPENCLAW_PROJECT_ROOT = $resolvedProject
$env:OPENCLAW_RUNTIME_ROOT = [System.IO.Path]::GetFullPath($RuntimeRoot)

& node (Join-Path $resolvedProject 'scripts\orchestrator-cli.mjs') serve --project-root $resolvedProject --poll-ms $PollMs --shutdown-timeout-seconds $ShutdownTimeoutSeconds
exit $LASTEXITCODE
