#!/usr/bin/env bash
# =============================================================================
# openclaw-sdlc-multi-agent package 安装脚本（Windows 主实现见 install.ps1）
#
# 默认只做 dry-run（不修改任何 OpenClaw 配置）。仅在 --apply 且确认后写配置。
# 绝对路径处理：所有 workspace/agentDir/runtime 路径基于“项目根目录”（本脚本所在目录的
# 父目录）解析并规范化为绝对路径，绝不依赖当前工作目录（即使从任意目录调用）。
# 不安装依赖、不联网、不启用 sandbox、不安装 Docker、不删除用户已有 Agent、不执行 doctor --fix。
#
# 探测版本基准：OpenClaw 2026.7.1-2。以真实 --help / config schema 为准。
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# 0. 参数解析
# ---------------------------------------------------------------------------
APPLY=0
RUNTIME_ROOT="runtime"          # 相对值相对“项目根目录”解析，而非 $PWD
MODEL_CONFIG=""
SET_MANAGER_DEFAULT=0
MANAGER_BINDING=""
ASSUME_YES=0

usage() {
  cat <<'EOF'
用法: install.sh [选项]
  --apply                     真正写入配置（缺省为 dry-run）
  --runtime-root <path>       runtime 根目录（相对值相对项目根解析），默认 runtime
  --model-config <path>       每 Agent 模型配置 JSON（agent-models.json）
  --set-manager-as-default    将 manager-agent 设为默认 Agent
  --manager-binding <chan>    manager-agent 的用户渠道 binding，如 discord:acct
  --yes                       非交互确认（配合 --apply）
  -h, --help                  显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --runtime-root) RUNTIME_ROOT="${2:?--runtime-root 需要参数}"; shift 2 ;;
    --model-config) MODEL_CONFIG="${2:?--model-config 需要参数}"; shift 2 ;;
    --set-manager-as-default) SET_MANAGER_DEFAULT=1; shift ;;
    --manager-binding) MANAGER_BINDING="${2:?--manager-binding 需要参数}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# 0.1 绝对路径解析（System32/任意目录 防护核心）
# ---------------------------------------------------------------------------
# 脚本所在目录（解引用软链接），再取父目录为项目根
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"

