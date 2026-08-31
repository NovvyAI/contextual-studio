#!/usr/bin/env python3
"""Upload Novvy AI Platform assets through HTTP endpoints, without MCP upload."""

import argparse
import hashlib
import json
import mimetypes
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from io import BytesIO
from pathlib import Path
from typing import Callable, NoReturn, TypeVar


T = TypeVar("T")


class UploadError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        failed_step: str = "http_upload",
        safe_next_step: str = "fix_input_or_platform_error_then_retry_reference_group_upload",
        retryable: bool = False,
        status_code: int | None = None,
        retry_after_seconds: float | None = None,
        response_body: object | None = None,
        attempts: int = 1,
        error_class: str = "",
        failed_slot: str = "",
        completed_slots: list[str] | None = None,
        pending_slots: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.failed_step = failed_step
        self.safe_next_step = safe_next_step
        self.retryable = retryable
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        self.attempts = attempts
        self.response_body = response_body
        self.error_class = error_class
        self.failed_slot = failed_slot
        self.completed_slots = completed_slots or []
        self.pending_slots = pending_slots or []


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise UploadError(
            f"Invalid command-line arguments: {message}",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )


REFERENCE_SLOT_ORDER = (
    "male_front",
    "male_side",
    "female_front",
    "female_side",
    "final_card",
)
LEGACY_POSITIONAL_SLOT_ORDER = (
    "male_front",
    "male_side",
    "female_front",
    "female_side",
    "product_icon",
    "final_card",
)
SLOT_DEFAULTS = {
    "male_front": {"character": "男主人公", "view": "front"},
    "male_side": {"character": "男主人公", "view": "side"},
    "female_front": {"character": "女主人公", "view": "front"},
    "female_side": {"character": "女主人公", "view": "side"},
    "product_icon": {"character": "产品 icon", "view": "icon"},
    "final_card": {"character": "审核通过的落版图", "view": "final_card"},
}
NON_UPLOAD_SLOTS = frozenset(("product_icon",))
SEEDANCE_HUMAN_NON_HUMAN_SLOTS = frozenset(("final_card",))
REFERENCE_REVIEW_SCHEMA_VERSION = "novvy.reference-review.v1"
IMAGE_EXTENSIONS = frozenset((".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"))
VIDEO_EXTENSIONS = frozenset((".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"))
DEFAULT_MIN_IMAGE_WIDTH = 300
DEFAULT_MAX_IMAGE_WIDTH = 6000
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_RETRY_BASE_SECONDS = 1.0
DEFAULT_RETRY_MAX_SECONDS = 8.0
RETRYABLE_HTTP_STATUS_CODES = frozenset((408, 425, 429, 500, 502, 503, 504))
RETRYABLE_MESSAGE_MARKERS = (
    "connection aborted",
    "connection reset",
    "gateway timeout",
    "internal server error",
    "network error",
    "rate limit",
    "request timeout",
    "service unavailable",
    "temporarily unavailable",
    "timed out",
    "too many requests",
    "try again",
)

ERROR_CLASS_BY_FAILED_STEP = {
    "cli_arguments": "prompt_or_parameter",
    "local_environment": "source_invalid",
    "local_io": "source_invalid",
    "source_download": "source_invalid",
    "image_validation": "source_invalid",
    "human_visual_validation": "human_review_required",
    "http_upload": "unknown",
    "http_upload_parse": "response_contract",
}


def is_http_url(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def read_response_body(response) -> object:
    text = response.read().decode("utf-8", errors="replace")
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text}


def api_error_message(data: object, fallback: str) -> str:
    if isinstance(data, dict):
        error = data.get("error")
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            return error["message"]
        if isinstance(data.get("message"), str):
            return data["message"]
    return fallback


def is_auth_failure_message(message: str, status_code: int | None = None) -> bool:
    text = message.lower()
    return status_code in {401, 403} or "invalid token" in text or "unauthorized" in text or "forbidden" in text


def auth_failure_message(message: str) -> str:
    detail = message.strip() or "Invalid token"
    return (
        f"Novvy API 认证失败：平台返回 {detail}。"
        "请检查项目本地 Novvy 配置、.mcp.json 或 NOVVY_API_KEY；不要把 key 发进聊天。"
        "修复后从参考图组上传步骤重试，不要自动重传。"
    )


def walk_json(value: object):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk_json(child)


def nonempty_string(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def find_string_by_keys(data: object, keys: tuple[str, ...], *, prefix: str = "") -> str:
    wanted = {key.lower() for key in keys}
    for node in walk_json(data):
        if not isinstance(node, dict):
            continue
        for key, value in node.items():
            if key.lower() not in wanted:
                continue
            text = nonempty_string(value)
            if text and (not prefix or text.startswith(prefix)):
                return text
    return ""


def find_string_value(data: object, *, prefix: str) -> str:
    for node in walk_json(data):
        text = nonempty_string(node)
        if text.startswith(prefix):
            return text
    return ""


def find_public_url(data: object) -> str:
    public_url = find_string_by_keys(
        data,
        ("publicUrl", "assetPublicUrl", "storagePublicUrl", "downloadUrl", "url"),
        prefix="https://",
    )
    if public_url:
        return public_url
    return find_string_by_keys(data, ("publicUrl", "assetPublicUrl", "storagePublicUrl", "downloadUrl", "url"), prefix="http://")


def find_seedance_asset_url(data: object) -> str:
    direct = find_string_value(data, prefix="asset://")
    if direct:
        return direct
    asset_url = find_string_by_keys(
        data,
        ("assetUrl", "seedanceHumanAssetUrl", "humanAssetUrl", "referenceUrl", "url", "uri"),
        prefix="asset://",
    )
    if asset_url:
        return asset_url
    return find_string_by_keys(
        data,
        ("assetUrl", "seedanceHumanAssetUrl", "humanAssetUrl", "referenceUrl", "publicUrl", "url", "uri"),
        prefix="https://",
    )


def retry_after_from_headers(headers: object) -> float | None:
    if headers is None or not hasattr(headers, "get"):
        return None
    value = str(headers.get("Retry-After") or "").strip()
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())
        except (TypeError, ValueError, OverflowError):
            return None


def retry_after_from_api(data: object) -> float | None:
    for node in walk_json(data):
        if not isinstance(node, dict):
            continue
        for key in ("retryAfterSeconds", "retry_after_seconds"):
            value = node.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return max(0.0, float(value))
        for key in ("retryAfterMs", "retry_after_ms"):
            value = node.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return max(0.0, float(value) / 1000.0)
    return None


