#!/usr/bin/env python3
"""Upload Novvy AI Platform assets through HTTP endpoints, without MCP upload."""

import argparse
import json
import mimetypes
import random
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path


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
        self.response_body = response_body
        self.attempts = attempts
        self.error_class = error_class or {"http_upload_parse": "response_contract", "image_validation": "source_invalid", "cli_arguments": "prompt_or_parameter"}.get(failed_step, "input_or_platform")
        self.failed_slot = failed_slot
        self.completed_slots = completed_slots or []
        self.pending_slots = pending_slots or []


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
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
SEEDANCE_HUMAN_DEFAULT_SLOTS = frozenset(("male_front", "male_side", "female_front", "female_side"))
SEEDANCE_HUMAN_NON_HUMAN_SLOTS = frozenset(("final_card",))
IMAGE_EXTENSIONS = frozenset((".avif", ".bmp", ".gif", ".heic", ".heif", ".jpeg", ".jpg", ".png", ".webp"))
VIDEO_EXTENSIONS = frozenset((".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"))
DEFAULT_MIN_IMAGE_WIDTH = 300
DEFAULT_MAX_IMAGE_WIDTH = 6000
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_RETRY_BASE_SECONDS = 1.0
DEFAULT_RETRY_MAX_SECONDS = 8.0


def retry_after_from_headers(headers: object) -> float | None:
    if headers is None or not hasattr(headers, "get"):
        return None
    value = headers.get("Retry-After")
    try:
        return max(0.0, float(value)) if value is not None else None
    except (TypeError, ValueError):
        return None


def is_retryable_status(status_code: int | None) -> bool:
    return status_code in {408, 409, 425, 429, 500, 502, 503, 504}


def run_with_retry(operation, *, label: str, args: argparse.Namespace):
    for attempt in range(1, args.max_attempts + 1):
        try:
            return operation()
        except UploadError as exc:
            if not exc.retryable or attempt >= args.max_attempts:
                raise
            requested = exc.retry_after_seconds if exc.retry_after_seconds is not None else args.retry_base_seconds * (2 ** (attempt - 1))
            delay = min(max(0.0, requested), args.retry_max_seconds)
            delay = min(args.retry_max_seconds, delay + random.uniform(0, min(0.25, delay / 4 if delay else 0)))
            args.retry_events.append({"operation": label, "attempt": attempt, "delaySeconds": round(delay, 3)})
            time.sleep(delay)
    raise AssertionError("retry loop exhausted")


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
        "请先在插件根目录 novvy-plugin-local.json 填写本机 Novvy admin_user.apikey，再运行 $novvy-env-check；"
        "env-check 会统一回填 novvy-plugin-config.json 的 adminUserApiKey，并同步 .mcp.json。"
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
    return find_string_by_keys(
        data,
        ("assetUrl", "seedanceHumanAssetUrl", "humanAssetUrl", "referenceUrl", "url", "uri"),
        prefix="asset://",
    )


def request_json(base_url: str, path: str, *, token: str | None = None, method: str = "GET", body: object | None = None) -> dict:
    url = urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = read_response_body(response)
    except urllib.error.HTTPError as exc:
        response_data = read_response_body(exc)
        message = api_error_message(response_data, f"HTTP {exc.code} calling {path}")
        if is_auth_failure_message(message, exc.code):
            raise UploadError(auth_failure_message(message)) from exc
        raise UploadError(
            message,
            retryable=is_retryable_status(exc.code),
            status_code=exc.code,
            retry_after_seconds=retry_after_from_headers(exc.headers),
            error_class="transient_remote" if is_retryable_status(exc.code) else "platform_rejected",
        ) from exc
    except urllib.error.URLError as exc:
        raise UploadError(
            f"Network error calling {path}: {exc.reason}",
            retryable=method in {"GET", "HEAD", "PUT"},
            error_class="transient_remote" if method in {"GET", "HEAD", "PUT"} else "ambiguous_commit",
            safe_next_step="check_remote_state_before_retry" if method == "POST" else "check_network_then_retry",
        ) from exc
    except (TimeoutError, socket.timeout) as exc:
        raise UploadError(
            f"Request timed out calling {path}",
            retryable=method in {"GET", "HEAD", "PUT"},
            error_class="transient_remote" if method in {"GET", "HEAD", "PUT"} else "ambiguous_commit",
            safe_next_step="check_remote_state_before_retry" if method == "POST" else "check_network_then_retry",
        ) from exc

    if not isinstance(data, dict):
        raise UploadError(f"Expected JSON object from {path}")
    if data.get("ok") is False:
        message = api_error_message(data, f"API returned ok=false from {path}")
        if is_auth_failure_message(message):
            raise UploadError(auth_failure_message(message))
        raise UploadError(message)
    return data


