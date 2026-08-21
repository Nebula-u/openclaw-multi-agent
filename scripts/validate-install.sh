#!/usr/bin/env bash
# 清单驱动的静态安装验证；不修改 OpenClaw 配置。
set -uo pipefail

SKIP_OPENCLAW=0
RUNTIME_ROOT="runtime"
usage() {
  printf '%s\n' '用法: validate-install.sh [--skip-openclaw] [--runtime-root <path>]'
}
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-openclaw) SKIP_OPENCLAW=1; shift ;;
    --runtime-root) RUNTIME_ROOT="${2:?--runtime-root 需要参数}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"; SOURCE="$(readlink "$SOURCE")"; [[ "$SOURCE" != /* ]] && SOURCE="$D/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

PASS_N=0; FAIL_N=0; UNK_N=0
declare -a LOG_LINES=()
check() {
  local d="${3:-}" c=32
  [ "$2" = FAIL ] && c=31; [ "$2" = UNKNOWN ] && c=33
  printf '\033[%sm[%s]\033[0m %s%s\n' "$c" "$2" "$1" "${d:+ — $d}"
  if command -v jq >/dev/null 2>&1; then LOG_LINES+=("$(jq -nc --arg c "$1" --arg s "$2" --arg d "$d" '{check:$c,status:$s,detail:$d}')"); fi
  case "$2" in PASS) PASS_N=$((PASS_N+1));; FAIL) FAIL_N=$((FAIL_N+1));; UNKNOWN) UNK_N=$((UNK_N+1));; esac
}

echo "== package 驱动静态验证 (Bash) =="
echo "ProjectRoot: $PROJECT_ROOT"

if ! command -v jq >/dev/null 2>&1; then
  check "jq 可用（package catalog 必需）" FAIL "本脚本不会自动安装依赖；可改用 validate-install.ps1"
  exit 1
fi
jq_clean() { jq "$@" | tr -d '\r'; }

mapfile -t MANIFESTS < <(
  find "$PROJECT_ROOT/agents/packages/builtin" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null
  find "$PROJECT_ROOT/agents/packages/generated/agents" -mindepth 2 -maxdepth 2 -type f -name 'agent.json' -print 2>/dev/null
)
[ "${#MANIFESTS[@]}" -gt 0 ] && check "Agent package catalog 可发现" PASS "packages=${#MANIFESTS[@]}" || check "Agent package catalog 可发现" FAIL

declare -A IDS
MANAGER_ID=""
REGISTERED=0
EXPECTED_ALLOW=()
CORE=(AGENTS.md SOUL.md TOOLS.md IDENTITY.md)
for mf in "${MANIFESTS[@]}"; do
  mf_jq="$(native_path "$mf")"
  if ! jq -e '.schema_version == 1 and .kind == "openclaw-agent-package"' "$mf_jq" >/dev/null; then check "package JSON: $(basename "$mf")" FAIL; continue; fi
  id="$(jq_clean -r '.id' "$mf_jq")"; origin="$(jq_clean -r '.origin' "$mf_jq")"; protected="$(jq_clean -r '.protected' "$mf_jq")"; deletable="$(jq_clean -r '.deletable' "$mf_jq")"
  if [ -n "${IDS[$id]:-}" ]; then check "Agent ID 唯一: $id" FAIL; else IDS[$id]="$mf"; check "Agent ID 唯一: $id" PASS; fi
  case "$mf" in
    "$PROJECT_ROOT/agents/packages/builtin/"*)
      [ "$origin" = builtin ] && [ "$protected" = true ] && [ "$deletable" = false ] && check "内置保护: $id" PASS || check "内置保护: $id" FAIL
      ;;
    "$PROJECT_ROOT/agents/packages/generated/agents/"*)
      [ "$origin" = generated ] && [ "$protected" = false ] && [ "$deletable" = true ] && check "生成保护边界: $id" PASS || check "生成保护边界: $id" FAIL
      ;;
    *) check "package 目录边界: $id" FAIL "$mf" ;;
  esac
  src_rel="$(jq_clean -r '.workspace_source_rel' "$mf_jq")"; ws="$PROJECT_ROOT/$src_rel"
  [ -d "$ws" ] && check "workspace source: $id" PASS "$ws" || check "workspace source: $id" FAIL "$ws"
  for f in "${CORE[@]}"; do [ -f "$ws/$f" ] && check "  $id/$f" PASS || check "  $id/$f" FAIL; done
  role="$(jq_clean -r '.role' "$mf_jq")"; register="$(jq_clean -r '.lifecycle.register' "$mf_jq")"; active="$(jq_clean -r '.lifecycle.active' "$mf_jq")"; callable="$(jq_clean -r '.delegation.callable_by_manager' "$mf_jq")"
  if [ "$role" = manager ]; then [ -z "$MANAGER_ID" ] && MANAGER_ID="$id" || check "唯一 manager package" FAIL; fi
  [ "$register" = true ] && REGISTERED=$((REGISTERED+1))
  if [ "$role" != manager ] && [ "$register" = true ] && [ "$active" = true ] && [ "$callable" = true ]; then EXPECTED_ALLOW+=("$id"); fi
  if [ "$role" != manager ]; then
    allow_count="$(jq_clean '.delegation.allow_agents | length' "$mf_jq")"
    [ "$allow_count" -eq 0 ] && check "工作 Agent 不派生: $id" PASS || check "工作 Agent 不派生: $id" FAIL
  fi
done
[ -n "$MANAGER_ID" ] && check "catalog 中唯一 manager" PASS "$MANAGER_ID" || check "catalog 中唯一 manager" FAIL

for f in "$PROJECT_ROOT"/contracts/*.json; do jq empty "$(native_path "$f")" >/dev/null 2>&1 && check "contracts JSON: $(basename "$f")" PASS || check "contracts JSON: $(basename "$f")" FAIL; done
for f in "$PROJECT_ROOT"/templates/*.json; do [ -e "$f" ] || continue; jq empty "$(native_path "$f")" >/dev/null 2>&1 && check "templates JSON: $(basename "$f")" PASS || check "templates JSON: $(basename "$f")" FAIL; done

RUNTIME_GUARD="$PROJECT_ROOT/scripts/runtime-guard.mjs"
RUNTIME_GUARD_TEST="$PROJECT_ROOT/tests/runtime-guard.test.mjs"
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && (b>13 || (b===13 && c>=0))) ? 0 : 1)' >/dev/null 2>&1; then
    check "Node.js 22.13.0+（node:sqlite 必需）" PASS "$NODE_VERSION"
    if [ -d "$PROJECT_ROOT/node_modules/ajv" ] && [ -d "$PROJECT_ROOT/node_modules/ajv-formats" ]; then
      node "$(native_path "$RUNTIME_GUARD")" self-check --project-root "$(native_path "$PROJECT_ROOT")" >/dev/null 2>&1 && check "Runtime Guard contracts/templates 自检" PASS || check "Runtime Guard contracts/templates 自检" FAIL
      node --test "$(native_path "$RUNTIME_GUARD_TEST")" >/dev/null 2>&1 && check "Runtime Guard 行为测试" PASS || check "Runtime Guard 行为测试" FAIL
    else
      check "Runtime Guard npm 依赖" FAIL "请先在项目根目录运行 npm install（需要 ajv 与 ajv-formats）"
    fi
  else
    check "Node.js 22.13.0+（node:sqlite 必需）" FAIL "当前版本：${NODE_VERSION:-unknown}"
  fi
else
  check "Node.js 22.13.0+（node:sqlite 必需）" FAIL "请安装 Node.js 22.13.0 或更高版本"
fi

INSTALL_SH="$SCRIPT_DIR/install.sh"
DRY_MANIFEST="$PROJECT_ROOT/artifacts/install-dryrun/install-manifest.dryrun.json"
NONPROJ="$(mktemp -d)"
VALIDATION_OPENCLAW_BIN="$(mktemp -d)"
VALIDATION_OPENCLAW="$VALIDATION_OPENCLAW_BIN/openclaw"
VALIDATION_OPENCLAW_CONFIG="$VALIDATION_OPENCLAW_BIN/validation-openclaw-config.json"
cleanup_install_validation() {
  rm -rf "$NONPROJ" "$VALIDATION_OPENCLAW_BIN"
}
trap cleanup_install_validation EXIT

# 验证安装器的路径解析时不能读取宿主机 Agent 注册表：真实安装保留冲突保护，
# 这里仅以受控、只读的 CLI 边界让 dry-run 的 agents list 返回空 catalog。
printf '%s\n' '{"agents":{"list":[]}}' > "$VALIDATION_OPENCLAW_CONFIG"
export VALIDATION_OPENCLAW_CONFIG
cat > "$VALIDATION_OPENCLAW" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) printf 'validation-openclaw 0\n' ;;
  config) printf '%s\n' "$VALIDATION_OPENCLAW_CONFIG" ;;
  agents) printf '[]\n' ;;
  *) exit 0 ;;
esac
EOF
chmod 700 "$VALIDATION_OPENCLAW"

# 不允许失败安装遗留的旧 manifest 参与后续断言。
rm -f "$DRY_MANIFEST"
INSTALL_DRYRUN_EXIT=0
(cd "$NONPROJ" && PATH="$VALIDATION_OPENCLAW_BIN:$PATH" bash "$INSTALL_SH" --runtime-root "$RUNTIME_ROOT" >/dev/null 2>&1) || INSTALL_DRYRUN_EXIT=$?
if [ "$INSTALL_DRYRUN_EXIT" -eq 0 ]; then
  check "install.sh 非项目 cwd dry-run 可执行" PASS "$NONPROJ"
else
  check "install.sh 非项目 cwd dry-run 可执行" FAIL "$NONPROJ"
fi

if [ "$INSTALL_DRYRUN_EXIT" -eq 0 ] && [ -f "$DRY_MANIFEST" ]; then
  dry_jq="$(native_path "$DRY_MANIFEST")"
  schema="$(jq_clean -r '.schema_version' "$dry_jq")"; [ "$schema" = 2 ] && check "dry-run schema_version=2" PASS || check "dry-run schema_version=2" FAIL "$schema"
  count="$(jq_clean '.agents | length' "$dry_jq")"; [ "$count" -eq "$REGISTERED" ] && check "dry-run 数量来自 register=true packages" PASS "$count" || check "dry-run 数量来自 register=true packages" FAIL "$count/$REGISTERED"
  abs_ok="$(jq_clean -r '[.agents[] | (.manifest_abs,.workspace_source_abs,.workspace_abs,.agentDir_abs)] | all(startswith("/") or test("^[A-Za-z]:"))' "$dry_jq")"
  [ "$abs_ok" = true ] && check "dry-run 路径全为绝对路径" PASS || check "dry-run 路径全为绝对路径" FAIL
  model_limits="$(jq_clean -r '[.agents[] | .context_window_tokens == 200000 and .max_output_tokens == 32000 and .max_tokens_field == "max_output_tokens"] | all' "$dry_jq")"
  [ "$model_limits" = true ] && check "dry-run 模型限制为 200k context / 32k output" PASS || check "dry-run 模型限制为 200k context / 32k output" FAIL
  acl_applied="$(jq_clean -r '.artifact_access_control.applied' "$dry_jq")"
  [ "$acl_applied" = false ] && check "dry-run 不修改 artifact ACL" PASS || check "dry-run 不修改 artifact ACL" FAIL "$acl_applied"
  actual="$(jq_clean -r --arg id "$MANAGER_ID" '.agents[] | select(.id==$id) | .subagents_allow | sort | join(",")' "$dry_jq")"
  expected="$(printf '%s\n' "${EXPECTED_ALLOW[@]}" | sort | paste -sd, -)"
  [ "$actual" = "$expected" ] && check "manager 白名单来自 catalog" PASS "$actual" || check "manager 白名单来自 catalog" FAIL "actual=$actual expected=$expected"
else
  check "dry-run 清单生成" FAIL "$DRY_MANIFEST"
fi

COMPONENT_SKILL="$PROJECT_ROOT/agents/packages/system/skills/agent-package-manager/SKILL.md"
grep -q 'manage-components' "$COMPONENT_SKILL" 2>/dev/null && grep -q 'approval' "$COMPONENT_SKILL" && check "agent-package-manager Skill 含审批协议" PASS || check "agent-package-manager Skill 含审批协议" FAIL
grep -q "outcome -eq 'REJECTED'" "$PROJECT_ROOT/scripts/component-lib.ps1" 2>/dev/null && check "组件审批显式拒绝 REJECTED" PASS || check "组件审批显式拒绝 REJECTED" FAIL
grep -q 'created_from_workflow = \$workflowId' "$PROJECT_ROOT/scripts/manage-components.ps1" 2>/dev/null && check "Skill proposal 绑定当前 workflow" PASS || check "Skill proposal 绑定当前 workflow" FAIL

if grep -rIlqE 'python[[:space:]]+-m[[:space:]]+src\.openclaw_sdlc|openclaw_sdlc\.|sdlcctl' "$PROJECT_ROOT/agents" 2>/dev/null; then check "运行时 Prompt 不依赖旧 Python 控制面" FAIL; else check "运行时 Prompt 不依赖旧 Python 控制面" PASS; fi

if [ "$SKIP_OPENCLAW" -eq 0 ]; then
  if command -v openclaw >/dev/null 2>&1; then
    openclaw config validate --json >/dev/null 2>&1 && check "openclaw config validate --json" PASS || check "openclaw config validate --json" FAIL
    openclaw skills info skill-creator --agent "$MANAGER_ID" --json >/dev/null 2>&1 && check "成熟 skill-creator 对 manager 可用" PASS || check "成熟 skill-creator 对 manager 可用" FAIL
  else check "openclaw CLI 可用" UNKNOWN; fi
fi

LOG_DIR="$PROJECT_ROOT/artifacts/validation"; mkdir -p "$LOG_DIR"
LOG_PATH="$LOG_DIR/validate-install.$(date +%Y%m%d-%H%M%S).json"
printf '%s\n' "${LOG_LINES[@]}" | jq -s . > "$LOG_PATH"
echo ""
echo "== 汇总：PASS=$PASS_N FAIL=$FAIL_N UNKNOWN=$UNK_N =="
echo "日志：$LOG_PATH"
[ "$FAIL_N" -gt 0 ] && exit 1
echo "无失败项。"
