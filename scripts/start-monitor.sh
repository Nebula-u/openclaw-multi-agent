#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${OPENCLAW_PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
export OPENCLAW_PROJECT_ROOT="$PROJECT_ROOT"
export OPENCLAW_RUNTIME_ROOT="${OPENCLAW_RUNTIME_ROOT:-$PROJECT_ROOT/runtime}"
export MONITOR_PORT="${MONITOR_PORT:-4310}"

exec node "$PROJECT_ROOT/monitor/supervisor.mjs"