def plugin_root_from_script() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").exists():
            return parent
    return Path(__file__).resolve().parents[3]


def find_mcp_json(explicit_path: str) -> Path:
    if explicit_path:
        path = Path(explicit_path).expanduser().resolve()
    else:
        path = plugin_root_from_script() / ".mcp.json"

    if not path.exists() or not path.is_file():
        raise UploadError(f"Missing .mcp.json: {path}")
    return path


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
    return any(marker in text for marker in ("your-", "your_", "<", ">", "${", "changeme", "change-me", "placeholder", "apikey", "api-key", "填入", "替换"))


def mcp_config(args: argparse.Namespace) -> dict:
    path = find_mcp_json(args.mcp_json)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise UploadError(f"Failed to read {path}: {exc}") from exc

    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        raise UploadError(f"{path} must contain mcpServers")

    server = servers.get(args.mcp_server)
    if not isinstance(server, dict):
        raise UploadError(f"{path} must contain mcpServers.{args.mcp_server}")
    return server


def resolve_token_from_local_config() -> tuple[str, dict]:
    plugin_root = plugin_root_from_script()
    scripts_dir = plugin_root / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    try:
        from novvy_config import configured_api_key, configured_api_key_status  # noqa: WPS433
    except (ImportError, OSError) as exc:
        return "", {
            "configured": False,
            "ok": False,
            "safeSummary": f"无法读取 Novvy 本地参数文件 helper：{exc}",
        }

    status = configured_api_key_status(plugin_root=plugin_root)
    return configured_api_key(plugin_root=plugin_root), status


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


def resolve_token_from_mcp(server: dict) -> str:
    token = bearer_from_headers(server.get("http_headers"))
    if not token:
        raise UploadError(
            ".mcp.json must set mcpServers.novvy_ai_platform.http_headers.Authorization to Bearer <apikey>, "
            "or run $novvy-env-check with novvy-plugin-local.json or enter the local admin_user.apikey when asked."
        )
    if token_looks_placeholder(token):
        raise UploadError(
            ".mcp.json Authorization looks like a placeholder. "
            "Configure novvy-plugin-local.json, then run $novvy-env-check."
        )
    return token


def resolve_token(server: dict) -> str:
    token, status = resolve_token_from_local_config()
    if token:
        return token
    if status.get("configured") and not status.get("ok"):
        raise UploadError(f"{status.get('safeSummary')} 修复后从参考图组上传步骤重试，不要自动重传。")
    return resolve_token_from_mcp(server)


def resolve_base_url_from_mcp(server: dict) -> str:
    base_url = base_url_from_mcp_server(server)
    if not base_url:
        raise UploadError(".mcp.json must set mcpServers.novvy_ai_platform.url, for example https://developer.novvy.ai/mcp")
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
    warnings = []
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


def filter_seedance_human_items(items: list[dict], explicit_human_slots: set[str], warnings: list[str]) -> tuple[list[dict], list[dict]]:
    human_slots = SEEDANCE_HUMAN_DEFAULT_SLOTS | explicit_human_slots
    uploadable = []
    skipped = []
    for item in items:
        slot = item["slot"]
        if slot in human_slots:
            uploadable.append(item)
            continue

        reason = (
            "non_human_reference_slot"
            if slot in SEEDANCE_HUMAN_NON_HUMAN_SLOTS
            else "unmarked_seedance_human_slot"
        )
        skipped.append({"slot": slot, "source": item["source"], "reason": reason})

    if skipped:
        skipped_names = ", ".join(item["slot"] for item in skipped)
        warnings.append(
            "Seedance 真人上传已跳过非真人或未显式标记为真人的槽位："
            f"{skipped_names}。这些图片不会进入 humanImageUrls。"
        )

    if not uploadable:
        raise UploadError(
            "Seedance human mode did not receive any human reference slots to upload. "
            "Use male_front/male_side/female_front/female_side, or pass --human-slot SLOT for a custom confirmed human slot.",
            failed_step="cli_arguments",
            safe_next_step="provide_confirmed_human_reference_slots_then_retry_upload",
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
        )

    result = {
        "ok": True,
        "uploadMode": args.mode,
        "referenceField": reference_field,
        "referenceUrls": reference_urls,
        "videoPayloadHint": {reference_field: reference_urls},
        "slots": [slot_summary(item, asset) for item, asset in zip(items, assets)],
        "skippedSlots": [skipped_slot_summary(item) for item in (skipped_items or [])],
        "fileNames": [asset.get("fileName") or source_name(item["source"]) for item, asset in zip(items, assets)],
        "warnings": warnings,
        "retrySummary": {"retryCount": len(args.retry_events), "events": args.retry_events},
    }
    if args.include_assets:
        result["assets"] = assets
    return result