# 规范化可能不存在的路径（不依赖 realpath -m，保证 macOS 兼容）
normpath() {
  local path="$1" abs seg res="" IFS='/'
  case "$path" in
    /*) abs="$path" ;;
    *)  abs="$PROJECT_ROOT/$path" ;;   # 相对值相对项目根，不相对 $PWD
  esac
  local -a out=()
  for seg in $abs; do
    case "$seg" in
      ''|.) continue ;;
      ..) [ ${#out[@]} -gt 0 ] && unset 'out[$((${#out[@]}-1))]' ;;
      *) out+=("$seg") ;;
    esac
  done
  for seg in "${out[@]}"; do res="$res/$seg"; done
  printf '%s' "${res:-/}"
}

# Cygwin/Git Bash 可能调用 Windows jq/openclaw；读取文件时转换为原生路径。
native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

shell_path() {
  case "$1" in
    [A-Za-z]:*|*\\*) if command -v cygpath >/dev/null 2>&1; then cygpath -u "$1"; else printf '%s' "$1"; fi ;;
    *) printf '%s' "$1" ;;
  esac
}

assert_abs() {
  case "$1" in
    /*) : ;;
    *) echo "路径必须为绝对路径 ($2): $1" >&2; exit 1 ;;
  esac
}

RUNTIME_ROOT_ABS="$(normpath "$RUNTIME_ROOT")"
assert_abs "$PROJECT_ROOT" "PROJECT_ROOT"
assert_abs "$RUNTIME_ROOT_ABS" "RUNTIME_ROOT"

MODE="DRYRUN"; [ "$APPLY" -eq 1 ] && MODE="APPLY"
echo "== openclaw-sdlc-multi-agent 安装 ($MODE) =="
echo "ProjectRoot   : $PROJECT_ROOT"
echo "RuntimeRoot   : $RUNTIME_ROOT_ABS"
echo "调用时 PWD    : $(pwd)  (仅供参考，不用于路径解析)"

# ---------------------------------------------------------------------------
# 1. 从 package manifest 发现 Agent
# ---------------------------------------------------------------------------
command -v jq >/dev/null 2>&1 || {
  echo "package manifest 发现需要 jq；本脚本不会自动安装依赖。可改用 install.ps1。" >&2
  exit 1
}
HAS_JQ=1
jq_clean() { jq "$@" | tr -d '\r'; }

mapfile -t PACKAGE_MANIFESTS < <(
  find "$PROJECT_ROOT/agents/packages/builtin" -maxdepth 1 -type f -name '*.json' -print 2>/dev/null
  find "$PROJECT_ROOT/agents/packages/generated/agents" -mindepth 2 -maxdepth 2 -type f -name 'agent.json' -print 2>/dev/null
)
[ "${#PACKAGE_MANIFESTS[@]}" -gt 0 ] || { echo "未发现任何 Agent package manifest。" >&2; exit 1; }

AGENT_IDS=()
WORKER_IDS=()
MANAGER_ID=""
declare -A WS DIR OC_WS OC_DIR MODEL SRC_WS ROLE ORIGIN PROTECTED ACTIVE REGISTER CALLABLE ALLOW_JSON SANDBOX INCLUDE_COMMON INCLUDE_TEMPLATES MANIFEST
declare -A SEEN_IDS

for mf in "${PACKAGE_MANIFESTS[@]}"; do
  mf_jq="$(native_path "$mf")"
  jq -e '.schema_version == 1 and .kind == "openclaw-agent-package"' "$mf_jq" >/dev/null || { echo "非法 package: $mf" >&2; exit 1; }
  id="$(jq_clean -r '.id' "$mf_jq")"
  [[ "$id" =~ ^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$ ]] || { echo "非法 Agent ID: $id" >&2; exit 1; }
  [ -z "${SEEN_IDS[$id]:-}" ] || { echo "重复 Agent ID: $id" >&2; exit 1; }
  SEEN_IDS[$id]="$mf"
  origin="$(jq_clean -r '.origin' "$mf_jq")"
  protected="$(jq_clean -r '.protected' "$mf_jq")"
  deletable="$(jq_clean -r '.deletable' "$mf_jq")"
  case "$mf" in
    "$PROJECT_ROOT/agents/packages/builtin/"*)
      [ "$origin" = "builtin" ] && [ "$protected" = "true" ] && [ "$deletable" = "false" ] || { echo "内置 package 保护字段非法: $mf" >&2; exit 1; }
      ;;
    "$PROJECT_ROOT/agents/packages/generated/agents/"*)
      [ "$origin" = "generated" ] && [ "$protected" = "false" ] && [ "$deletable" = "true" ] || { echo "生成 package 保护字段非法: $mf" >&2; exit 1; }
      ;;
    *) echo "package 不在允许目录: $mf" >&2; exit 1 ;;
  esac

  src_ws="$(normpath "$(jq_clean -r '.workspace_source_rel' "$mf_jq")")"
  [ -d "$src_ws" ] || { echo "workspace source 不存在: $src_ws" >&2; exit 1; }
  runtime_base="$(normpath "$RUNTIME_ROOT_ABS/$(jq_clean -r '.runtime_subdir' "$mf_jq")")"
  case "$runtime_base" in "$RUNTIME_ROOT_ABS/"*) :;; *) echo "runtime_subdir 逃逸: $mf" >&2; exit 1;; esac
  if [ "$origin" = "generated" ]; then
    case "$src_ws" in "$PROJECT_ROOT/agents/packages/generated/agents/"*) :;; *) echo "生成 workspace 逃逸: $src_ws" >&2; exit 1;; esac
    case "$runtime_base" in "$RUNTIME_ROOT_ABS/agents/generated/"*) :;; *) echo "生成 runtime 逃逸: $runtime_base" >&2; exit 1;; esac
  fi

  role="$(jq_clean -r '.role' "$mf_jq")"
  register="$(jq_clean -r '.lifecycle.register' "$mf_jq")"
  active="$(jq_clean -r '.lifecycle.active' "$mf_jq")"
  [ "$active" != "true" ] || [ "$register" = "true" ] || { echo "$id active=true 但 register=false" >&2; exit 1; }
  if [ "$role" = "manager" ]; then
    [ -z "$MANAGER_ID" ] || { echo "只能有一个 manager package" >&2; exit 1; }
    MANAGER_ID="$id"
  fi

  MANIFEST[$id]="$mf"; SRC_WS[$id]="$src_ws"; WS[$id]="$runtime_base/workspace"; DIR[$id]="$runtime_base/state"
  OC_WS[$id]="$(native_path "${WS[$id]}")"; OC_DIR[$id]="$(native_path "${DIR[$id]}")"
  MODEL[$id]="$(jq_clean -r '.model // ""' "$mf_jq")"; ROLE[$id]="$role"; ORIGIN[$id]="$origin"; PROTECTED[$id]="$protected"
  REGISTER[$id]="$register"; ACTIVE[$id]="$active"; CALLABLE[$id]="$(jq_clean -r '.delegation.callable_by_manager' "$mf_jq")"
  ALLOW_JSON[$id]="$(jq_clean -c '.delegation.allow_agents // []' "$mf_jq")"; SANDBOX[$id]="$(jq_clean -r '.sandbox_mode // ""' "$mf_jq")"
  INCLUDE_COMMON[$id]="$(jq_clean -r '.assembly.include_common_rules' "$mf_jq")"; INCLUDE_TEMPLATES[$id]="$(jq_clean -r '.assembly.include_templates' "$mf_jq")"
  if [ "$register" = "true" ]; then AGENT_IDS+=("$id"); fi
done

[ -n "$MANAGER_ID" ] || { echo "缺少 role=manager package" >&2; exit 1; }
[ "${REGISTER[$MANAGER_ID]}" = "true" ] && [ "${ACTIVE[$MANAGER_ID]}" = "true" ] || { echo "manager 必须 register=true 且 active=true" >&2; exit 1; }

for id in "${AGENT_IDS[@]}"; do
  if [ "${ROLE[$id]}" != "manager" ] && [ "${ACTIVE[$id]}" = "true" ] && [ "${CALLABLE[$id]}" = "true" ]; then
    WORKER_IDS+=("$id")
  fi
done
IFS=$'\n' WORKER_IDS=($(printf '%s\n' "${WORKER_IDS[@]}" | sort)); unset IFS
WORKER_ALLOW_JSON="$(printf '%s\n' "${WORKER_IDS[@]}" | jq -R . | jq -s -c . | tr -d '\r')"

# 可选模型配置（需要 jq）
if [ -n "$MODEL_CONFIG" ]; then
  case "$MODEL_CONFIG" in /*) : ;; *) MODEL_CONFIG="$(normpath "$MODEL_CONFIG")";; esac
  if [ -f "$MODEL_CONFIG" ]; then
    for id in "${AGENT_IDS[@]}"; do
      m="$(jq_clean -r --arg id "$id" '.agents[$id].model // empty' "$(native_path "$MODEL_CONFIG")" 2>/dev/null || true)"
      [ -n "$m" ] && MODEL[$id]="$m"
    done
  else
    echo "警告: ModelConfig 不存在，忽略：$MODEL_CONFIG" >&2
  fi
fi

# 校验 workspace / agentDir 彼此不同
uniq_ws="$(printf '%s\n' "${WS[@]}" | sort -u | wc -l | tr -d ' ')"
uniq_dir="$(printf '%s\n' "${DIR[@]}" | sort -u | wc -l | tr -d ' ')"
[ "$uniq_ws" -eq "${#AGENT_IDS[@]}" ] || { echo "workspace 路径存在重复" >&2; exit 1; }
[ "$uniq_dir" -eq "${#AGENT_IDS[@]}" ] || { echo "agentDir 路径存在重复" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. 探测 OpenClaw CLI（只读）
# ---------------------------------------------------------------------------
command -v openclaw >/dev/null 2>&1 || { echo "未找到 openclaw CLI，请先安装并确保在 PATH 中。" >&2; exit 1; }

OPENCLAW_VERSION="$(openclaw --version 2>&1 || true)"
echo "OpenClaw 版本 : $OPENCLAW_VERSION"
CONFIG_FILE="$(openclaw config file 2>/dev/null | tr -d '\r' | head -1 || true)"
CONFIG_FILE_SHELL="$(shell_path "$CONFIG_FILE")"
echo "配置文件      : $CONFIG_FILE"

# 现有 Agent id 列表（需要 jq；无 jq 时 dry-run 仍可继续，apply 则报错）
EXISTING_IDS=""
EXISTING_JSON="[]"
if [ "$HAS_JQ" -eq 1 ]; then
  EXISTING_JSON="$(openclaw agents list --json 2>/dev/null || printf '[]')"
  EXISTING_IDS="$(printf '%s' "$EXISTING_JSON" | jq -r '.[].id' 2>/dev/null | tr -d '\r' | tr '\n' ' ' || true)"
fi

contains() { case " $1 " in *" $2 "*) return 0;; *) return 1;; esac; }

# ---------------------------------------------------------------------------
# 3. runtime 目录清单
# ---------------------------------------------------------------------------
RUNTIME_DIRS=(
  "$RUNTIME_ROOT_ABS/control/workflows"
  "$RUNTIME_ROOT_ABS/control/config-snapshots"
  "$RUNTIME_ROOT_ABS/control/component-requests"
  "$RUNTIME_ROOT_ABS/control/component-builds"
  "$RUNTIME_ROOT_ABS/worktrees"
  "$RUNTIME_ROOT_ABS/artifacts"
)
for id in "${AGENT_IDS[@]}"; do
  RUNTIME_DIRS+=("${WS[$id]}" "${DIR[$id]}")
  [ "${INCLUDE_COMMON[$id]}" = "true" ] && RUNTIME_DIRS+=("${WS[$id]}/rules")
done

# ---------------------------------------------------------------------------
# 4. 冲突检测：同名 Agent（仅在有 jq 时精确比对 workspace）
# ---------------------------------------------------------------------------
path_key() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -m "$p" 2>/dev/null || printf '%s' "$p")"; fi
  printf '%s' "$p" | tr '\\' '/' | tr '[:upper:]' '[:lower:]'
}

if [ -n "$EXISTING_IDS" ]; then
  CONFLICT=0
  for id in "${AGENT_IDS[@]}"; do
    if contains "$EXISTING_IDS" "$id"; then
      ex_ws="$(printf '%s' "$EXISTING_JSON" | jq -r --arg id "$id" '.[] | select(.id==$id) | .workspace // ""' | tr -d '\r')"
      if [ -n "$ex_ws" ] && [ "$(path_key "$ex_ws")" != "$(path_key "${OC_WS[$id]}")" ]; then
        echo "  - Agent '$id' 已存在且 workspace 不同：现有=$ex_ws 期望=${OC_WS[$id]}" >&2
        CONFLICT=1
      else
        echo "Agent '$id' 已存在且兼容，安装将幂等跳过创建。"
      fi
    fi
  done
  if [ "$CONFLICT" -eq 1 ]; then
    echo "检测到不兼容的同名 Agent，安装停止（不会覆盖用户已有 Agent）。" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 5. 打印计划
# ---------------------------------------------------------------------------
echo ""
echo "== package catalog 中将注册的 Agent =="
for id in "${AGENT_IDS[@]}"; do
  mdl="${MODEL[$id]:-(继承默认)}"
  printf "  %-24s origin=%-9s ws=%s\n" "$id" "${ORIGIN[$id]}" "${WS[$id]}"
  printf "  %-24s dir=%s  model=%s active=%s\n" "" "${DIR[$id]}" "$mdl" "${ACTIVE[$id]}"
done
echo "  $MANAGER_ID subagents.allowAgents = ${WORKER_IDS[*]}"
echo "  manager subagents.requireAgentId = true ; delegationMode = prefer"

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# JSON 字符串转义（反斜杠 + 双引号），保证 Windows/Git Bash 下的 C:\ 路径也合法
json_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# 生成 manifest（JSON）辅助函数
write_manifest() {
  local out="$1" backup="$2"
  local agents_json="" first=1
  for id in "${AGENT_IDS[@]}"; do
    local allow="${ALLOW_JSON[$id]}" reqid="false" sb="null"
    if [ "$id" = "$MANAGER_ID" ]; then
      allow="$WORKER_ALLOW_JSON"
      reqid="true"
    fi
    [ -n "${SANDBOX[$id]}" ] && sb="\"$(json_escape "${SANDBOX[$id]}")\""
    [ $first -eq 0 ] && agents_json="$agents_json,"
    first=0
    local ews edir emdl emft esrc eorigin
    ews="$(json_escape "$(native_path "${OC_WS[$id]}")")"; edir="$(json_escape "$(native_path "${OC_DIR[$id]}")")"; emdl="$(json_escape "${MODEL[$id]}")"
    emft="$(json_escape "$(native_path "${MANIFEST[$id]}")")"; esrc="$(json_escape "$(native_path "${SRC_WS[$id]}")")"; eorigin="$(json_escape "${ORIGIN[$id]}")"
    agents_json="$agents_json{\"id\":\"$id\",\"origin\":\"$eorigin\",\"protected\":${PROTECTED[$id]},\"manifest_abs\":\"$emft\",\"workspace_source_abs\":\"$esrc\",\"workspace_abs\":\"$ews\",\"agentDir_abs\":\"$edir\",\"model\":\"$emdl\",\"register\":true,\"active\":${ACTIVE[$id]},\"subagents_allow\":$allow,\"require_agent_id\":$reqid,\"sandbox_mode\":$sb}"
  done
  local ecfg epr err
  ecfg="$(json_escape "$(native_path "$CONFIG_FILE")")"; epr="$(json_escape "$(native_path "$PROJECT_ROOT")")"; err="$(json_escape "$(native_path "$RUNTIME_ROOT_ABS")")"
  cat > "$out" <<EOF
{
  "schema_version": 2,
  "generated_at": "$GENERATED_AT",
  "mode": "$MODE",
  "openclaw_version": "$(json_escape "$OPENCLAW_VERSION")",
  "config_file": "$ecfg",
  "project_root_abs": "$epr",
  "runtime_root_abs": "$err",
  "config_backup": ${backup},
  "package_catalog_root_abs": "$(json_escape "$(native_path "$PROJECT_ROOT/agents/packages")")",
  "agents": [ $agents_json ]
}
EOF
}

# ---------------------------------------------------------------------------
# 6. DRYRUN：只打印计划
# ---------------------------------------------------------------------------
if [ "$APPLY" -eq 0 ]; then
  echo ""
  echo "[DRYRUN] 将创建的 runtime 目录（示例）："
  printf '  %s\n' "${RUNTIME_DIRS[@]:0:8}"
  echo "  ... 共 ${#RUNTIME_DIRS[@]} 个目录"
  echo ""
  echo "[DRYRUN] 将执行的 openclaw agents add 语义（未执行）："
  for id in "${AGENT_IDS[@]}"; do
    modelarg=""; [ -n "${MODEL[$id]}" ] && modelarg=" --model \"${MODEL[$id]}\""
    echo "  openclaw agents add $id --non-interactive --workspace \"${OC_WS[$id]}\" --agent-dir \"${OC_DIR[$id]}\"$modelarg --json"
  done
  echo ""
  echo "[DRYRUN] 将通过 config set --dry-run 校验 subagents/sandbox 字段（未写入）。"
  DRY_DIR="$PROJECT_ROOT/artifacts/install-dryrun"
  mkdir -p "$DRY_DIR"
  write_manifest "$DRY_DIR/install-manifest.dryrun.json" "null"
  echo ""
  echo "[DRYRUN] 计划清单已写入：$DRY_DIR/install-manifest.dryrun.json"
  echo "[DRYRUN] 未修改任何 OpenClaw 配置。要真正安装请加 --apply。"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. APPLY：确认 -> 备份 -> 目录/复制 -> 创建 Agent -> patch -> 校验
# ---------------------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  echo "即将同步 ${#AGENT_IDS[@]} 个 Agent package。"
  read -r -p "确认继续？输入 yes 继续，其它取消: " ans
  [ "$ans" = "yes" ] || { echo "已取消。"; exit 0; }
fi

# 7.1 创建 runtime 目录
for d in "${RUNTIME_DIRS[@]}"; do mkdir -p "$d"; done

# 7.2 备份当前配置
SNAP_DIR="$RUNTIME_ROOT_ABS/control/config-snapshots"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_JSON="null"
if [ -n "$CONFIG_FILE_SHELL" ] && [ -f "$CONFIG_FILE_SHELL" ]; then
  BACKUP_PATH="$SNAP_DIR/openclaw.json.$STAMP.bak"
  cp -f "$CONFIG_FILE_SHELL" "$BACKUP_PATH"
  BACKUP_JSON="\"$BACKUP_PATH\""
  echo "已备份配置到：$BACKUP_PATH"
else
  echo "警告: 未找到配置文件 $CONFIG_FILE，跳过备份（首次配置？）" >&2
fi

restore_on_failure() {
  echo ""
  echo "[恢复] $1" >&2
  if [ "$BACKUP_JSON" != "null" ]; then
    bp="${BACKUP_JSON%\"}"; bp="${bp#\"}"
    if [ -f "$bp" ] && [ -n "$CONFIG_FILE_SHELL" ]; then
      cp -f "$bp" "$CONFIG_FILE_SHELL" && echo "[恢复] 已从备份还原配置：$bp" >&2
    fi
  else
    echo "[恢复] 无可用配置备份（可能尚未进入写入阶段）。" >&2
  fi
  echo "[恢复] 可能残留的本项目 runtime 目录（不会自动删除）：$RUNTIME_ROOT_ABS" >&2
}

# 7.3 复制 workspace prompt + 共享规则 + 模板 到绝对 workspace（自包含）
SRC_COMMON="$PROJECT_ROOT/agents/common"
SRC_TEMPLATES="$PROJECT_ROOT/templates"
SRC_SYSTEM_SKILLS="$PROJECT_ROOT/agents/packages/system/skills"
for id in "${AGENT_IDS[@]}"; do
  src_ws="${SRC_WS[$id]}"
  dst_ws="${WS[$id]}"
  if [ -d "$src_ws" ]; then
    cp -Rf "$src_ws/." "$dst_ws/"
  fi
  if [ "${INCLUDE_COMMON[$id]}" = "true" ] && [ -d "$SRC_COMMON" ]; then
    mkdir -p "$dst_ws/rules"
    cp -f "$SRC_COMMON"/*.md "$dst_ws/rules/" 2>/dev/null || true
  fi
  if [ "${INCLUDE_TEMPLATES[$id]}" = "true" ] && [ -d "$SRC_TEMPLATES" ]; then
    mkdir -p "$dst_ws/templates"
    cp -Rf "$SRC_TEMPLATES/." "$dst_ws/templates/"
  fi
  while IFS= read -r skill; do
    [ -n "$skill" ] || continue
    if [ -d "$SRC_SYSTEM_SKILLS/$skill" ]; then
      mkdir -p "$dst_ws/skills/$skill"
      cp -Rf "$SRC_SYSTEM_SKILLS/$skill/." "$dst_ws/skills/$skill/"
    fi
  done < <(jq_clean -r '.skills[]? // empty' "$(native_path "${MANIFEST[$id]}")")
done
echo "已复制 workspace prompt / 共享规则 / 模板到绝对 workspace。"

# 7.4 创建 package 中声明 register=true 的 Agent（幂等）
CONFIG_CHANGES=()
for id in "${AGENT_IDS[@]}"; do
  if contains "$EXISTING_IDS" "$id"; then
    echo "跳过已存在且兼容的 Agent：$id"
    continue
  fi
  add_args=(agents add "$id" --non-interactive --workspace "${OC_WS[$id]}" --agent-dir "${OC_DIR[$id]}" --json)
  [ -n "${MODEL[$id]}" ] && add_args+=(--model "${MODEL[$id]}")
  echo "创建 Agent：$id"
  if ! openclaw "${add_args[@]}" >/dev/null 2>&1; then
    restore_on_failure "创建 Agent $id 失败"
    echo "创建 Agent $id 失败。已尝试恢复配置备份。" >&2
    exit 1
  fi
  CONFIG_CHANGES+=("agents add $id")
done

# 7.5 定位真实索引并 patch subagents / sandbox（先 dry-run 校验，再写入）
agent_index() {
  openclaw config get "agents.list" --json 2>/dev/null \
    | jq -r --arg id "$1" 'to_entries[] | select(.value.id==$id) | .key' | tr -d '\r' | head -1
}

set_json() {
  # $1=path  $2=json  —— 先 dry-run 再写入
  if ! openclaw config set "$1" "$2" --strict-json --dry-run >/dev/null 2>&1; then
    restore_on_failure "config set dry-run 失败: $1"; exit 1
  fi
  if ! openclaw config set "$1" "$2" --strict-json >/dev/null 2>&1; then
    restore_on_failure "config set 写入失败: $1"; exit 1
  fi
  CONFIG_CHANGES+=("set $1")
}

for id in "${AGENT_IDS[@]}"; do
  idx="$(agent_index "$id")"
  [ -n "$idx" ] || { echo "配置中未找到 Agent $id 的索引，停止。" >&2; restore_on_failure "索引缺失 $id"; exit 1; }
  if [ "$id" = "$MANAGER_ID" ]; then
    set_json "agents.list[$idx].subagents" "{\"delegationMode\":\"prefer\",\"requireAgentId\":true,\"allowAgents\":$WORKER_ALLOW_JSON}"
  else
    set_json "agents.list[$idx].subagents" "{\"allowAgents\":${ALLOW_JSON[$id]}}"
  fi
  if [ -n "${SANDBOX[$id]}" ]; then
    set_json "agents.list[$idx].sandbox" "{\"mode\":\"${SANDBOX[$id]}\"}"
  fi
done

# 7.6 可选：默认 Agent / binding
if [ "$SET_MANAGER_DEFAULT" -eq 1 ]; then
  mi="$(agent_index "$MANAGER_ID")"
  if openclaw config set "agents.list[$mi].default" "true" --strict-json >/dev/null 2>&1; then
    CONFIG_CHANGES+=("set $MANAGER_ID.default=true")
  else
    echo "警告: 设置 manager 默认失败" >&2
  fi
fi
if [ -n "$MANAGER_BINDING" ]; then
  if openclaw agents bind "$MANAGER_ID" --bind "$MANAGER_BINDING" >/dev/null 2>&1; then
    CONFIG_CHANGES+=("bind $MANAGER_ID $MANAGER_BINDING")
  else
    echo "警告: manager binding 失败" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 8. 校验（不 --fix）
# ---------------------------------------------------------------------------
VALIDATE_OUT="$(openclaw config validate --json 2>&1)"; VALIDATE_EXIT=$?
echo ""
echo "config validate exit=$VALIDATE_EXIT"
echo "$VALIDATE_OUT"
openclaw agents list --json >/dev/null 2>&1 && echo "agents list exit=0" || echo "agents list exit=非0"
openclaw doctor --lint --json >/dev/null 2>&1 && DOCTOR_EXIT=0 || DOCTOR_EXIT=$?

# ---------------------------------------------------------------------------
# 9. 写 install-manifest.json
# ---------------------------------------------------------------------------
MANIFEST_PATH="$RUNTIME_ROOT_ABS/control/install-manifest.json"
write_manifest "$MANIFEST_PATH" "$BACKUP_JSON"
# 追加校验结果与变更（简单方式：用 jq 合并）
tmp="$(mktemp)"
jq --argjson ve "$VALIDATE_EXIT" --argjson de "$DOCTOR_EXIT" \
   --arg vo "$VALIDATE_OUT" \
   --argjson changes "$(printf '%s\n' "${CONFIG_CHANGES[@]:-}" | jq -R . | jq -s .)" \
   '. + {validation:{config_validate_exit:$ve,config_validate_out:$vo,doctor_lint_exit:$de}, config_changes:$changes}' \
   "$(native_path "$MANIFEST_PATH")" > "$tmp" && mv "$tmp" "$MANIFEST_PATH"
echo ""
echo "安装清单已写入：$MANIFEST_PATH"

if [ "$VALIDATE_EXIT" -ne 0 ]; then
  echo "config validate 未通过，请检查上面输出。配置备份位于：${BACKUP_JSON}"
else
  echo "== 安装完成（APPLY）。config validate 通过。 =="
fi
