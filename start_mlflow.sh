#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir"

if [ ! -x .venv/bin/mlflow ]; then
  echo "错误：MLflow 尚未安装。请先运行 ./install_environment.sh。" >&2
  exit 1
fi

port="${MLFLOW_PORT:-5050}"
mkdir -p data/mlflow/artifacts
echo "MLflow UI 即将启动：http://127.0.0.1:${port}"
exec .venv/bin/mlflow server \
  --backend-store-uri sqlite:///data/mlflow/mlflow.db \
  --artifacts-destination "$script_dir/data/mlflow/artifacts" \
  --host 127.0.0.1 \
  --port "$port"