def is_retryable_error(message: str, status_code: int | None = None, data: object | None = None) -> bool:
    if status_code in RETRYABLE_HTTP_STATUS_CODES:
        return True
    if status_code is not None and 500 <= status_code <= 599:
        return True
    if data is not None:
        for node in walk_json(data):
            if isinstance(node, dict) and node.get("retryable") is True:
                return True
    text = message.lower()
    return any(marker in text for marker in RETRYABLE_MESSAGE_MARKERS)


def platform_error_class(message: str, status_code: int | None = None) -> str:
    text = message.lower()
    if is_auth_failure_message(message, status_code):
        return "auth"
    if any(marker in text for marker in ("non-human", "non human", "not human", "not a real person", "material not human", "真人素材不合格")):
        return "material_not_human"
    if any(marker in text for marker in ("humanimageurls", "human image", "human reference", "seedance human", "真人参考图")):
        return "reference_mode_mismatch"
    if any(marker in text for marker in ("inactive", "asset not found", "invalid reference", "reference expired")):
        return "reference_invalid_or_inactive"
    if is_retryable_error(message, status_code):
        return "transient_remote"
    return "unknown"


def retry_delay_seconds(exc: UploadError, failed_attempt: int, args: argparse.Namespace) -> float:
    exponential = args.retry_base_seconds * (2 ** max(0, failed_attempt - 1))
    requested = exc.retry_after_seconds if exc.retry_after_seconds is not None else exponential
    return max(0.0, min(float(requested), args.retry_max_seconds))


def run_with_retry(operation: Callable[[], T], *, label: str, args: argparse.Namespace) -> T:
    for attempt in range(1, args.max_attempts + 1):
        try:
            return operation()
        except UploadError as exc:
            exc.attempts = attempt
            if not exc.retryable or attempt >= args.max_attempts:
                raise
            delay = retry_delay_seconds(exc, attempt, args)
            args.retry_events.append(
                {
                    "operation": label,
                    "failedAttempt": attempt,
                    "statusCode": exc.status_code,
                    "delaySeconds": round(delay, 3),
                    "serverRetryAfterSeconds": exc.retry_after_seconds,
                    "error": str(exc)[:300],
                }
            )
            if delay > 0:
                time.sleep(delay)
    raise AssertionError("retry loop exhausted without returning or raising")


def request_json(
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: object | None = None,
    ambiguous_commit_on_network: bool = False,
) -> dict:
    url = urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    request_data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        request_data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=request_data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            response_data = read_response_body(response)
    except urllib.error.HTTPError as exc:
        response_data = read_response_body(exc)
        message = api_error_message(response_data, f"HTTP {exc.code} calling {path}")
        if is_auth_failure_message(message, exc.code):
            raise UploadError(
                auth_failure_message(message),
                safe_next_step="configure_valid_admin_user_api_key_then_retry_upload",
                status_code=exc.code,
                response_body=response_data,
                error_class="auth",
            ) from exc
        retryable = is_retryable_error(message, exc.code, response_data)
        raise UploadError(
            message,
            safe_next_step=(
                "wait_then_retry_failed_http_operation"
                if retryable
                else "fix_platform_rejected_request_then_retry_failed_upload_step"
            ),
            retryable=retryable,
            status_code=exc.code,
            retry_after_seconds=retry_after_from_headers(exc.headers) or retry_after_from_api(response_data),
            response_body=response_data,
            error_class="transient_remote" if retryable else platform_error_class(message, exc.code),
        ) from exc
    except urllib.error.URLError as exc:
        raise UploadError(
            f"Network error calling {path}: {exc.reason}",
            safe_next_step=(
                "look_up_the_created_object_before_retrying_to_avoid_a_duplicate"
                if ambiguous_commit_on_network
                else "check_network_then_retry_failed_http_operation"
            ),
            retryable=not ambiguous_commit_on_network,
            error_class="ambiguous_commit" if ambiguous_commit_on_network else "transient_remote",
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise UploadError(
            f"Request timed out calling {path}",
            safe_next_step=(
                "look_up_the_created_object_before_retrying_to_avoid_a_duplicate"
                if ambiguous_commit_on_network
                else "check_network_then_retry_failed_http_operation"
            ),
            retryable=not ambiguous_commit_on_network,
            error_class="ambiguous_commit" if ambiguous_commit_on_network else "transient_remote",
        ) from exc

    if not isinstance(response_data, dict):
        raise UploadError(
            f"Expected JSON object from {path}",
            failed_step="http_upload_parse",
            safe_next_step="inspect_api_response_contract_before_retry",
            response_body=response_data,
            error_class="response_contract",
        )
    if response_data.get("ok") is False:
        message = api_error_message(response_data, f"API returned ok=false from {path}")
        if is_auth_failure_message(message):
            raise UploadError(
                auth_failure_message(message),
                safe_next_step="configure_valid_admin_user_api_key_then_retry_upload",
                response_body=response_data,
                error_class="auth",
            )
        retryable = is_retryable_error(message, data=response_data)
        raise UploadError(
            message,
            safe_next_step=(
                "wait_then_retry_failed_http_operation"
                if retryable
                else "fix_platform_rejected_request_then_retry_failed_upload_step"
            ),
            retryable=retryable,
            retry_after_seconds=retry_after_from_api(response_data),
            response_body=response_data,
            error_class="transient_remote" if retryable else platform_error_class(message),
        )
    return response_data


def plugin_root_from_script() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").exists():
            return parent
    # Vendored project-local skills are not wrapped in a plugin bundle.
    return Path(__file__).resolve().parents[1]


def find_mcp_json(explicit_path: str) -> Path:
    if explicit_path:
        path = Path(explicit_path).expanduser().resolve()
    else:
        path = plugin_root_from_script() / ".mcp.json"

    if not path.exists() or not path.is_file():
        raise UploadError(
            f"Missing .mcp.json: {path}",
            failed_step="local_environment",
            safe_next_step="restore_plugin_mcp_configuration_then_retry_upload",
        )
    return path


def mcp_config(args: argparse.Namespace) -> dict:
    path = find_mcp_json(args.mcp_json)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UploadError(
            f"Failed to read {path}: {exc}",
            failed_step="local_environment",
            safe_next_step="fix_plugin_mcp_configuration_then_retry_upload",
        ) from exc

    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        raise UploadError(
            f"{path} must contain mcpServers",
            failed_step="local_environment",
            safe_next_step="fix_plugin_mcp_configuration_then_retry_upload",
        )

    server = servers.get(args.mcp_server)
    if not isinstance(server, dict):
        raise UploadError(
            f"{path} must contain mcpServers.{args.mcp_server}",
            failed_step="local_environment",
            safe_next_step="fix_plugin_mcp_configuration_then_retry_upload",
        )
    return server


def resolve_token_from_local_config() -> tuple[str, dict]:
    plugin_root = plugin_root_from_script()
    scripts_dir = plugin_root / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from novvy_config import plugin_local_api_key, plugin_local_api_key_status
    except (ImportError, OSError) as exc:
        return "", {
            "configured": False,
            "ok": False,
            "safeSummary": f"无法读取 Novvy 本地参数文件 helper：{exc}",
        }

    status = plugin_local_api_key_status(plugin_root=plugin_root)
    return plugin_local_api_key(plugin_root=plugin_root), status


def base_url_from_mcp_server(server: dict) -> str:
    url = str(server.get("url") or "").strip()
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    path = parsed.path.rstrip("/")
    if path.endswith("/mcp"):
        path = path[:-4]
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path.rstrip("/"), "", "", ""))


