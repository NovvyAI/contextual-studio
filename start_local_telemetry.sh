#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$script_dir"

export LOCAL_TELEMETRY_PORT="${LOCAL_TELEMETRY_PORT:-4191}"
export LOCAL_TELEMETRY_TOKEN="${LOCAL_TELEMETRY_TOKEN:-contextual-local-dev}"
exec node server/local-telemetry-server.js
