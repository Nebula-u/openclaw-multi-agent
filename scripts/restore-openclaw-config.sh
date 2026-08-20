#!/usr/bin/env bash
# =============================================================================
# 从 openclaw-sdlc-multi-agent 生成的配置快照恢复 OpenClaw 配置（Bash 等价实现）
# 仅恢复用户明确选择的快照；覆盖前先再次备份当前配置。
# 不删除任何 Agent / workspace / 会话 / 用户后续创建的数据。
# 注意：恢复配置与删除 workspace 是两件不同的事——本脚本只处理 openclaw.json。
# =============================================================================
set -euo pipefail

SNAPSHOT=""
RUNTIME_ROOT="runtime"
ASSUME_YES=0
usage() {
  cat <<'EOF'
用法: restore-openclaw-config.sh [选项]
  --snapshot <path>       要恢复的快照路径；缺省则仅列出可选快照
  --runtime-root <path>   runtime 根目录（相对值相对项目根解析），默认 runtime
  --yes                   非交互确认
  -h, --help              帮助
EOF
}
while [ $# -gt 0 ]; do
  case "$1" in
    --snapshot) SNAPSHOT="${2:?}"; shift 2 ;;
    --runtime-root) RUNTIME_ROOT="${2:?}"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
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
case "$RUNTIME_ROOT" in /*) RUNTIME_ROOT_ABS="$RUNTIME_ROOT";; *) RUNTIME_ROOT_ABS="$PROJECT_ROOT/$RUNTIME_ROOT";; esac
SNAP_DIR="$RUNTIME_ROOT_ABS/control/config-snapshots"

command -v openclaw >/dev/null 2>&1 || { echo "未找到 openclaw CLI。" >&2; exit 1; }
CONFIG_FILE="$(openclaw config file 2>/dev/null | tr -d '\r' | head -1)"
echo "当前配置文件 : $CONFIG_FILE"
echo "快照目录     : $SNAP_DIR"

# 未指定快照：列出后退出
if [ -z "$SNAPSHOT" ]; then
  if [ ! -d "$SNAP_DIR" ]; then echo "没有快照目录（尚未 Apply 安装过？）：$SNAP_DIR"; exit 0; fi
  shopt -s nullglob
  snaps=("$SNAP_DIR"/openclaw.json.*.bak)
  shopt -u nullglob
  if [ ${#snaps[@]} -eq 0 ]; then echo "没有可用快照。"; exit 0; fi
  echo ""
  echo "可用快照（用 --snapshot 选择其一恢复）："
  ls -1t "$SNAP_DIR"/openclaw.json.*.bak | sed 's/^/  /'
  echo ""
  echo "提示：恢复配置不会删除任何 workspace / Agent 数据。"
  exit 0
fi

case "$SNAPSHOT" in /*) : ;; *) SNAPSHOT="$PROJECT_ROOT/$SNAPSHOT";; esac
[ -f "$SNAPSHOT" ] || { echo "快照不存在：$SNAPSHOT" >&2; exit 1; }
if command -v jq >/dev/null 2>&1; then
  jq empty "$SNAPSHOT" >/dev/null 2>&1 || { echo "快照不是合法 JSON，拒绝恢复：$SNAPSHOT" >&2; exit 1; }
fi

echo ""
echo "将用以下快照覆盖当前配置："
echo "  快照 : $SNAPSHOT"
echo "  目标 : $CONFIG_FILE"
echo "覆盖前会自动再次备份当前配置。不会删除任何 workspace / Agent 数据。"

if [ "$ASSUME_YES" -ne 1 ]; then
  read -r -p "确认恢复？输入 yes 继续，其它取消: " ans
  [ "$ans" = "yes" ] || { echo "已取消。"; exit 0; }
fi

mkdir -p "$SNAP_DIR"
if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  PRE="$SNAP_DIR/openclaw.json.$STAMP.pre-restore.bak"
  cp -f "$CONFIG_FILE" "$PRE"
  echo "已备份当前配置到：$PRE"
else
  echo "警告：当前配置文件不存在，恢复将直接写入：$CONFIG_FILE" >&2
fi

cp -f "$SNAPSHOT" "$CONFIG_FILE"
echo "已恢复配置。"

if openclaw config validate --json >/dev/null 2>&1; then
  echo "config validate exit=0"
else
  echo "警告：恢复后 config validate 未通过 (exit=$?)，请检查。" >&2
fi
echo ""
echo "提醒：如需清理 runtime workspace/worktree/artifacts，请手动删除；本脚本不做删除。"