def resolve_token(_server: dict) -> str:
    token, status = resolve_token_from_local_config()
    if not token:
        headers = _server.get("http_headers") or _server.get("headers") or {}
        authorization = headers.get("Authorization", "") if isinstance(headers, dict) else ""
        token = authorization.strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
    if not token:
        token = os.environ.get("NOVVY_API_KEY", "").strip()
    if not token:
        authorization = os.environ.get("NOVVY_MCP_AUTHORIZATION", "").strip()
        token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization
    if token:
        return token
    raise UploadError(
        f"{status.get('safeSummary')} 修复后从参考图组上传步骤重试，不要自动重传。",
        failed_step="local_environment",
        safe_next_step="fill_plugin_local_config_then_rerun_env_check",
    )


def resolve_base_url_from_mcp(server: dict) -> str:
    base_url = base_url_from_mcp_server(server)
    if not base_url:
        raise UploadError(
            ".mcp.json must set mcpServers.novvy_ai_platform.url, for example https://developer.novvy.ai/mcp",
            failed_step="local_environment",
            safe_next_step="fix_plugin_mcp_server_url_then_retry_upload",
        )
    return base_url


def extension_name_from_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    name = Path(urllib.parse.unquote(parsed.path)).name
    return name or parsed.hostname or "asset"


def source_name(source: str) -> str:
    if is_http_url(source):
        return extension_name_from_url(source)
    return Path(source).expanduser().name or "asset"


def parse_slot_source(value: str) -> dict:
    if "=" not in value:
        raise UploadError(
            "Slot input must use SLOT=SOURCE, for example --slot male_front=/path/to/image.png",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )
    slot, source = value.split("=", 1)
    slot = slot.strip()
    source = source.strip()
    if not slot:
        raise UploadError(
            "Slot name is required before '=' in --slot SLOT=SOURCE",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )
    if not source:
        raise UploadError(
            f"Source is required for slot {slot}",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )
    return {"slot": slot, "source": source}


def sort_named_items(items: list[dict]) -> list[dict]:
    order = {slot: index for index, slot in enumerate(REFERENCE_SLOT_ORDER)}
    return [
        item
        for _sort_key, item in sorted(
            ((order.get(item["slot"], len(order) + index), item) for index, item in enumerate(items)),
            key=lambda pair: pair[0],
        )
    ]


def upload_items(args: argparse.Namespace) -> tuple[list[dict], list[str]]:
    warnings: list[str] = []
    if args.slot:
        if args.sources:
            raise UploadError(
                "Use either --slot SLOT=SOURCE inputs or positional sources, not both.",
                failed_step="cli_arguments",
                safe_next_step="fix_upload_cli_arguments",
            )
        items = [parse_slot_source(value) for value in args.slot]
        seen = set()
        for item in items:
            slot = item["slot"]
            if slot in seen:
                raise UploadError(
                    f"Duplicate upload slot: {slot}",
                    failed_step="cli_arguments",
                    safe_next_step="fix_upload_cli_arguments",
                )
            seen.add(slot)
        return sort_named_items(items), warnings

    if not args.sources:
        raise UploadError(
            "Pass one or more positional sources, or use --slot SLOT=SOURCE.",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )

    if len(args.sources) <= len(REFERENCE_SLOT_ORDER):
        slots = list(REFERENCE_SLOT_ORDER[: len(args.sources)])
        warnings.append("使用了位置参数，脚本已按默认槽位顺序映射；后续请优先使用 --slot SLOT=SOURCE。")
    elif len(args.sources) == len(LEGACY_POSITIONAL_SLOT_ORDER):
        slots = list(LEGACY_POSITIONAL_SLOT_ORDER)
        warnings.append("使用了旧版位置参数槽位顺序，其中 product_icon 会被跳过；后续请优先使用 --slot SLOT=SOURCE。")
    else:
        slots = [f"asset_{index:02d}" for index in range(1, len(args.sources) + 1)]
        warnings.append("使用了位置参数且数量超过默认参考图槽位，脚本已按 asset_01... 自动命名。")
    return [{"slot": slot, "source": source} for slot, source in zip(slots, args.sources)], warnings


