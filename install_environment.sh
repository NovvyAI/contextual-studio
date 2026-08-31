#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SKIP_LOGIN=0
SKIP_GCLOUD=0
for argument in "$@"; do
  case "$argument" in
    --skip-login) SKIP_LOGIN=1 ;;
    --without-gcloud) SKIP_GCLOUD=1 ;;
    -h|--help)
      echo "用法：./install_environment.sh [--skip-login] [--without-gcloud]"
      echo "  默认             安装完整环境，并引导登录 Novvy（Codex）"
      echo "  --skip-login     安装环境，但暂不登录 Novvy"
      echo "  --without-gcloud 不安装 Google Cloud CLI（将不能使用 ImaRouter 本地图片上传）"
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
echo "它将安装 Homebrew、Node.js 24、Python 3、FFmpeg、项目依赖，以及可选的 Google Cloud CLI。"
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

say "正在安装 Contextual Studio 项目依赖…"
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已创建 .env 配置文件。Novvy/ImaRouter 密钥仍需由团队提供，不会自动写入。"
else
  echo "检测到已有 .env，已保留，不会覆盖。"
fi

say "正在执行项目检查…"
npm run check

if [ "$SKIP_LOGIN" -eq 0 ]; then
  say "接下来登录 Novvy。浏览器打开后，请使用有权限的账号完成登录。"
  npx codex login
else
  echo "已跳过登录。以后请在项目目录运行：npx codex login"
fi

say "环境安装完成"
echo "启动项目：./start_server.sh"
echo "打开页面：http://127.0.0.1:4180"
if [ "$SKIP_GCLOUD" -eq 0 ]; then
  echo "首次使用 ImaRouter 前，还需运行：gcloud auth login"
fi
echo "如需生成 Novvy 图片或视频，请让团队管理员把有效凭据填入项目 .env。"
