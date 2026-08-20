#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${OPENCLAW_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export OPENCLAW_PROJECT_ROOT="$PROJECT_ROOT"
export OPENCLAW_RUNTIME_ROOT="${OPENCLAW_RUNTIME_ROOT:-$PROJECT_ROOT/runtime}"

exec node "$PROJECT_ROOT/scripts/orchestrator-cli.mjs" serve --project-root "$PROJECT_ROOT" --poll-ms "${OPENCLAW_ORCHESTRATOR_POLL_MS:-1000}" --shutdown-timeout-seconds "${OPENCLAW_ORCHESTRATOR_SHUTDOWN_TIMEOUT_SECONDS:-120}"
