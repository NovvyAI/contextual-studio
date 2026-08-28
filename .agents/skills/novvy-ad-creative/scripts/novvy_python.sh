#!/usr/bin/env bash
set -euo pipefail
MIN_VERSION="${NOVVY_PYTHON_MIN_VERSION:-3.10}"
for candidate in "${NOVVY_PYTHON:-}" python3 python; do
  [[ -n "$candidate" ]] || continue
  resolved="$(command -v "$candidate" 2>/dev/null || true)"
  [[ -n "$resolved" && -x "$resolved" ]] || continue
  if "$resolved" - "$MIN_VERSION" >/dev/null 2>&1 <<'PYCODE'
import sys
minimum = tuple(int(part) for part in sys.argv[1].split('.'))
raise SystemExit(0 if sys.version_info[:len(minimum)] >= minimum else 1)
PYCODE
  then
    "$resolved" - <<'PYCODE'
import sys
print(sys.executable)
PYCODE
    exit 0
  fi
done
echo "未找到可用 Python ${MIN_VERSION}+。请安装 python3，或设置 NOVVY_PYTHON=/path/to/python 后重试。" >&2
exit 1
