#!/usr/bin/env python3
"""Shared local configuration helpers for Novvy plugin scripts."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any


CONFIG_SCHEMA_VERSION = 1
WORKSPACE_ENV = "NOVVY_WORKSPACE_DIR"
CONFIG_ENV = "NOVVY_CONFIG_FILE"
DEFAULT_WORKSPACE_NAME = "novvy_ad_workplace"
CONFIG_FILE_NAME = "novvy-plugin-config.json"
PLUGIN_LOCAL_CONFIG_FILE_NAME = "novvy-plugin-local.json"
SOURCE_PLUGIN_ROOT_CONFIG_KEY = "sourcePluginRoot"
CANONICAL_API_KEY_CONFIG_KEY = "adminUserApiKey"
API_KEY_CONFIG_KEYS = (CANONICAL_API_KEY_CONFIG_KEY, "apiKey", "novvyApiKey", "novvyAiPlatformApiKey")
AUTHORIZATION_CONFIG_KEYS = ("authorization", "novvyAuthorization")
MCP_AUTHORIZATION_PLACEHOLDER = "Bearer <generated-by-novvy-env-check>"
API_KEY_PLACEHOLDER_MARKERS = (
    "your-",
    "your_",
    "<",
    ">",
    "${",
    "changeme",
    "change-me",
    "replace",
    "placeholder",
    "apikey",
    "api-key",
    "填入",
    "替换",
)


def workspace_dir() -> Path:
    configured_file = os.environ.get(CONFIG_ENV, "").strip()
    if configured_file:
        return Path(configured_file).expanduser().resolve().parent

    configured_dir = os.environ.get(WORKSPACE_ENV, "").strip()
    if configured_dir:
        return Path(configured_dir).expanduser().resolve()

    return Path.home() / DEFAULT_WORKSPACE_NAME


def config_path(workspace: Path | None = None) -> Path:
    configured_file = os.environ.get(CONFIG_ENV, "").strip()
    if configured_file:
        return Path(configured_file).expanduser().resolve()
    return (workspace or workspace_dir()) / CONFIG_FILE_NAME


def ensure_workspace(workspace: Path | None = None) -> Path:
    directory = workspace or workspace_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = config_path(directory)
    if not path.exists():
        path.write_text("{}\n", encoding="utf-8")
    return directory


def read_config(path: Path | None = None) -> dict[str, Any]:
    cfg_path = path or config_path()
    try:
        text = cfg_path.read_text(encoding="utf-8").strip()
    except OSError:
        return {}
    if not text:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def string_value(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def normalize_api_key(value: object) -> str:
    text = string_value(value)
    if text.lower().startswith("bearer "):
        text = text[7:].strip()
    return text


def api_key_looks_placeholder(value: object) -> bool:
    text = normalize_api_key(value).lower()
    if not text:
        return False
    if text in {"todo", "xxx", "xxxx", "xxxxx"}:
        return True
    return any(marker in text for marker in API_KEY_PLACEHOLDER_MARKERS)


def source_plugin_root(plugin_root: Path, config: dict[str, Any] | None = None) -> Path:
    data = config if config is not None else read_config()
    configured = string_value(data.get(SOURCE_PLUGIN_ROOT_CONFIG_KEY))
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if (candidate / ".codex-plugin" / "plugin.json").is_file():
            return candidate
    return plugin_root.expanduser().resolve()


def plugin_local_config_path(plugin_root: Path, config: dict[str, Any] | None = None) -> Path:
    return source_plugin_root(plugin_root, config) / PLUGIN_LOCAL_CONFIG_FILE_NAME


def read_plugin_local_config(
    plugin_root: Path | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if plugin_root is None:
        return {}
    return read_config(plugin_local_config_path(plugin_root, config))


def plugin_local_api_key(
    config: dict[str, Any] | None = None,
    *,
    plugin_root: Path,
) -> str:
    data = config if config is not None else read_config()
    plugin_config = read_plugin_local_config(plugin_root, data)
    value = plugin_config.get(CANONICAL_API_KEY_CONFIG_KEY)
    token = normalize_api_key(value)
    return token if token and not api_key_looks_placeholder(value) else ""


def plugin_local_api_key_status(
    config: dict[str, Any] | None = None,
    *,
    plugin_root: Path,
) -> dict[str, Any]:
    data = config if config is not None else read_config()
    path = plugin_local_config_path(plugin_root, data)
    plugin_config = read_plugin_local_config(plugin_root, data)
    value = plugin_config.get(CANONICAL_API_KEY_CONFIG_KEY)
    raw = string_value(value)
    if raw:
        token = normalize_api_key(raw)
        looks_placeholder = api_key_looks_placeholder(raw)
        ok = bool(token) and not looks_placeholder
        return {
            "name": CANONICAL_API_KEY_CONFIG_KEY,
            "ok": ok,
            "configured": bool(raw),
            "source": f"{path}:{CANONICAL_API_KEY_CONFIG_KEY}",
            "path": str(path),
            "usesBearerPrefix": raw.lower().startswith("bearer "),
            "looksPlaceholder": looks_placeholder,
            "safeSummary": (
                f"Novvy API key 已在 {path} 配置。"
                if ok
                else f"{path} 中的 Novvy API key 仍为空或为占位值。"
            ),
        }
    return {
        "name": CANONICAL_API_KEY_CONFIG_KEY,
        "ok": False,
        "configured": False,
        "source": "",
        "path": str(path),
        "usesBearerPrefix": False,
        "looksPlaceholder": False,
        "safeSummary": f"请先在 {path} 的 adminUserApiKey 字段填写本机 admin_user.apikey，然后重新运行 env-check。",
    }


def mcp_authorization_status(plugin_root: Path, server_name: str = "novvy_ai_platform") -> dict[str, Any]:
    path = plugin_root / ".mcp.json"
    if not path.exists():
        return {
            "name": "mcpAuthorization",
            "ok": False,
            "path": str(path),
            "authorizationPresent": False,
            "startsBearer": False,
            "looksPlaceholder": False,
            "safeSummary": "插件根目录缺少 .mcp.json。",
        }

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "name": "mcpAuthorization",
            "ok": False,
            "path": str(path),
            "authorizationPresent": False,
            "startsBearer": False,
            "looksPlaceholder": False,
            "safeSummary": f".mcp.json 无法读取或不是有效 JSON：{exc}",
        }

    server = data.get("mcpServers", {}).get(server_name) if isinstance(data.get("mcpServers"), dict) else None
    headers = server.get("http_headers") if isinstance(server, dict) else None
    authorization = headers.get("Authorization") if isinstance(headers, dict) else ""
    authorization = string_value(authorization)
    token = normalize_api_key(authorization)
    looks_placeholder = api_key_looks_placeholder(authorization)
    ok = bool(token) and authorization.lower().startswith("bearer ") and not looks_placeholder
    return {
        "name": "mcpAuthorization",
        "ok": ok,
        "path": str(path),
        "authorizationPresent": bool(authorization),
        "startsBearer": authorization.lower().startswith("bearer "),
        "looksPlaceholder": looks_placeholder,
        "safeSummary": (
            ".mcp.json Authorization 已配置。"
            if ok
            else ".mcp.json Authorization 缺失、格式不对或仍是占位值。"
        ),
    }


def sync_mcp_api_key(plugin_root: Path, config: dict[str, Any] | None = None, server_name: str = "novvy_ai_platform") -> dict[str, Any]:
    status = plugin_local_api_key_status(config, plugin_root=plugin_root)
    token = plugin_local_api_key(config, plugin_root=plugin_root)
    path = plugin_root / ".mcp.json"
    if not token:
        return {
            "name": "syncMcpAuthorization",
            "ok": False,
            "changed": False,
            "path": str(path),
            "source": status.get("source") or "",
            "safeSummary": (
                status["safeSummary"]
                if status["configured"]
                else f"未从 {status['path']} 同步 API key；现有 .mcp.json Authorization 不作为本地 key 配置依据。"
            ),
        }

    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "name": "syncMcpAuthorization",
            "ok": False,
            "changed": False,
            "path": str(path),
            "source": status.get("source") or "",
            "safeSummary": f"无法同步 API key 到 .mcp.json：{exc}",
        }

    servers = data.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        return {
            "name": "syncMcpAuthorization",
            "ok": False,
            "changed": False,
            "path": str(path),
            "source": status.get("source") or "",
            "safeSummary": ".mcp.json 的 mcpServers 不是对象，无法同步 API key。",
        }

    server = servers.setdefault(server_name, {})
    if not isinstance(server, dict):
        return {
            "name": "syncMcpAuthorization",
            "ok": False,
            "changed": False,
            "path": str(path),
            "source": status.get("source") or "",
            "safeSummary": f".mcp.json 的 mcpServers.{server_name} 不是对象，无法同步 API key。",
        }
    server.setdefault("url", "https://developer.novvy.ai/mcp")
    headers = server.setdefault("http_headers", {})
    if not isinstance(headers, dict):
        headers = {}
        server["http_headers"] = headers

    authorization = f"Bearer {token}"
    changed = headers.get("Authorization") != authorization
    headers["Authorization"] = authorization
    try:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        path.chmod(0o600)
    except OSError as exc:
        return {
            "name": "syncMcpAuthorization",
            "ok": False,
            "changed": False,
            "path": str(path),
            "source": status.get("source") or "",
            "safeSummary": f"无法写入 .mcp.json：{exc}",
        }

    return {
        "name": "syncMcpAuthorization",
        "ok": True,
        "changed": changed,
        "path": str(path),
        "source": status.get("source") or "",
        "safeSummary": f"已从 {status['path']} 同步 Novvy API key 到 .mcp.json。",
    }


def write_mcp_authorization_placeholder(plugin_root: Path, server_name: str = "novvy_ai_platform") -> dict[str, Any]:
    path = plugin_root / ".mcp.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "name": "writeMcpAuthorizationPlaceholder",
            "ok": False,
            "changed": False,
            "path": str(path),
            "safeSummary": f"无法重置 .mcp.json Authorization 占位：{exc}",
        }

    servers = data.setdefault("mcpServers", {})
    if not isinstance(servers, dict):
        servers = {}
        data["mcpServers"] = servers
    server = servers.setdefault(server_name, {})
    if not isinstance(server, dict):
        server = {}
        servers[server_name] = server
    server.setdefault("type", "http")
    server.setdefault("url", "https://developer.novvy.ai/mcp")
    headers = server.setdefault("http_headers", {})
    if not isinstance(headers, dict):
        headers = {}
        server["http_headers"] = headers

    changed = headers.get("Authorization") != MCP_AUTHORIZATION_PLACEHOLDER
    headers["Authorization"] = MCP_AUTHORIZATION_PLACEHOLDER
    try:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except OSError as exc:
        return {
            "name": "writeMcpAuthorizationPlaceholder",
            "ok": False,
            "changed": False,
            "path": str(path),
            "safeSummary": f"无法写入 .mcp.json Authorization 占位：{exc}",
        }

    return {
        "name": "writeMcpAuthorizationPlaceholder",
        "ok": True,
        "changed": changed,
        "path": str(path),
        "safeSummary": "源目录 .mcp.json Authorization 已保持为占位值。",
    }


def write_config(data: dict[str, Any], path: Path | None = None) -> Path:
    cfg_path = path or config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return cfg_path


def update_config(updates: dict[str, Any], path: Path | None = None) -> dict[str, Any]:
    cfg_path = path or config_path()
    existing = read_config(cfg_path)
    merged = {**existing, **updates}
    merged["schemaVersion"] = CONFIG_SCHEMA_VERSION
    merged["workspaceDir"] = str(cfg_path.parent)
    write_config(merged, cfg_path)
    return merged


def sanitize_nonsecret_config(path: Path | None = None) -> dict[str, Any]:
    cfg_path = path or config_path()
    data = read_config(cfg_path)
    changed = False
    for key in API_KEY_CONFIG_KEYS + AUTHORIZATION_CONFIG_KEYS:
        if key in data:
            data.pop(key)
            changed = True
    for section_name in ("novvyAiPlatform", "novvy_ai_platform"):
        section = data.get(section_name)
        if not isinstance(section, dict):
            continue
        for key in API_KEY_CONFIG_KEYS + AUTHORIZATION_CONFIG_KEYS:
            if key in section:
                section.pop(key)
                changed = True
        if not section:
            data.pop(section_name)
            changed = True
    if changed:
        write_config(data, cfg_path)
    return {"changed": changed, "config": data}


def executable_path(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    path = Path(value).expanduser()
    return str(path) if path.exists() and os.access(path, os.X_OK) else ""


def configured_python_path(config: dict[str, Any] | None = None) -> str:
    data = config or read_config()
    for value in (
        data.get("pythonPath"),
        data.get("python", {}).get("path") if isinstance(data.get("python"), dict) else None,
    ):
        path = executable_path(value)
        if path:
            return path
    return ""


def configured_binary_path(name: str, config: dict[str, Any] | None = None) -> str:
    data = config or read_config()
    key = f"{name}Path"
    for value in (
        data.get(key),
        data.get(name, {}).get("path") if isinstance(data.get(name), dict) else None,
    ):
        path = executable_path(value)
        if path:
            return path
    return ""


def resolve_binary(name: str, config: dict[str, Any] | None = None) -> str:
    configured = configured_binary_path(name, config)
    if configured:
        return configured
    found = shutil.which(name)
    return found or ""
