#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SKIP_LOGIN=0
SKIP_GCLOUD=0
SKIP_NOVVY_PLUGIN=0
for argument in "$@"; do
  case "$argument" in
    --skip-login) SKIP_LOGIN=1 ;;
    --without-gcloud) SKIP_GCLOUD=1 ;;
    --without-novvy-plugin) SKIP_NOVVY_PLUGIN=1 ;;
    -h|--help)
      echo "用法：./install_environment.sh [--skip-login] [--without-gcloud] [--without-novvy-plugin]"
      echo "  默认                   安装完整环境、Novvy 插件，并引导登录 Codex"
      echo "  --skip-login           安装环境，但暂不登录 Codex"
      echo "  --without-gcloud       不安装 Google Cloud CLI（将不能使用 ImaRouter 本地图片上传）"
      echo "  --without-novvy-plugin 不下载和安装 Novvy 广告创意插件"
      exit 0
      ;;
    *)
      echo "未知参数：$argument" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n%s\n' "$1"; }
fail() { printf '\n安装未完成：%s\n' "$1" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ]; then
  fail "当前一键脚本只支持 macOS。Linux/Windows 请参照 README 手动安装。"
fi

say "Contextual Studio 环境安装程序"
echo "它将安装 Homebrew、Node.js 24、Python 3、FFmpeg、Codex CLI、项目依赖、Novvy 插件，以及可选的 Google Cloud CLI。"
echo "过程中 macOS 可能要求输入电脑登录密码；输入密码时终端不会显示字符，这是正常现象。"

if ! xcode-select -p >/dev/null 2>&1; then
  say "正在安装 Apple 命令行工具…"
  xcode-select --install >/dev/null 2>&1 || true
  echo "macOS 已弹出安装窗口。请完成安装，然后再次双击或运行本脚本。"
  exit 0
fi

if ! command -v brew >/dev/null 2>&1; then
  say "正在安装 Homebrew…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi
command -v brew >/dev/null 2>&1 || fail "Homebrew 已安装但当前终端找不到它。请关闭终端、重新打开后再运行脚本。"

say "正在安装 Node.js 24、Python 3 和 FFmpeg…"
brew install node@24 python ffmpeg

NODE_PREFIX="$(brew --prefix node@24)"
export PATH="$NODE_PREFIX/bin:$PATH"
SHELL_PROFILE="$HOME/.zprofile"
PATH_LINE="export PATH=\"$NODE_PREFIX/bin:\$PATH\""
touch "$SHELL_PROFILE"
if ! grep -F "$NODE_PREFIX/bin" "$SHELL_PROFILE" >/dev/null 2>&1; then
  printf '\n# Contextual Studio Node.js 24\n%s\n' "$PATH_LINE" >> "$SHELL_PROFILE"
fi

if [ "$SKIP_GCLOUD" -eq 0 ] && ! command -v gcloud >/dev/null 2>&1; then
  say "正在安装 Google Cloud CLI（供 ImaRouter 上传参考图使用）…"
  brew install --cask google-cloud-sdk
fi

command -v node >/dev/null 2>&1 || fail "没有找到 Node.js。"
command -v npm >/dev/null 2>&1 || fail "没有找到 npm。"
command -v python3 >/dev/null 2>&1 || fail "没有找到 Python 3。"
command -v ffmpeg >/dev/null 2>&1 || fail "没有找到 FFmpeg。"
command -v ffprobe >/dev/null 2>&1 || fail "没有找到 FFprobe。"

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "当前 Node.js 为 $(node --version)，但项目要求 24 或更高版本。请关闭终端后重新运行脚本。"
fi

PYTHON_ENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -x "$PYTHON_ENV_DIR/bin/python" ]; then
  say "正在创建项目 Python 环境…"
  python3 -m venv "$PYTHON_ENV_DIR"
else
  echo "检测到已有项目 Python 环境，跳过创建。"
fi

if "$PYTHON_ENV_DIR/bin/python" -c "import PIL" >/dev/null 2>&1; then
  echo "检测到 Pillow 已安装，跳过安装。"
else
  say "正在安装图片校验依赖 Pillow…"
  "$PYTHON_ENV_DIR/bin/python" -m pip install Pillow
fi

"$PYTHON_ENV_DIR/bin/python" -c "from PIL import Image; print('Pillow 已就绪：' + Image.__version__)"

if "$PYTHON_ENV_DIR/bin/python" -c "import mlflow; raise SystemExit(0 if mlflow.__version__ == '3.15.2' else 1)" >/dev/null 2>&1; then
  echo "检测到 MLflow 3.15.2 已安装，跳过安装。"
else
  say "正在安装 MLflow Server 和 Tracing 依赖…"
  "$PYTHON_ENV_DIR/bin/python" -m pip install -r requirements-mlflow.txt
fi

say "正在安装 Contextual Studio 项目依赖…"
npm install

if ! command -v codex >/dev/null 2>&1; then
  say "正在安装 Codex CLI…"
  npm install -g @openai/codex
