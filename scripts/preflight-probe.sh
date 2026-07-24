#!/usr/bin/env bash
# preflight-probe.sh
# Read-only environment probing for openclaw-sdlc-multi-agent.
# Captures stdout, stderr, exit code, cwd and timing for each probe command.
# Does NOT modify anything. Does NOT run `openclaw doctor --fix`.
set -u

# Resolve project root relative to THIS script, then to absolute (not $PWD).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
OUT_DIR="${PROJECT_ROOT}/artifacts/preflight"
mkdir -p "${OUT_DIR}"

INDEX="${OUT_DIR}/index.tsv"
: > "${INDEX}"
printf 'slug\texit_code\tcwd\tstarted_at\tfinished_at\tcommand\n' >> "${INDEX}"

run_probe() {
  # $1 = slug (filename-safe), rest = command + args
  local slug="$1"; shift
  local out="${OUT_DIR}/${slug}.stdout.txt"
  local err="${OUT_DIR}/${slug}.stderr.txt"
  local meta="${OUT_DIR}/${slug}.meta.txt"
  local started finished code
  started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if command -v "$1" >/dev/null 2>&1; then
    "$@" >"${out}" 2>"${err}"
    code=$?
  else
    code=127
    : > "${out}"
    printf 'UNVERIFIED: executable not found: %s\n' "$1" > "${err}"
  fi
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    printf 'slug=%s\n' "${slug}"
    printf 'command=%s\n' "$*"
    printf 'executable=%s\n' "$1"
    printf 'cwd=%s\n' "$(pwd -P)"
    printf 'exit_code=%s\n' "${code}"
    printf 'started_at=%s\n' "${started}"
    printf 'finished_at=%s\n' "${finished}"
    printf 'stdout_file=%s\n' "${out}"
    printf 'stderr_file=%s\n' "${err}"
  } > "${meta}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${slug}" "${code}" "$(pwd -P)" "${started}" "${finished}" "$*" >> "${INDEX}"
  printf '[probe] %-28s exit=%s\n' "${slug}" "${code}"
}

echo "=== preflight probing into ${OUT_DIR} ==="

run_probe openclaw-version            openclaw --version
run_probe openclaw-help               openclaw --help
run_probe openclaw-agents-help        openclaw agents --help
run_probe openclaw-agents-add-help    openclaw agents add --help
run_probe openclaw-agents-list-help   openclaw agents list --help
run_probe openclaw-config-help        openclaw config --help
run_probe openclaw-config-get-help    openclaw config get --help
run_probe openclaw-config-set-help    openclaw config set --help
run_probe openclaw-config-patch-help  openclaw config patch --help
run_probe openclaw-config-file        openclaw config file
run_probe openclaw-config-schema      openclaw config schema
run_probe openclaw-config-validate    openclaw config validate --json
run_probe openclaw-doctor-lint        openclaw doctor --lint --json
run_probe git-version                 git --version
run_probe pwsh-version                pwsh --version
run_probe bash-version                bash --version
run_probe node-version                node --version
run_probe npm-version                 npm --version
run_probe python-version              python --version
run_probe py-version                  py --version

echo "=== done. index: ${INDEX} ==="
