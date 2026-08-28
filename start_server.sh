#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="${1:-start}"
case "$MODE" in
  start|--start) MODE="start" ;;
  --dev|dev) MODE="dev" ;;
  --check|check) MODE="check" ;;
  -h|--help)
    echo "用法: ./start_server.sh [--dev|--check]"
    echo "  默认      启动 Contextual Studio"
    echo "  --dev     使用 Node.js watch 模式启动"
    echo "  --check   只执行项目语法检查"
    exit 0
    ;;
  *)
    echo "未知参数: $MODE" >&2
    echo "运行 ./start_server.sh --help 查看用法。" >&2
    exit 2
    ;;
esac

command -v node >/dev/null 2>&1 || { echo "错误：未找到 Node.js，需要 Node.js 24+。" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "错误：未找到 npm。" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "错误：未找到 ffmpeg。" >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo "错误：未找到 ffprobe。" >&2; exit 1; }

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "错误：当前 Node.js 是 $(node --version)，项目要求 Node.js 24+。" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行：正在安装 npm 依赖…"
  npm install
fi

if [ ! -f .env ]; then
  echo "提示：未找到 .env，将使用默认值和本机已有配置。"
  echo "如需 Novvy MCP 或 ImaRouter，请先执行: cp .env.example .env"
fi

if [ "$MODE" = "check" ]; then
  echo "正在检查项目…"
  exec npm run check
fi

PORT_VALUE="$(node --env-file-if-exists=.env -p "process.env.PORT || '4180'")"
echo "Contextual Studio 即将启动：http://127.0.0.1:${PORT_VALUE}"
echo "按 Ctrl+C 停止服务。"

if [ "$MODE" = "dev" ]; then
  exec npm run dev
fi

exec npm start