else
  echo "检测到 Codex CLI 已安装，跳过安装。"
fi
command -v codex >/dev/null 2>&1 || fail "Codex CLI 安装完成后仍无法找到 codex 命令。请关闭终端、重新打开后再运行脚本。"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已创建 .env 配置文件。Novvy/ImaRouter 密钥仍需由团队提供，不会自动写入。"
else
  echo "检测到已有 .env，已保留，不会覆盖。"
fi

if [ "$SKIP_NOVVY_PLUGIN" -eq 0 ]; then
  NOVVY_SKILLS_DIR="${NOVVY_SKILLS_INSTALL_DIR:-$HOME/.local/share/novvy-skills}"
  NOVVY_PLUGIN_DIR="$NOVVY_SKILLS_DIR/novvy-ad-creative"
  if [ -d "$NOVVY_SKILLS_DIR/.git" ]; then
    say "正在更新 Novvy 广告创意插件…"
    git -C "$NOVVY_SKILLS_DIR" pull --ff-only
  elif [ -e "$NOVVY_SKILLS_DIR" ]; then
    fail "$NOVVY_SKILLS_DIR 已存在但不是 Novvy skills Git 仓库。请移动该目录后重新运行。"
  else
    say "正在下载 Novvy 广告创意插件…"
    mkdir -p "$(dirname "$NOVVY_SKILLS_DIR")"
    git clone --depth 1 https://github.com/NovvyAI/skills.git "$NOVVY_SKILLS_DIR"
  fi

  [ -x "$NOVVY_PLUGIN_DIR/install.sh" ] || chmod +x "$NOVVY_PLUGIN_DIR/install.sh"
  NOVVY_LOCAL_KEY_FILE="$NOVVY_PLUGIN_DIR/novvy-plugin-local.json"
  NOVVY_KEY_CONFIGURED="$($PYTHON_ENV_DIR/bin/python - "$NOVVY_LOCAL_KEY_FILE" <<'PYCODE'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
try:
    value = json.loads(path.read_text(encoding="utf-8")).get("adminUserApiKey", "")
except (OSError, json.JSONDecodeError, AttributeError):
    value = ""
configured = isinstance(value, str) and bool(value.strip()) and not any(marker in value.lower() for marker in ("placeholder", "generated-by", "<admin_user.apikey>"))
print("yes" if configured else "no")
PYCODE
)"
  if [ "$NOVVY_KEY_CONFIGURED" = "no" ] && [ -t 0 ]; then
    say "配置 Novvy MCP 权限"
    echo "请输入团队分配给这台电脑的 Novvy admin_user.apikey。输入内容不会显示；直接回车可暂时跳过。"
    IFS= read -r -s NOVVY_INSTALL_API_KEY
    printf '\n'
    if [ -n "$NOVVY_INSTALL_API_KEY" ]; then
      export NOVVY_INSTALL_API_KEY
      "$PYTHON_ENV_DIR/bin/python" - "$NOVVY_LOCAL_KEY_FILE" <<'PYCODE'
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
value = os.environ.get("NOVVY_INSTALL_API_KEY", "").strip()
if value.lower().startswith("bearer "):
    value = value[7:].strip()
if not value:
    raise SystemExit("未读取到 Novvy admin_user.apikey")
path.write_text(json.dumps({"adminUserApiKey": value}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(path, 0o600)
PYCODE
      unset NOVVY_INSTALL_API_KEY
      echo "Novvy API key 已保存到本机私有配置（未显示密钥）。"
    else
      echo "已跳过 Novvy API key 配置；插件仍会安装，之后可运行 \$novvy-env-check 完成配置。"
    fi
  elif [ "$NOVVY_KEY_CONFIGURED" = "yes" ]; then
    echo "检测到已有 Novvy 本机私有 API key，安装时会自动同步（不会显示密钥）。"
  else
    echo "当前不是交互式终端，无法安全输入 Novvy API key；插件仍会安装，之后请运行 \$novvy-env-check。"
  fi

  say "正在安装 Novvy 广告创意插件…"
  "$NOVVY_PLUGIN_DIR/install.sh"
else
  echo "已跳过 Novvy 广告创意插件安装。"
fi

say "正在执行项目检查…"
npm run check

if [ "$SKIP_LOGIN" -eq 0 ]; then
  say "接下来登录 Codex。浏览器打开后，请使用有权限的账号完成登录。"
  codex login
else
  echo "已跳过登录。以后请在项目目录运行：codex login"
fi

say "环境安装完成"
echo "启动项目：./start_server.sh"
echo "打开页面：http://127.0.0.1:4180"
if [ "$SKIP_GCLOUD" -eq 0 ]; then
  echo "首次使用 ImaRouter 前，还需运行：gcloud auth login"
fi
echo "Novvy 插件位置：${NOVVY_PLUGIN_DIR:-未安装}"
echo "如果安装时跳过了 Novvy API key，请新开 Codex 对话运行：使用 \$novvy-env-check，检查 Novvy 插件本地环境。"
