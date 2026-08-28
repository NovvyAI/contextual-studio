#!/usr/bin/env python3
"""Self-contained local configuration helpers for the vendored Novvy skill."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

WORKSPACE_ENV = "NOVVY_WORKSPACE_DIR"
CONFIG_ENV = "NOVVY_CONFIG_FILE"
API_KEY_ENV = "NOVVY_API_KEY"
AUTHORIZATION_ENV = "NOVVY_AUTHORIZATION"
CONFIG_FILE_NAME = "novvy-plugin-config.json"
API_KEY_KEYS = ("adminUserApiKey", "apiKey", "novvyApiKey", "novvyAiPlatformApiKey")


def workspace_dir() -> Path:
    configured_file = os.environ.get(CONFIG_ENV, "").strip()
    if configured_file:
        return Path(configured_file).expanduser().resolve().parent
    configured_dir = os.environ.get(WORKSPACE_ENV, "").strip()
    if configured_dir:
        return Path(configured_dir).expanduser().resolve()
    return Path.home() / "novvy_ad_workplace"


def config_path() -> Path:
    configured_file = os.environ.get(CONFIG_ENV, "").strip()
    return Path(configured_file).expanduser().resolve() if configured_file else workspace_dir() / CONFIG_FILE_NAME


def read_config(path: Path | None = None) -> dict[str, Any]:
    try:
        data = json.loads((path or config_path()).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def resolve_binary(name: str, config: dict[str, Any] | None = None) -> str:
    data = config or read_config()
    candidate = data.get(f"{name}Path")
    if isinstance(candidate, str):
        path = Path(candidate).expanduser()
        if path.exists() and os.access(path, os.X_OK):
            return str(path)
    return shutil.which(name) or ""


def _normalize_key(value: object) -> str:
    text = value.strip() if isinstance(value, str) else ""
    return text[7:].strip() if text.lower().startswith("bearer ") else text


def _looks_placeholder(value: str) -> bool:
    lowered = value.lower()
    return not value or lowered in {"todo", "xxx", "xxxx", "xxxxx"} or any(
        marker in lowered for marker in ("your-", "your_", "<", ">", "${", "changeme", "placeholder", "填入", "替换")
    )


def configured_api_key(config: dict[str, Any] | None = None, *, plugin_root: Path | None = None) -> str:
    data = config or read_config()
    candidates = [os.environ.get(AUTHORIZATION_ENV), os.environ.get(API_KEY_ENV)]
    candidates.extend(data.get(key) for key in API_KEY_KEYS)
    for candidate in candidates:
        token = _normalize_key(candidate)
        if token and not _looks_placeholder(token):
            return token
    return ""


def configured_api_key_status(config: dict[str, Any] | None = None, *, plugin_root: Path | None = None) -> dict[str, Any]:
    token = configured_api_key(config, plugin_root=plugin_root)
    return {
        "name": "adminUserApiKey",
        "ok": bool(token),
        "configured": bool(token),
        "safeSummary": "Novvy API key 已配置。" if token else "未在本地参数文件或环境变量中找到有效的 Novvy API key。",
    }