def compact_error_response(exc: UploadError, warnings: list[str] | None = None, retry_events: list[dict] | None = None) -> dict:
    return {
        "ok": False,
        "error": str(exc),
        "failedStep": exc.failed_step,
        "safeNextStep": exc.safe_next_step,
        "retryable": exc.retryable,
        "statusCode": exc.status_code,
        "errorClass": exc.error_class,
        "failedSlot": exc.failed_slot,
        "completedSlots": exc.completed_slots,
        "pendingSlots": exc.pending_slots,
        "retrySummary": {"retryCount": len(retry_events or []), "events": retry_events or []},
        "warnings": warnings or [],
    }


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
        from PIL import Image, UnidentifiedImageError  # noqa: WPS433
    except ModuleNotFoundError:
        # Contextual Studio's lightweight runtime may not include Pillow. PNG
        # and JPEG dimensions can still be validated safely from their headers.
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
            "Pillow is unavailable and this image format cannot be validated without it. Use PNG/JPEG or configure Pillow.",
            failed_step="local_environment",
            safe_next_step="convert_image_to_png_or_jpeg_then_retry_upload",
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
        source_info = read_source(item["source"], args.max_bytes)
        validate_image_width(item, source_info, args)
        source_infos.append(source_info)
    return source_infos


def read_source(source: str, max_bytes: int) -> dict:
    if is_http_url(source):
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
                        raise UploadError(f"Remote source exceeds max bytes: {source}")
                data = response.read(max_bytes + 1)
                mime_type = response.headers.get_content_type() or "application/octet-stream"
        except urllib.error.URLError as exc:
            raise UploadError(f"Failed to read remote source {source}: {exc.reason}") from exc
        if len(data) > max_bytes:
            raise UploadError(f"Remote source exceeds max bytes: {source}")
        return {
            "source": source,
            "data": data,
            "fileName": extension_name_from_url(source),
            "mimeType": mime_type,
            "isRemote": True,
        }

    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise UploadError(f"File not found: {path}")
    if not path.is_file():
        raise UploadError(f"Not a file: {path}")
    if path.stat().st_size > max_bytes:
        raise UploadError(f"Local source exceeds max bytes: {path}")
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
                raise UploadError(f"GCS upload failed: HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        raise UploadError(
            f"GCS upload failed: HTTP {exc.code}",
            retryable=is_retryable_status(exc.code) or exc.code in {401, 403},
            status_code=exc.code,
            retry_after_seconds=retry_after_from_headers(exc.headers),
            error_class="signed_upload_expired" if exc.code in {401, 403} else "transient_remote",
            safe_next_step="request_new_signed_url_then_retry_failed_upload",
        ) from exc
    except urllib.error.URLError as exc:
        raise UploadError(
            f"GCS upload failed: {exc.reason}",
            retryable=True,
            error_class="transient_remote",
            safe_next_step="check_network_then_request_new_signed_url_and_retry",
        ) from exc