def load_review_plan(path_value: str, mode: str, items: list[dict]) -> tuple[list[dict], set[str]]:
    if not path_value:
        if mode == "seedance-human":
            raise UploadError(
                "Seedance human mode requires --review-plan-json from reference_workflow.py plan-upload.",
                failed_step="human_visual_validation",
                safe_next_step="run_reference_image_audit_and_reference_workflow_plan_upload_before_retry",
                error_class="human_review_required",
            )
        return items, set()
    path = Path(path_value).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UploadError(
            f"Could not read reviewed upload plan: {exc}",
            failed_step="human_visual_validation",
            safe_next_step="rebuild_the_reviewed_upload_plan_before_retry",
            error_class="human_review_required",
        ) from exc
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise UploadError(
            "Reviewed upload plan is not a successful plan-upload result.",
            failed_step="human_visual_validation",
            safe_next_step="rebuild_the_reviewed_upload_plan_before_retry",
            error_class="human_review_required",
        )
    if data.get("schemaVersion") != REFERENCE_REVIEW_SCHEMA_VERSION or data.get("uploadMode") not in {mode, "mixed"}:
        raise UploadError(
            "Reviewed upload plan schema or upload mode does not match this command.",
            failed_step="human_visual_validation",
            safe_next_step="use_the_matching_reviewed_upload_plan",
            error_class="reference_mode_mismatch",
        )
    selected_plan: dict = data
    if data.get("uploadMode") == "mixed":
        groups = data.get("uploadGroups")
        selected_group = groups.get(mode) if isinstance(groups, dict) else None
        if not isinstance(selected_group, dict) or selected_group.get("uploadMode") != mode:
            raise UploadError(
                f"Mixed reviewed upload plan has no {mode} group.",
                failed_step="human_visual_validation",
                safe_next_step="rebuild_the_mixed_reviewed_upload_plan",
                error_class="reference_mode_mismatch",
            )
        selected_plan = selected_group
    accepted = selected_plan.get("acceptedSlots")
    if not isinstance(accepted, list) or not accepted:
        raise UploadError(
            "Reviewed upload plan has no accepted slots.",
            failed_step="human_visual_validation",
            safe_next_step="repeat_pixel_review_and_accept_only_valid_reference_slots",
            error_class="human_review_required",
        )
    reviewed_items = []
    for index, raw in enumerate(accepted):
        if not isinstance(raw, dict):
            raise UploadError(
                f"Reviewed upload slot {index} is invalid.",
                failed_step="human_visual_validation",
                safe_next_step="rebuild_the_reviewed_upload_plan_before_retry",
                error_class="human_review_required",
            )
        reviewed_items.append(
            {
                "slot": str(raw.get("slot") or "").strip(),
                "source": str(raw.get("source") or "").strip(),
                "sourceFingerprint": str(raw.get("sourceFingerprint") or "").strip(),
                "visualClass": str(raw.get("visualClass") or "").strip(),
            }
        )
    actual_pairs = [(item["slot"], item["source"]) for item in items]
    reviewed_pairs = [(item["slot"], item["source"]) for item in reviewed_items]
    if actual_pairs != reviewed_pairs:
        raise UploadError(
            "Upload command slots or sources differ from the reviewed upload plan.",
            failed_step="human_visual_validation",
            safe_next_step="upload_exactly_the_reviewed_slot_sources_in_the_reviewed_order",
            error_class="source_invalid",
        )
    confirmed = set(selected_plan.get("confirmedHumanSlots") or [])
    reviewed_names = {item["slot"] for item in reviewed_items}
    if mode == "seedance-human" and confirmed != reviewed_names:
        raise UploadError(
            "Reviewed human slot set is incomplete or inconsistent.",
            failed_step="human_visual_validation",
            safe_next_step="rebuild_the_human_review_plan_before_retry",
            error_class="human_review_required",
        )
    if mode == "asset" and any(item["visualClass"] == "human_photorealistic" for item in reviewed_items):
        raise UploadError(
            "Asset mode cannot upload reviewed photorealistic human references.",
            failed_step="human_visual_validation",
            safe_next_step="use_seedance_human_upload_for_only_the_reviewed_human_slots",
            error_class="reference_mode_mismatch",
        )
    return reviewed_items, confirmed


def validate_reviewed_source_bytes(items: list[dict], source_infos: list[dict]) -> None:
    for item, source_info in zip(items, source_infos):
        expected = str(item.get("sourceFingerprint") or "").strip()
        if not expected:
            continue
        actual = "sha256:" + hashlib.sha256(source_info["data"]).hexdigest()
        if actual != expected:
            raise UploadError(
                f"Reference bytes changed after pixel review for slot {item['slot']}.",
                failed_step="human_visual_validation",
                safe_next_step="repeat_pixel_review_on_the_exact_bytes_before_upload",
                error_class="source_invalid",
                failed_slot=item["slot"],
            )


def filter_non_upload_items(items: list[dict], warnings: list[str]) -> tuple[list[dict], list[dict]]:
    uploadable = []
    skipped = []
    for item in items:
        slot = item["slot"]
        if slot in NON_UPLOAD_SLOTS:
            skipped.append({"slot": slot, "source": item["source"], "reason": "removed_reference_slot"})
            continue
        uploadable.append(item)

    if skipped:
        skipped_names = ", ".join(item["slot"] for item in skipped)
        warnings.append(
            f"已删除参考图组槽位：{skipped_names}。这些图片不会上传平台，不会进入 imageUrls/humanImageUrls，"
            "也不会传给后续生成模型。"
        )

    if not uploadable:
        raise UploadError(
            "No uploadable reference slots remain. product_icon is no longer an upload slot.",
            failed_step="cli_arguments",
            safe_next_step="remove_product_icon_or_provide_character_or_final_card_slots",
        )

    return uploadable, skipped


def filter_seedance_human_items(items: list[dict], confirmed_human_slots: set[str], warnings: list[str]) -> tuple[list[dict], list[dict]]:
    if not confirmed_human_slots:
        raise UploadError(
            "Seedance human mode requires every photorealistic human image to be explicitly confirmed after visual review. "
            "Pass --confirmed-human-slot SLOT for each accepted slot; slot names alone are not proof that an image looks human.",
            failed_step="human_visual_validation",
            safe_next_step="model_review_each_image_and_confirm_only_photorealistic_human_slots_then_retry_upload",
            error_class="human_review_required",
        )

    item_slots = {item["slot"] for item in items}
    unknown_confirmations = confirmed_human_slots - item_slots
    if unknown_confirmations:
        raise UploadError(
            "Confirmed human slots were not provided as upload inputs: " + ", ".join(sorted(unknown_confirmations)),
            failed_step="cli_arguments",
            safe_next_step="fix_confirmed_human_slot_arguments",
        )

    uploadable = []
    skipped = []
    for item in items:
        slot = item["slot"]
        if slot in SEEDANCE_HUMAN_NON_HUMAN_SLOTS:
            skipped.append({"slot": slot, "source": item["source"], "reason": "non_human_reference_slot"})
            continue
        if slot in confirmed_human_slots:
            uploadable.append(item)
            continue

        skipped.append({"slot": slot, "source": item["source"], "reason": "not_confirmed_by_visual_human_review"})

    if skipped:
        skipped_names = ", ".join(item["slot"] for item in skipped)
        warnings.append(
            "Seedance 真人上传已跳过非真人或未通过逐图视觉审核并显式确认的槽位："
            f"{skipped_names}。这些图片不会进入 humanImageUrls。"
        )

    if not uploadable:
        raise UploadError(
            "Seedance human mode did not receive any human reference slots to upload. "
            "Review the actual pixels and pass --confirmed-human-slot SLOT only for images that look like live-action humans.",
            failed_step="human_visual_validation",
            safe_next_step="replace_or_confirm_photorealistic_human_reference_slots_then_retry_upload",
            error_class="human_review_required",
        )

    return uploadable, skipped


def reference_summary(reference_url: str) -> str:
    return reference_url


def skipped_slot_summary(item: dict) -> dict:
    slot = item["slot"]
    defaults = SLOT_DEFAULTS.get(slot, {})
    return {
        "slot": slot,
        "sourceName": source_name(item["source"]),
        "character": defaults.get("character", ""),
        "view": defaults.get("view", ""),
        "reason": item.get("reason", "non_human_reference_slot"),
    }


