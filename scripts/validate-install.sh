#!/usr/bin/env bash
# =============================================================================
# openclaw-sdlc-multi-agent 静态安装验证（Bash 等价实现）
# 纯静态 + 只读校验，不修改任何配置。任何硬性检查失败则退出码非 0。
# JSON 合法性校验依赖 jq；若缺失则相关项标记 UNKNOWN（不自动安装）。
# =============================================================================
set -uo pipefail

SKIP_OPENCLAW=0
[ "${1:-}" = "--skip-openclaw" ] && SKIP_OPENCLAW=1

SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  D="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"; SOURCE="$(readlink "$SOURCE")"; [[ "$SOURCE" != /* ]] && SOURCE="$D/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

AGENT_IDS=(manager-agent requirement-agent architect-agent developer-agent review-agent test-agent release-agent)
WORKER_IDS=(requirement-agent architect-agent developer-agent review-agent test-agent release-agent)

PASS_N=0; FAIL_N=0; UNK_N=0
declare -a LOG_LINES=()
check() { # $1=name $2=PASS/FAIL/UNKNOWN $3=detail
  local d="${3:-}"
  local c=32; [ "$2" = FAIL ] && c=31; [ "$2" = UNKNOWN ] && c=33
  printf '\033[%sm[%s]\033[0m %s%s\n' "$c" "$2" "$1" "${d:+ — $d}"
  LOG_LINES+=("{\"check\":\"$1\",\"status\":\"$2\",\"detail\":\"${d//\"/\\\"}\"}")
  case "$2" in PASS) PASS_N=$((PASS_N+1));; FAIL) FAIL_N=$((FAIL_N+1));; UNKNOWN) UNK_N=$((UNK_N+1));; esac
}

HAS_JQ=0; command -v jq >/dev/null 2>&1 && HAS_JQ=1
json_ok() { [ "$HAS_JQ" -eq 1 ] && jq empty "$1" >/dev/null 2>&1; }

echo "== 静态安装验证 (Bash) =="
echo "ProjectRoot: $PROJECT_ROOT"

# 1+2. workspace + 4 核心文件
CORE=(AGENTS.md SOUL.md TOOLS.md IDENTITY.md)
for id in "${AGENT_IDS[@]}"; do
  ws="$PROJECT_ROOT/agents/$id/workspace"
  [ -d "$ws" ] && check "workspace 存在: $id" PASS "$ws" || check "workspace 存在: $id" FAIL "$ws"
  for f in "${CORE[@]}"; do
    [ -f "$ws/$f" ] && check "  $id/$f" PASS || check "  $id/$f" FAIL
  done
done

# 3. contracts JSON
if [ -d "$PROJECT_ROOT/contracts" ]; then
  for f in "$PROJECT_ROOT"/contracts/*.json; do
    [ -e "$f" ] || continue
    if [ "$HAS_JQ" -eq 1 ]; then json_ok "$f" && check "contracts JSON: $(basename "$f")" PASS || check "contracts JSON: $(basename "$f")" FAIL
    else check "contracts JSON: $(basename "$f")" UNKNOWN "缺少 jq"; fi
  done
else check "contracts 目录存在" FAIL; fi

# 4. templates JSON / JSONL
if [ -d "$PROJECT_ROOT/templates" ]; then
  for f in "$PROJECT_ROOT"/templates/*.json; do
    [ -e "$f" ] || continue
    if [ "$HAS_JQ" -eq 1 ]; then json_ok "$f" && check "templates JSON: $(basename "$f")" PASS || check "templates JSON: $(basename "$f")" FAIL
    else check "templates JSON: $(basename "$f")" UNKNOWN "缺少 jq"; fi
  done
  for f in "$PROJECT_ROOT"/templates/*.jsonl; do
    [ -e "$f" ] || continue
    if [ "$HAS_JQ" -eq 1 ]; then
      ok=1; while IFS= read -r line; do [ -z "${line// }" ] && continue; echo "$line" | jq empty >/dev/null 2>&1 || { ok=0; break; }; done < "$f"
      [ "$ok" -eq 1 ] && check "templates JSONL: $(basename "$f")" PASS || check "templates JSONL: $(basename "$f")" FAIL
    else check "templates JSONL: $(basename "$f")" UNKNOWN "缺少 jq"; fi
  done
else check "templates 目录存在" UNKNOWN "$PROJECT_ROOT/templates（可能仍在生成）"; fi

# 5-9 + 15. install.sh dry-run（从非项目 cwd）
INSTALL_SH="$SCRIPT_DIR/install.sh"
DRY_MANIFEST="$PROJECT_ROOT/artifacts/install-dryrun/install-manifest.dryrun.json"
NONPROJ="$(mktemp -d)"
( cd "$NONPROJ" && bash "$INSTALL_SH" --runtime-root runtime >/dev/null 2>&1 ) \
  && check "install.sh dry-run 可执行（cwd=$NONPROJ）" PASS \
  || check "install.sh dry-run 可执行（cwd=$NONPROJ）" FAIL
rmdir "$NONPROJ" 2>/dev/null || true

if [ -f "$DRY_MANIFEST" ] && [ "$HAS_JQ" -eq 1 ]; then
  rr="$(jq -r '.runtime_root_abs' "$DRY_MANIFEST")"
  case "$rr" in "$PROJECT_ROOT"*) check "非项目 cwd dry-run 路径仍指向项目 (System32 防护)" PASS "runtime_root_abs=$rr";; *) check "非项目 cwd dry-run 路径仍指向项目 (System32 防护)" FAIL "runtime_root_abs=$rr";; esac
  # 绝对路径
  abs_ok="$(jq -r '[.agents[] | (.workspace_abs, .agentDir_abs)] | all(startswith("/") or test("^[A-Za-z]:"))' "$DRY_MANIFEST" 2>/dev/null || echo false)"
  [ "$abs_ok" = "true" ] && check "安装计划中 workspace/agentDir 全为绝对路径" PASS || check "安装计划中 workspace/agentDir 全为绝对路径" FAIL
  # 互异
  nws="$(jq -r '[.agents[].workspace_abs] | unique | length' "$DRY_MANIFEST")"
  ndir="$(jq -r '[.agents[].agentDir_abs] | unique | length' "$DRY_MANIFEST")"
  [ "$nws" -eq 7 ] && check "7 个 workspace 彼此不同" PASS || check "7 个 workspace 彼此不同" FAIL "unique=$nws"
  [ "$ndir" -eq 7 ] && check "7 个 agentDir 彼此不同" PASS || check "7 个 agentDir 彼此不同" FAIL "unique=$ndir"
  # manager 白名单
  mgr_allow="$(jq -r '.agents[] | select(.id=="manager-agent") | .subagents_allow | sort | join(",")' "$DRY_MANIFEST")"
  want="$(printf '%s\n' "${WORKER_IDS[@]}" | sort | paste -sd, -)"
  [ "$mgr_allow" = "$want" ] && check "manager 白名单 = 6 个工作 Agent" PASS "$mgr_allow" || check "manager 白名单 = 6 个工作 Agent" FAIL "$mgr_allow"
  reqid="$(jq -r '.agents[] | select(.id=="manager-agent") | .require_agent_id' "$DRY_MANIFEST")"
  [ "$reqid" = "true" ] && check "manager requireAgentId = true" PASS || check "manager requireAgentId = true" FAIL
  # 工作 Agent 空白名单
  emptyok="$(jq -r '[.agents[] | select(.id!="manager-agent") | (.subagents_allow|length)] | all(.==0)' "$DRY_MANIFEST")"
  [ "$emptyok" = "true" ] && check "工作 Agent allowAgents 均为空（禁止再派生）" PASS || check "工作 Agent allowAgents 均为空（禁止再派生）" FAIL
  # test sandbox off
  sb="$(jq -r '.agents[] | select(.id=="test-agent") | .sandbox_mode' "$DRY_MANIFEST")"
  [ "$sb" = "off" ] && check "test-agent sandbox_mode = off" PASS || check "test-agent sandbox_mode = off" FAIL "$sb"
else
  check "dry-run 清单可解析" UNKNOWN "缺少 jq 或清单未生成: $DRY_MANIFEST"
fi

# 11. manager 调度协议
MGR="$PROJECT_ROOT/agents/manager-agent/workspace/AGENTS.md"
if [ -f "$MGR" ]; then
  if grep -Eq 'sessions_spawn|agentId' "$MGR" && grep -Eq '调度|dispatch' "$MGR"; then check "manager AGENTS.md 含原生调度协议" PASS; else check "manager AGENTS.md 含原生调度协议" FAIL; fi
else check "manager AGENTS.md 存在" FAIL; fi

# 12. 无 sdlcctl / openclaw_sdlc 依赖
if grep -rIlq 'sdlcctl' "$PROJECT_ROOT/agents" 2>/dev/null; then check "运行时 Prompt 不含 sdlcctl" FAIL "$(grep -rIl 'sdlcctl' "$PROJECT_ROOT/agents" | tr '\n' ' ')"; else check "运行时 Prompt 不含 sdlcctl" PASS; fi
if grep -rIlqE 'python[[:space:]]+-m[[:space:]]+src\.openclaw_sdlc|openclaw_sdlc\.' "$PROJECT_ROOT/agents" 2>/dev/null; then check "运行时 Prompt 不依赖旧 Python 控制平面" FAIL; else check "运行时 Prompt 不依赖旧 Python 控制平面" PASS; fi

# 13. test-agent UNSANDBOXED_LOCAL
TA="$PROJECT_ROOT/agents/test-agent/workspace/AGENTS.md"
if [ -f "$TA" ] && grep -q 'UNSANDBOXED_LOCAL' "$TA"; then check "test-agent AGENTS.md 含 UNSANDBOXED_LOCAL" PASS; else check "test-agent AGENTS.md 含 UNSANDBOXED_LOCAL" FAIL; fi

# 14. task.schema.json 含 *_abs
TS="$PROJECT_ROOT/contracts/task.schema.json"
if [ -f "$TS" ] && grep -q 'worktree_path_abs' "$TS" && grep -q 'artifact_root_abs' "$TS"; then check "task.schema.json 含 *_abs 绝对路径字段" PASS; else check "task.schema.json 含 *_abs 绝对路径字段" FAIL; fi

# 16. openclaw config validate
if [ "$SKIP_OPENCLAW" -eq 0 ]; then
  if command -v openclaw >/dev/null 2>&1; then
    openclaw config validate --json >/dev/null 2>&1 && check "openclaw config validate --json" PASS "exit=0" || check "openclaw config validate --json" FAIL "exit=$?"
  else
    check "openclaw CLI 可用" UNKNOWN "未找到 openclaw"
  fi
fi

# 汇总 + 日志
LOG_DIR="$PROJECT_ROOT/artifacts/validation"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_PATH="$LOG_DIR/validate-install.$STAMP.json"
{ echo "["; IFS=,; echo "${LOG_LINES[*]}"; echo "]"; } > "$LOG_PATH"

echo ""
echo "== 汇总：PASS=$PASS_N FAIL=$FAIL_N UNKNOWN=$UNK_N =="
echo "日志：$LOG_PATH"
[ "$FAIL_N" -gt 0 ] && exit 1 || { echo "无失败项。"; exit 0; }