def upload_to_signed_endpoint(
    base_url: str,
    token: str,
    source_info: dict,
    *,
    endpoint: str,
    kind: str,
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

    signed = request_json(base_url, endpoint, token=token, method="POST", body=body)
    upload_url = find_string_by_keys(signed, ("uploadUrl", "signedUploadUrl", "signedUrl"), prefix="http")
    public_url = find_public_url(signed)
    if not upload_url or not public_url:
        raise UploadError(f"Signed upload response from {endpoint} did not include uploadUrl/publicUrl")

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


def upload_regular_asset(base_url: str, token: str, source_info: dict, kind_value: str, args: argparse.Namespace) -> dict:
    kind = kind_value or infer_kind(source_info["mimeType"], source_info["fileName"])
    return run_with_retry(
        lambda: upload_to_signed_endpoint(
            base_url,
            token,
            source_info,
            endpoint="/api/assets/upload-url",
            kind=kind,
        ),
        label=f"asset_upload:{source_info['fileName']}",
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
            raise UploadError(auth_failure_message(message)) from exc
        raise UploadError(message) from exc
    except urllib.error.URLError as exc:
        raise UploadError(f"Network error calling /api/seedance-human-assets/upload: {exc.reason}") from exc

    if not isinstance(data, dict):
        raise UploadError("Expected JSON object from /api/seedance-human-assets/upload")
    if data.get("ok") is False:
        message = api_error_message(data, "API returned ok=false from /api/seedance-human-assets/upload")
        if is_auth_failure_message(message):
            raise UploadError(auth_failure_message(message))
        raise UploadError(message)
    return data


def upload_seedance_human_asset(base_url: str, token: str, source_info: dict, args: argparse.Namespace) -> dict:
    if source_info["isRemote"] and not args.mirror_urls:
        parsed = urllib.parse.urlparse(source_info["source"])
        if parsed.scheme != "https":
            raise UploadError("Seedance human image source URLs must be https unless --mirror-urls is used.")
        body = {
            "model": seedance_human_model(),
            "name": args.name or source_info["fileName"] or "human-image",
            "projectName": args.project_name,
            "sourceUrl": source_info["source"],
            "waitUntilActive": args.wait_until_active,
        }
        if args.group_id:
            body["groupId"] = args.group_id
        response = request_json(base_url, "/api/seedance-human-assets/upload", token=token, method="POST", body=body)
    else:
        response = post_seedance_human_binary(base_url, token, source_info, args)

    seedance_human_asset_url = find_seedance_asset_url(response)
    if not seedance_human_asset_url:
        raise UploadError(
            "Seedance HTTP upload completed but no asset:// reference was found in the response. "
            "Do not retry automatically; first recover the newly created Seedance asset from platform asset records."
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
    parser.add_argument("--mcp-json", default="", help="Path to plugin .mcp.json. Defaults to the plugin root .mcp.json.")
    parser.add_argument("--mcp-server", default="novvy_ai_platform")
    parser.add_argument("--kind", choices=["", "image", "video"], default="", help="Regular asset kind; inferred by default")
    parser.add_argument("--name", default="", help="Optional Seedance human asset name")
    parser.add_argument("--project-name", default="default")
    parser.add_argument("--group-id", default="")
    parser.add_argument(
        "--human-slot",
        action="append",
        default=[],
        metavar="SLOT",
        help="Additional custom slot confirmed to contain a real human reference in seedance-human mode.",
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
    parser.add_argument("--include-assets", action="store_true", help="Include per-asset debug fields in the JSON output")
    parser.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS, help="Maximum attempts for retryable regular uploads (1-5)")
    parser.add_argument("--retry-base-seconds", type=float, default=DEFAULT_RETRY_BASE_SECONDS)
    parser.add_argument("--retry-max-seconds", type=float, default=DEFAULT_RETRY_MAX_SECONDS)
    parser.set_defaults(wait_until_active=True)
    return parser.parse_args()


def main() -> int:
    warnings = []
    args = None
    try:
        args = parse_args()
        if not 1 <= args.max_attempts <= 5 or args.retry_base_seconds < 0 or args.retry_max_seconds < args.retry_base_seconds:
            raise UploadError("Invalid retry settings", failed_step="cli_arguments", safe_next_step="fix_upload_cli_arguments")
        args.retry_events = []
        validate_image_width_args(args)
        items, warnings = upload_items(args)
        items, skipped_items = filter_non_upload_items(items, warnings)
        if args.mode == "seedance-human":
            explicit_human_slots = {slot.strip() for slot in args.human_slot if slot.strip()}
            items, seedance_skipped_items = filter_seedance_human_items(items, explicit_human_slots, warnings)
            skipped_items.extend(seedance_skipped_items)
        source_infos = read_and_validate_sources(items, args)
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
                exc.failed_slot = item["slot"]
                exc.completed_slots = [entry["slot"] for entry in items[:index]]
                exc.pending_slots = [entry["slot"] for entry in items[index:]]
                raise

        print(json_dumps(compact_success_response(args, items, assets, warnings, skipped_items)))
        return 0
    except UploadError as exc:
        retry_events = args.retry_events if args is not None and hasattr(args, "retry_events") else []
        print(json_dumps(compact_error_response(exc, warnings, retry_events)))
        return 1
    except OSError as exc:
        wrapped = UploadError(
            str(exc),
            failed_step="local_io",
            safe_next_step="fix_local_file_access_or_workspace_permissions",
        )
        retry_events = args.retry_events if args is not None and hasattr(args, "retry_events") else []
        print(json_dumps(compact_error_response(wrapped, warnings, retry_events)))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