def slot_summary(item: dict, asset: dict) -> dict:
    slot = item["slot"]
    defaults = SLOT_DEFAULTS.get(slot, {})
    return {
        "slot": slot,
        "sourceName": asset.get("fileName") or source_name(item["source"]),
        "uploadedRefSummary": reference_summary(asset.get("referenceUrl") or ""),
        "character": defaults.get("character", ""),
        "view": defaults.get("view", ""),
        "visibleFeatures": "",
        "confidence": "unknown",
        "risks": [],
        "sourceFingerprint": item.get("sourceFingerprint", ""),
        "visualClass": item.get("visualClass", ""),
    }


def compact_success_response(
    args: argparse.Namespace,
    items: list[dict],
    assets: list[dict],
    warnings: list[str],
    skipped_items: list[dict] | None = None,
) -> dict:
    reference_field = "humanImageUrls" if args.mode == "seedance-human" else "imageUrls"
    reference_urls = [asset["referenceUrl"] for asset in assets if asset.get("referenceUrl")]
    if len(reference_urls) != len(items):
        raise UploadError(
            "Upload completed but not every slot produced a safe referenceUrl. "
            "Do not retry automatically; inspect platform asset records first.",
            failed_step="http_upload_parse",
            safe_next_step="recover_created_asset_reference_before_retry",
            error_class="response_contract",
        )

    ordered_snapshot_slots = [
        {
            "slot": item["slot"],
            "sourceFingerprint": item.get("sourceFingerprint", ""),
            "visualClass": item.get("visualClass", ""),
            "reference": reference_url,
        }
        for item, reference_url in zip(items, reference_urls)
    ]
    snapshot_canonical = {
        "referenceField": reference_field,
        "orderedSlots": ordered_snapshot_slots,
    }
    snapshot_id = "ref-" + hashlib.sha256(
        json.dumps(snapshot_canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:20]

    result = {
        "ok": True,
        "uploadMode": args.mode,
        "referenceField": reference_field,
        "referenceUrls": reference_urls,
        "videoPayloadHint": {reference_field: reference_urls},
        "referenceSnapshotId": snapshot_id,
        "referenceSnapshot": {
            "snapshotId": snapshot_id,
            "referenceField": reference_field,
            "slotOrder": [item["slot"] for item in items],
            "referenceUrls": reference_urls,
        },
        "slots": [slot_summary(item, asset) for item, asset in zip(items, assets)],
        "skippedSlots": [skipped_slot_summary(item) for item in (skipped_items or [])],
        "fileNames": [asset.get("fileName") or source_name(item["source"]) for item, asset in zip(items, assets)],
        "warnings": warnings,
        "retrySummary": {
            "maxAttemptsPerOperation": args.max_attempts,
            "retryCount": len(args.retry_events),
            "events": args.retry_events,
        },
    }
    if args.mode == "seedance-human":
        result["confirmedHumanSlots"] = [item["slot"] for item in items]
    if args.include_assets:
        result["assets"] = assets
    return result


def compact_error_response(
    exc: UploadError,
    warnings: list[str] | None = None,
    retry_events: list[dict] | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
) -> dict:
    result = {
        "ok": False,
        "error": str(exc),
        "errorClass": exc.error_class or ERROR_CLASS_BY_FAILED_STEP.get(exc.failed_step, "unknown"),
        "failedStep": exc.failed_step,
        "failedSlot": exc.failed_slot,
        "safeNextStep": exc.safe_next_step,
        "retryable": exc.retryable,
        "attempts": exc.attempts,
        "retrySummary": {
            "maxAttemptsPerOperation": max_attempts,
            "retryCount": len(retry_events or []),
            "events": retry_events or [],
        },
        "warnings": warnings or [],
        "completedSlots": exc.completed_slots,
        "pendingSlots": exc.pending_slots,
    }
    if exc.status_code is not None:
        result["statusCode"] = exc.status_code
    return result


def infer_kind(mime_type: str, file_name: str) -> str:
    if mime_type.startswith("image/"):
        return "image"
    if mime_type.startswith("video/"):
        return "video"

    extension = Path(file_name).suffix.lower()
    if extension in IMAGE_EXTENSIONS:
        return "image"
    if extension in VIDEO_EXTENSIONS:
        return "video"
    raise UploadError(f"Cannot infer upload kind for {file_name}; pass --kind image or --kind video.")


def source_info_is_image(source_info: dict, kind_value: str = "") -> bool:
    kind = (kind_value or "").strip()
    if kind == "image":
        return True
    if kind == "video":
        return False
    mime_type = str(source_info.get("mimeType") or "").lower()
    if mime_type.startswith("image/"):
        return True
    return Path(str(source_info.get("fileName") or "")).suffix.lower() in IMAGE_EXTENSIONS


def image_dimensions(data: bytes, source: str) -> tuple[int, int]:
    try:
        from PIL import Image, UnidentifiedImageError
    except ModuleNotFoundError:
        # Contextual Studio must remain able to upload ordinary PNG/JPEG
        # references before the optional project Python environment is ready.
        # Validate dimensions directly from the standard file headers instead
        # of blocking the complete image-generation workflow on Pillow.
        if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24:
            return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
        if data.startswith(b"\xff\xd8"):
            offset = 2
            while offset + 9 < len(data):
                if data[offset] != 0xFF:
                    offset += 1
                    continue
                marker = data[offset + 1]
                offset += 2
                if marker in {0xD8, 0xD9}:
                    continue
                if offset + 2 > len(data):
                    break
                length = int.from_bytes(data[offset:offset + 2], "big")
                if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF} and offset + 7 <= len(data):
                    return int.from_bytes(data[offset + 5:offset + 7], "big"), int.from_bytes(data[offset + 3:offset + 5], "big")
                offset += max(length, 2)
        raise UploadError(
            "Pillow is unavailable and this image format cannot be validated without it. "
            "Use PNG/JPEG or run the environment installer, then retry.",
            failed_step="local_environment",
            safe_next_step="convert_image_to_png_or_jpeg_or_install_pillow_then_retry_upload",
        )

    try:
        with Image.open(BytesIO(data)) as image:
            return image.width, image.height
    except (OSError, UnidentifiedImageError) as exc:
        raise UploadError(
            f"Cannot read image dimensions for {source_name(source)}. Provide a valid PNG/JPEG/WebP image and retry.",
            failed_step="image_validation",
            safe_next_step="provide_valid_image_file_then_retry_upload",
        ) from exc


def validate_image_width(item: dict, source_info: dict, args: argparse.Namespace) -> None:
    if not source_info_is_image(source_info, "image" if args.mode == "seedance-human" else args.kind):
        return

    width, height = image_dimensions(source_info["data"], source_info["source"])
    source_info["width"] = width
    source_info["height"] = height
    if args.min_image_width <= width <= args.max_image_width:
        return

    raise UploadError(
        f"Image width validation failed for slot {item['slot']} ({source_info['fileName']}): "
        f"width={width}px, height={height}px. Required width is "
        f"{args.min_image_width}-{args.max_image_width}px before Novvy/Doubao upload.",
        failed_step="image_validation",
        safe_next_step="resize_or_pad_image_to_supported_width_then_retry_upload",
    )


