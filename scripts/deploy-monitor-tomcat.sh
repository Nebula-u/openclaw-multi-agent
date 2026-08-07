#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
TOMCAT_WEBAPPS="${TOMCAT_WEBAPPS:-/var/lib/tomcat10/webapps}"
SERVLET_API_JAR="${SERVLET_API_JAR:-/usr/share/tomcat10/lib/servlet-api.jar}"
TARGET="$TOMCAT_WEBAPPS/monitor"

[ -r "$SERVLET_API_JAR" ] || { echo "Tomcat Servlet API 不可读：$SERVLET_API_JAR" >&2; exit 1; }
command -v javac >/dev/null 2>&1 || { echo "未找到 javac" >&2; exit 1; }
command -v rsync >/dev/null 2>&1 || { echo "未找到 rsync" >&2; exit 1; }

STAGE="$(mktemp -d)"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$STAGE/WEB-INF/classes"
cp -a "$PROJECT_ROOT/monitor/ui/." "$STAGE/"
cp "$PROJECT_ROOT/deploy/tomcat-monitor/config.js" "$STAGE/config.js"
cp "$PROJECT_ROOT/deploy/tomcat-monitor/web.xml" "$STAGE/WEB-INF/web.xml"
javac -cp "$SERVLET_API_JAR" -d "$STAGE/WEB-INF/classes" "$PROJECT_ROOT/deploy/tomcat-monitor/MonitorProxyServlet.java"

sudo install -d -o tomcat -g tomcat -m 0755 "$TARGET"
sudo rsync -a --delete --chown=tomcat:tomcat "$STAGE/" "$TARGET/"
echo "Tomcat Monitor 已部署：$TARGET"
