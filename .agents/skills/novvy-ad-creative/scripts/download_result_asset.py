#!/usr/bin/env python3
"""Save a Novvy generation result URL locally for Codex UI preview."""

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class PreviewError(RuntimeError):
    pass


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def is_http_url(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))


def plugin_root_from_script() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").exists():
            return parent
    return Path(__file__).resolve().parents[3]


def bearer_from_headers(headers: object) -> str:
    if not isinstance(headers, dict):
        return ""
    value = headers.get("Authorization") or headers.get("authorization")
    if not isinstance(value, str):
        return ""
    value = value.strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return ""


def token_looks_placeholder(value: str) -> bool:
    text = value.strip().lower()
    if not text:
        return False
    if text in {"todo", "xxx", "xxxx", "xxxxx"}:
        return True
    return any(
        marker in text
        for marker in (
            "your-",
            "your_",
            "<",
            ">",
            "${",
            "changeme",
            "change-me",
            "placeholder",
            "apikey",
            "api-key",
            "填入",
            "替换",
        )
    )


def resolve_token_from_local_config() -> str:
    plugin_root = plugin_root_from_script()
    scripts_dir = plugin_root / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from novvy_config import configured_api_key  # noqa: WPS433
    except (ImportError, OSError):
        return ""
    return configured_api_key(plugin_root=plugin_root)


def resolve_token_from_env() -> str:
    authorization = os.environ.get("NOVVY_AUTHORIZATION", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    api_key = os.environ.get("NOVVY_API_KEY", "").strip()
    if api_key:
        return api_key
    return ""


def resolve_token_from_mcp(mcp_json: str, mcp_server: str) -> str:
    path = Path(mcp_json).expanduser().resolve() if mcp_json else plugin_root_from_script() / ".mcp.json"
    if not path.exists():
        return ""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        return ""
    server = servers.get(mcp_server)
    if not isinstance(server, dict):
        return ""
    return bearer_from_headers(server.get("http_headers"))


def resolve_token(args: argparse.Namespace) -> str:
    token = resolve_token_from_env() or resolve_token_from_local_config() or resolve_token_from_mcp(
        args.mcp_json,
        args.mcp_server,
    )
    if token_looks_placeholder(token):
        return ""
    return token


def workspace_dir() -> Path:
    explicit = os.environ.get("NOVVY_WORKSPACE_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()
    return Path.home() / "novvy_ad_workplace"


def ensure_workspace_output(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    root = workspace_dir().expanduser().resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise PreviewError(f"{label} must be inside Novvy workspace: {root}") from exc
    return resolved


def safe_label(value: str) -> str:
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-._")
    return label or "novvy-result"


def extension_from_content_type(content_type: str, url: str) -> str:
    media_type = content_type.split(";", 1)[0].strip().lower()
    if media_type == "image/jpeg":
        return ".jpg"
    if media_type in {"image/png", "image/webp", "image/gif"}:
        return mimetypes.guess_extension(media_type) or ".png"
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return suffix
    return ".png"


def read_body(response, max_bytes: int) -> bytes:
    content = response.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise PreviewError(f"Result image is larger than {max_bytes} bytes")
    return content


def fetch(url: str, token: str = "") -> tuple[bytes, str]:
    headers = {"Accept": "image/*,*/*"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get("Content-Type", "")
        body = read_body(response, 50 * 1024 * 1024)
    if not body:
        raise PreviewError("Result URL returned an empty body")
    return body, content_type


def fetch_with_optional_auth(url: str, token: str) -> tuple[bytes, str, bool]:
    try:
        body, content_type = fetch(url)
        return body, content_type, False
    except urllib.error.HTTPError as exc:
        if exc.code not in {401, 403} or not token:
            raise
    body, content_type = fetch(url, token)
    return body, content_type, True


def save_result(url: str, args: argparse.Namespace) -> dict:
    if not is_http_url(url):
        raise PreviewError("Only http(s) result URLs can be saved as local previews")

    requested_output_dir = Path(args.output_dir) if args.output_dir else workspace_dir() / "result-previews"
    output_dir = ensure_workspace_output(requested_output_dir, "Output directory")
    output_dir.mkdir(parents=True, exist_ok=True)

    token = resolve_token(args)
    body, content_type, used_auth = fetch_with_optional_auth(url, token)

    timestamp = time.strftime("%Y%m%d-%H%M%S")
    extension = extension_from_content_type(content_type, url)
    filename = f"{safe_label(args.label)}-{timestamp}{extension}"
    output_path = output_dir / filename
    output_path.write_bytes(body)

    return {
        "ok": True,
        "localPath": str(output_path),
        "sourceUrl": url,
        "contentType": content_type,
        "bytes": len(body),
        "usedAuthorization": used_auth,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Save a Novvy generation result URL as a local UI preview image.")
    parser.add_argument("url", help="Generated image result URL")
    parser.add_argument("--label", default="novvy-result", help="Safe filename label")
    parser.add_argument("--output-dir", default="", help="Directory for the local preview image")
    parser.add_argument("--mcp-json", default="", help="Optional .mcp.json path")
    parser.add_argument("--mcp-server", default="novvy_ai_platform", help="MCP server key in .mcp.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        print(json_dumps(save_result(args.url, args)))
        return 0
    except (PreviewError, urllib.error.URLError, OSError) as exc:
        print(
            json_dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "safeNextStep": "render_remote_url_or_retry_after_novvy_env_check",
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