def validate_image_width_args(args: argparse.Namespace) -> None:
    if args.min_image_width < 1 or args.max_image_width < args.min_image_width:
        raise UploadError(
            "--min-image-width must be >= 1 and --max-image-width must be >= --min-image-width.",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )


def read_and_validate_sources(items: list[dict], args: argparse.Namespace) -> list[dict]:
    source_infos = []
    for item in items:
        source_info = read_source(item["source"], args.max_bytes, args=args, slot=item["slot"])
        validate_image_width(item, source_info, args)
        source_infos.append(source_info)
    return source_infos


def read_source(source: str, max_bytes: int, *, args: argparse.Namespace, slot: str) -> dict:
    if is_http_url(source):
        def read_remote_once() -> dict:
            request = urllib.request.Request(source, headers={"User-Agent": "Codex Novvy asset uploader"})
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    content_length = response.headers.get("content-length")
                    if content_length:
                        try:
                            remote_size = int(content_length)
                        except ValueError:
                            remote_size = 0
                        if remote_size > max_bytes:
                            raise UploadError(
                                f"Remote source exceeds max bytes for slot {slot}: {source_name(source)}",
                                failed_step="image_validation",
                                safe_next_step="replace_or_compress_oversized_source_then_retry_upload",
                            )
                    data = response.read(max_bytes + 1)
                    mime_type = response.headers.get_content_type() or "application/octet-stream"
            except urllib.error.HTTPError as exc:
                message = f"Failed to read remote source for slot {slot}: HTTP {exc.code}"
                retryable = is_retryable_error(message, exc.code)
                raise UploadError(
                    message,
                    failed_step="source_download",
                    safe_next_step=(
                        "wait_then_retry_remote_source_download"
                        if retryable
                        else "fix_or_replace_remote_source_url_then_retry_upload"
                    ),
                    retryable=retryable,
                    status_code=exc.code,
                    retry_after_seconds=retry_after_from_headers(exc.headers),
                ) from exc
            except urllib.error.URLError as exc:
                raise UploadError(
                    f"Failed to read remote source for slot {slot}: {exc.reason}",
                    failed_step="source_download",
                    safe_next_step="check_network_then_retry_remote_source_download",
                    retryable=True,
                ) from exc
            except (TimeoutError, socket.timeout) as exc:
                raise UploadError(
                    f"Remote source download timed out for slot {slot}",
                    failed_step="source_download",
                    safe_next_step="check_network_then_retry_remote_source_download",
                    retryable=True,
                ) from exc
            if len(data) > max_bytes:
                raise UploadError(
                    f"Remote source exceeds max bytes for slot {slot}: {source_name(source)}",
                    failed_step="image_validation",
                    safe_next_step="replace_or_compress_oversized_source_then_retry_upload",
                )
            return {
                "source": source,
                "data": data,
                "fileName": extension_name_from_url(source),
                "mimeType": mime_type,
                "isRemote": True,
            }

        return run_with_retry(read_remote_once, label=f"source_download:{slot}", args=args)

    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise UploadError(
            f"File not found: {path}",
            failed_step="local_io",
            safe_next_step="fix_or_replace_missing_local_source_then_retry_upload",
        )
    if not path.is_file():
        raise UploadError(
            f"Not a file: {path}",
            failed_step="local_io",
            safe_next_step="provide_local_file_source_then_retry_upload",
        )
    if path.stat().st_size > max_bytes:
        raise UploadError(
            f"Local source exceeds max bytes: {path}",
            failed_step="image_validation",
            safe_next_step="replace_or_compress_oversized_source_then_retry_upload",
        )
    mime_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return {
        "source": str(path),
        "data": path.read_bytes(),
        "fileName": path.name,
        "mimeType": mime_type,
        "isRemote": False,
    }


