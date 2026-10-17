#!/usr/bin/env bash
# ============================================================
#  保持沟通就没人爆炸 —— 启动脚本（macOS / Linux）
#
#    ./start.sh                默认端口 3210，自动打开浏览器
#    ./start.sh 8080           换端口
#    ./start.sh 8080 --nobrowser
#    ./start.sh 3210 --admin-token=我的令牌
#    ./start.sh 3388 --test    测试模式（正常玩不要加）
#
#  按 Ctrl+C 停止服务。
# ============================================================
set -euo pipefail

PORT="${1:-3210}"
if [ "$#" -gt 0 ]; then shift; fi

OPEN=1
ARGS=()
for a in "$@"; do
  if [ "$a" = "--nobrowser" ]; then
    OPEN=""
  else
    ARGS+=("$a")
  fi
done

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$DIR/server/server.js"

if ! command -v node >/dev/null 2>&1; then
  echo "[bomb] 没有找到 node，请先安装 Node.js 18+：https://nodejs.org/" >&2
  exit 1
fi
if [ ! -f "$ENTRY" ]; then
  echo "[bomb] 找不到 $ENTRY" >&2
  exit 1
fi

open_browser() {
  url="http://localhost:$PORT/"
  i=0
  while [ "$i" -lt 60 ]; do
    if command -v curl >/dev/null 2>&1 && curl -fsS -o /dev/null "$url" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then open "$url"
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"
      fi
      return 0
    fi
    i=$((i + 1))
    sleep 0.25
  done
}

echo
echo "[bomb] 正在启动服务，端口 $PORT ...（Ctrl+C 停止）"
echo
if [ -n "$OPEN" ]; then open_browser & fi

exec node "$ENTRY" "$PORT" ${ARGS[@]+"${ARGS[@]}"}