def put_signed_upload(upload_url: str, data: bytes, mime_type: str) -> None:
    request = urllib.request.Request(
        upload_url,
        data=data,
        headers={"Content-Type": mime_type, "Content-Length": str(len(data))},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            if response.status < 200 or response.status >= 300:
                status_code = int(response.status)
                raise UploadError(
                    f"GCS upload failed: HTTP {status_code}",
                    safe_next_step="request_new_signed_url_then_retry_failed_gcs_upload",
                    retryable=status_code in {401, 403} or is_retryable_error("", status_code),
                    status_code=status_code,
                    retry_after_seconds=retry_after_from_headers(response.headers),
                )
    except urllib.error.HTTPError as exc:
        response_data = read_response_body(exc)
        raise UploadError(
            f"GCS upload failed: HTTP {exc.code}",
            safe_next_step="request_new_signed_url_then_retry_failed_gcs_upload",
            retryable=exc.code in {401, 403} or is_retryable_error("", exc.code),
            status_code=exc.code,
            retry_after_seconds=retry_after_from_headers(exc.headers),
            response_body=response_data,
        ) from exc
    except urllib.error.URLError as exc:
        raise UploadError(
            f"GCS upload failed: {exc.reason}",
            safe_next_step="check_network_then_request_new_signed_url_and_retry_failed_gcs_upload",
            retryable=True,
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise UploadError(
            "GCS upload timed out",
            safe_next_step="check_network_then_request_new_signed_url_and_retry_failed_gcs_upload",
            retryable=True,
        ) from exc


def upload_to_signed_endpoint(
    base_url: str,
    token: str,
    source_info: dict,
    *,
    endpoint: str,
    kind: str,
    args: argparse.Namespace,
    generation_type: str | None = None,
    model: str | None = None,
) -> dict:
    body = {
        "kind": kind,
        "fileName": source_info["fileName"],
        "fileSize": len(source_info["data"]),
        "mimeType": source_info["mimeType"],
    }
    if generation_type:
        body["generationType"] = generation_type
    if model:
        body["model"] = model

    def upload_once() -> dict:
        signed = request_json(
            base_url,
            endpoint,
            token=token,
            method="POST",
            body=body,
            ambiguous_commit_on_network=True,
        )
        upload_url = find_string_by_keys(signed, ("uploadUrl", "signedUploadUrl", "signedUrl"), prefix="http")
        public_url = find_public_url(signed)
        if not upload_url or not public_url:
            raise UploadError(
                f"Signed upload response from {endpoint} did not include uploadUrl/publicUrl",
                failed_step="http_upload_parse",
                safe_next_step="inspect_signed_upload_response_contract_before_retry",
                response_body=signed,
            )

        put_signed_upload(upload_url, source_info["data"], source_info["mimeType"])
        return {
            "source": source_info["source"],
            "fileName": source_info["fileName"],
            "mimeType": source_info["mimeType"],
            "fileSize": len(source_info["data"]),
            "kind": kind,
            "publicUrl": public_url,
            "assetPublicUrl": public_url,
            "referenceUrl": public_url,
            "referenceField": "imageUrls",
        }

    return run_with_retry(upload_once, label=f"asset_upload:{source_info['fileName']}", args=args)


def upload_regular_asset(base_url: str, token: str, source_info: dict, kind_value: str, args: argparse.Namespace) -> dict:
    kind = kind_value or infer_kind(source_info["mimeType"], source_info["fileName"])
    return upload_to_signed_endpoint(
        base_url,
        token,
        source_info,
        endpoint="/api/assets/upload-url",
        kind=kind,
        args=args,
    )


def seedance_human_model() -> str:
    return "seedance-2.0-fast"


def post_seedance_human_binary(base_url: str, token: str, source_info: dict, args: argparse.Namespace) -> dict:
    query = {
        "model": seedance_human_model(),
        "fileName": source_info["fileName"],
        "name": args.name or source_info["fileName"] or "human-image",
        "projectName": args.project_name,
        "waitUntilActive": "true" if args.wait_until_active else "false",
    }
    if args.group_id:
        query["groupId"] = args.group_id

    endpoint = urllib.parse.urljoin(base_url.rstrip("/") + "/", "/api/seedance-human-assets/upload")
    url = endpoint + "?" + urllib.parse.urlencode(query)
    request = urllib.request.Request(
        url,
        data=source_info["data"],
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
            "Content-Length": str(len(source_info["data"])),
            "Content-Type": source_info["mimeType"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = read_response_body(response)
    except urllib.error.HTTPError as exc:
        response_data = read_response_body(exc)
        message = api_error_message(response_data, f"HTTP {exc.code} calling /api/seedance-human-assets/upload")
        if is_auth_failure_message(message, exc.code):
            raise UploadError(
                auth_failure_message(message),
                safe_next_step="configure_valid_admin_user_api_key_then_retry_upload",
                status_code=exc.code,
                response_body=response_data,
                error_class="auth",
            ) from exc
        retryable = is_retryable_error(message, exc.code, response_data)
        error_class = platform_error_class(message, exc.code)
        raise UploadError(
            message,
            safe_next_step=(
                "wait_then_retry_seedance_human_upload"
                if retryable
                else (
                    "repeat_pixel_review_exclude_non_human_then_rebuild_the_human_upload_plan"
                    if error_class == "material_not_human"
                    else "fix_platform_rejected_human_asset_then_retry_failed_slot"
                )
            ),
            retryable=retryable,
            status_code=exc.code,
            retry_after_seconds=retry_after_from_headers(exc.headers) or retry_after_from_api(response_data),
            response_body=response_data,
            error_class=error_class,
        ) from exc
    except urllib.error.URLError as exc:
        raise UploadError(
            f"Network error calling /api/seedance-human-assets/upload: {exc.reason}",
            safe_next_step="look_up_the_seedance_asset_before_retrying_to_avoid_a_duplicate",
            retryable=False,
            error_class="ambiguous_commit",
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise UploadError(
            "Request timed out calling /api/seedance-human-assets/upload",
            safe_next_step="look_up_the_seedance_asset_before_retrying_to_avoid_a_duplicate",
            retryable=False,
            error_class="ambiguous_commit",
        ) from exc

    if not isinstance(data, dict):
        raise UploadError(
            "Expected JSON object from /api/seedance-human-assets/upload",
            failed_step="http_upload_parse",
            safe_next_step="inspect_seedance_upload_response_contract_before_retry",
            response_body=data,
            error_class="response_contract",
        )
    if data.get("ok") is False:
        message = api_error_message(data, "API returned ok=false from /api/seedance-human-assets/upload")
        if is_auth_failure_message(message):
            raise UploadError(
                auth_failure_message(message),
                safe_next_step="configure_valid_admin_user_api_key_then_retry_upload",
                response_body=data,
                error_class="auth",
            )
        retryable = is_retryable_error(message, data=data)
        error_class = "transient_remote" if retryable else platform_error_class(message)
        raise UploadError(
            message,
            safe_next_step=(
                "wait_then_retry_seedance_human_upload"
                if retryable
                else (
                    "repeat_pixel_review_exclude_non_human_then_rebuild_the_human_upload_plan"
                    if error_class == "material_not_human"
                    else "fix_platform_rejected_human_asset_then_retry_failed_slot"
                )
            ),
            retryable=retryable,
            retry_after_seconds=retry_after_from_api(data),
            response_body=data,
            error_class=error_class,
        )
    return data


def upload_seedance_human_asset(base_url: str, token: str, source_info: dict, args: argparse.Namespace) -> dict:
    def upload_once() -> dict:
        if source_info["isRemote"] and not args.mirror_urls and not args.review_plan_json:
            parsed = urllib.parse.urlparse(source_info["source"])
            if parsed.scheme != "https":
                raise UploadError(
                    "Seedance human image source URLs must be https unless --mirror-urls is used.",
                    failed_step="cli_arguments",
                    safe_next_step="use_https_source_or_enable_mirror_urls_then_retry_upload",
                )
            body = {
                "model": seedance_human_model(),
                "name": args.name or source_info["fileName"] or "human-image",
                "projectName": args.project_name,
                "sourceUrl": source_info["source"],
                "waitUntilActive": args.wait_until_active,
            }
            if args.group_id:
                body["groupId"] = args.group_id
            response = request_json(
                base_url,
                "/api/seedance-human-assets/upload",
                token=token,
                method="POST",
                body=body,
                ambiguous_commit_on_network=True,
            )
        else:
            response = post_seedance_human_binary(base_url, token, source_info, args)

        seedance_human_asset_url = find_seedance_asset_url(response)
        if not seedance_human_asset_url:
            raise UploadError(
                "Seedance HTTP upload completed but no HTTPS or asset:// human reference was found in the response. "
                "Do not retry automatically; first recover the newly created Seedance asset from platform asset records.",
                failed_step="http_upload_parse",
                safe_next_step="recover_created_seedance_asset_reference_before_retry",
                response_body=response,
                error_class="ambiguous_commit",
            )

        storage_public_url = find_public_url(response) or source_info["source"]
        return {
            "source": source_info["source"],
            "fileName": source_info["fileName"],
            "mimeType": source_info["mimeType"],
            "fileSize": len(source_info["data"]),
            "storagePublicUrl": storage_public_url,
            "assetPublicUrl": storage_public_url if storage_public_url.startswith("http") else "",
            "seedanceHumanAssetUrl": seedance_human_asset_url,
            "referenceUrl": seedance_human_asset_url,
            "referenceField": "humanImageUrls",
            "assetModel": find_string_by_keys(response, ("assetModel",)),
            "model": find_string_by_keys(response, ("model",)) or seedance_human_model(),
            "projectName": find_string_by_keys(response, ("projectName",)) or args.project_name,
        }

    return run_with_retry(upload_once, label=f"seedance_human_upload:{source_info['fileName']}", args=args)


def parse_args() -> argparse.Namespace:
    parser = JsonArgumentParser(description="Upload assets to Novvy AI Platform without novvy_upload_asset MCP.")
    parser.add_argument("sources", nargs="*", help="Legacy positional local files or HTTP(S) image/video URLs to upload")
    parser.add_argument(
        "--slot",
        action="append",
        default=[],
        metavar="SLOT=SOURCE",
        help="Named upload input. Repeat for each reference slot, for example --slot male_front=/path/to/image.png",
    )
    parser.add_argument("--mode", choices=["asset", "seedance-human"], default="asset", help="Upload mode")
    parser.add_argument(
        "--review-plan-json",
        default="",
        help="Validated plan-upload JSON from reference_workflow.py. Required for seedance-human mode.",
    )
    parser.add_argument("--mcp-json", default="", help="Path to plugin .mcp.json. Defaults to the plugin root .mcp.json.")
    parser.add_argument("--mcp-server", default="novvy_ai_platform")
    parser.add_argument("--kind", choices=["", "image", "video"], default="", help="Regular asset kind; inferred by default")
    parser.add_argument("--name", default="", help="Optional Seedance human asset name")
    parser.add_argument("--project-name", default="default")
    parser.add_argument("--group-id", default="")
    parser.add_argument(
        "--confirmed-human-slot",
        dest="confirmed_human_slot",
        action="append",
        default=[],
        metavar="SLOT",
        help=(
            "Slot explicitly confirmed by a model pixel-level review to contain a live-action or photorealistic human. "
            "Required for every slot in seedance-human mode. Repeat for each accepted slot."
        ),
    )
    parser.add_argument("--no-wait-until-active", dest="wait_until_active", action="store_false")
    parser.add_argument("--mirror-urls", action="store_true", help="Download remote URLs and re-upload them to owned storage first")
    parser.add_argument("--max-bytes", type=int, default=1024 * 1024 * 1024)
    parser.add_argument(
        "--min-image-width",
        type=int,
        default=DEFAULT_MIN_IMAGE_WIDTH,
        help="Minimum accepted image width before upload. Defaults to 300px.",
    )
    parser.add_argument(
        "--max-image-width",
        type=int,
        default=DEFAULT_MAX_IMAGE_WIDTH,
        help="Maximum accepted image width before upload. Defaults to 6000px.",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=DEFAULT_MAX_ATTEMPTS,
        help="Maximum attempts for each retryable remote operation. Defaults to 3 and must be 1-5.",
    )
    parser.add_argument(
        "--retry-base-seconds",
        type=float,
        default=DEFAULT_RETRY_BASE_SECONDS,
        help="Initial exponential retry delay in seconds. Defaults to 1.",
    )
    parser.add_argument(
        "--retry-max-seconds",
        type=float,
        default=DEFAULT_RETRY_MAX_SECONDS,
        help="Maximum delay for one retry, including Retry-After. Defaults to 8.",
    )
    parser.add_argument("--include-assets", action="store_true", help="Include per-asset debug fields in the JSON output")
    parser.set_defaults(wait_until_active=True)
    return parser.parse_args()


def validate_retry_args(args: argparse.Namespace) -> None:
    if args.max_attempts < 1 or args.max_attempts > 5:
        raise UploadError(
            "--max-attempts must be between 1 and 5.",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )
    if args.retry_base_seconds < 0 or args.retry_max_seconds < args.retry_base_seconds:
        raise UploadError(
            "Retry delays must satisfy 0 <= --retry-base-seconds <= --retry-max-seconds.",
            failed_step="cli_arguments",
            safe_next_step="fix_upload_cli_arguments",
        )


def main() -> int:
    warnings: list[str] = []
    args = None
    try:
        args = parse_args()
        args.retry_events = []
        validate_image_width_args(args)
        validate_retry_args(args)
        items, warnings = upload_items(args)
        items, skipped_items = filter_non_upload_items(items, warnings)
        items, reviewed_human_slots = load_review_plan(args.review_plan_json, args.mode, items)
        if args.mode == "seedance-human":
            command_human_slots = {slot.strip() for slot in args.confirmed_human_slot if slot.strip()}
            if command_human_slots and command_human_slots != reviewed_human_slots:
                raise UploadError(
                    "--confirmed-human-slot values must exactly match the validated review plan.",
                    failed_step="human_visual_validation",
                    safe_next_step="use_the_confirmed_slots_from_the_validated_review_plan",
                    error_class="human_review_required",
                )
            confirmed_human_slots = reviewed_human_slots
            items, seedance_skipped_items = filter_seedance_human_items(items, confirmed_human_slots, warnings)
            skipped_items.extend(seedance_skipped_items)
        source_infos = read_and_validate_sources(items, args)
        validate_reviewed_source_bytes(items, source_infos)
        server = mcp_config(args)
        base_url = resolve_base_url_from_mcp(server)
        token = resolve_token(server)
        assets = []
        for index, (item, source_info) in enumerate(zip(items, source_infos)):
            try:
                if args.mode == "seedance-human":
                    assets.append(upload_seedance_human_asset(base_url, token, source_info, args))
                else:
                    assets.append(upload_regular_asset(base_url, token, source_info, args.kind, args))
            except UploadError as exc:
                exc.failed_slot = exc.failed_slot or item["slot"]
                exc.completed_slots = [completed["slot"] for completed in items[:index]]
                exc.pending_slots = [pending["slot"] for pending in items[index:]]
                raise

        print(json_dumps(compact_success_response(args, items, assets, warnings, skipped_items)))
        return 0
    except UploadError as exc:
        retry_events = args.retry_events if args is not None and hasattr(args, "retry_events") else []
        max_attempts = args.max_attempts if args is not None and hasattr(args, "max_attempts") else DEFAULT_MAX_ATTEMPTS
        print(json_dumps(compact_error_response(exc, warnings, retry_events, max_attempts)))
        return 1
    except OSError as exc:
        wrapped = UploadError(
            str(exc),
            failed_step="local_io",
            safe_next_step="fix_local_file_access_or_workspace_permissions",
        )
        retry_events = args.retry_events if args is not None and hasattr(args, "retry_events") else []
        max_attempts = args.max_attempts if args is not None and hasattr(args, "max_attempts") else DEFAULT_MAX_ATTEMPTS
        print(json_dumps(compact_error_response(wrapped, warnings, retry_events, max_attempts)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
