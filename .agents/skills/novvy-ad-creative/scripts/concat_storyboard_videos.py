#!/usr/bin/env python3
"""Concatenate approved storyboard clips in an explicit, stable order."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_MAX_DOWNLOAD_MB = 2048
DEFAULT_TRANSITION_SECONDS = 0.35
MIN_TRANSITION_SECONDS = 0.1
MAX_TRANSITION_SECONDS = 1.5
RETRYABLE_HTTP_STATUSES = {408, 425, 429, 500, 502, 503, 504}
SHOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
CONCAT_MANIFEST_VERSION = "novvy.approved-storyboard.v1"


class ConcatError(RuntimeError):
    def __init__(self, message: str, *, failed_step: str, safe_next_step: str) -> None:
        super().__init__(message)
        self.failed_step = failed_step
        self.safe_next_step = safe_next_step


def json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def workspace_dir() -> Path:
    configured = os.environ.get("NOVVY_WORKSPACE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return Path.home() / "novvy_ad_workplace"


def ensure_workspace_path(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    root = workspace_dir().expanduser().resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ConcatError(
            f"{label} must be inside Novvy workspace: {root}",
            failed_step="output_validation",
            safe_next_step="choose_output_inside_novvy_workspace",
        ) from exc
    return resolved


def is_http_url(value: str) -> bool:
    return value.lower().startswith(("http://", "https://"))


def parse_clips(values: list[str]) -> list[dict[str, str]]:
    if len(values) < 2:
        raise ConcatError(
            "At least two --clip SHOT_ID=SOURCE values are required.",
            failed_step="cli_arguments",
            safe_next_step="provide_two_or_more_approved_storyboard_clips_in_order",
        )

    clips: list[dict[str, str]] = []
    seen: set[str] = set()
    for value in values:
        shot_id, separator, source = value.partition("=")
        shot_id = shot_id.strip()
        source = source.strip()
        if not separator or not shot_id or not source:
            raise ConcatError(
                f"Invalid --clip value: {value!r}. Expected SHOT_ID=SOURCE.",
                failed_step="cli_arguments",
                safe_next_step="fix_storyboard_clip_arguments",
            )
        if not SHOT_ID_PATTERN.fullmatch(shot_id):
            raise ConcatError(
                f"Invalid shot ID: {shot_id!r}",
                failed_step="cli_arguments",
                safe_next_step="use_alphanumeric_storyboard_ids_with_dots_dashes_or_underscores",
            )
        if shot_id in seen:
            raise ConcatError(
                f"Duplicate shot ID: {shot_id}",
                failed_step="cli_arguments",
                safe_next_step="provide_each_storyboard_id_once",
            )
        seen.add(shot_id)
        clips.append({"shotId": shot_id, "source": source})
    return clips


def parse_concat_manifest(path_value: str) -> tuple[list[dict[str, str]], str]:
    path = Path(path_value).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConcatError(
            f"Could not read approved storyboard manifest: {exc}",
            failed_step="manifest_validation",
            safe_next_step="fix_the_approved_storyboard_manifest",
        ) from exc
    if not isinstance(data, dict) or data.get("schemaVersion") != CONCAT_MANIFEST_VERSION:
        raise ConcatError(
            f"Manifest schemaVersion must be {CONCAT_MANIFEST_VERSION}.",
            failed_step="manifest_validation",
            safe_next_step="fix_the_approved_storyboard_manifest",
        )
    active_snapshot_id = str(data.get("activeSnapshotId") or "").strip()
    shots = data.get("shots")
    if not active_snapshot_id or not isinstance(shots, list) or len(shots) < 2:
        raise ConcatError(
            "Manifest requires activeSnapshotId and at least two approved shots.",
            failed_step="manifest_validation",
            safe_next_step="provide_the_complete_approved_storyboard_manifest",
        )
    clips = []
    for index, raw in enumerate(shots, start=1):
        if not isinstance(raw, dict):
            raise ConcatError(
                f"Manifest shot {index} must be an object.",
                failed_step="manifest_validation",
                safe_next_step="fix_the_approved_storyboard_manifest",
            )
        expected_id = f"shot-{index:02d}"
        shot_id = str(raw.get("shotId") or "").strip()
        version = raw.get("version")
        source = str(raw.get("source") or "").strip()
        if shot_id != expected_id or raw.get("order") != index:
            raise ConcatError(
                f"Manifest shots must be ordered continuously; expected {expected_id} at order {index}.",
                failed_step="manifest_validation",
                safe_next_step="fix_storyboard_shot_order_before_concat",
            )
        if raw.get("status") != "approved" or not isinstance(version, int) or isinstance(version, bool) or version < 1:
            raise ConcatError(
                f"{shot_id} must be an approved version >= 1.",
                failed_step="manifest_validation",
                safe_next_step="approve_the_latest_version_of_every_shot_before_concat",
            )
        if raw.get("snapshotId") != active_snapshot_id:
            raise ConcatError(
                f"{shot_id} does not use activeSnapshotId {active_snapshot_id}.",
                failed_step="manifest_validation",
                safe_next_step="regenerate_and_approve_all_stale_snapshot_shots_before_concat",
            )
        if not source:
            raise ConcatError(
                f"{shot_id} has no approved result source.",
                failed_step="manifest_validation",
                safe_next_step="recover_the_approved_storyboard_result_before_concat",
            )
        clips.append({"shotId": shot_id, "source": source})
    return clips, active_snapshot_id


def resolve_executable(value: str, name: str) -> str:
    if value:
        candidate = Path(value).expanduser().resolve()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    else:
        found = shutil.which(name)
        if found:
            return found
    raise ConcatError(
        f"Required executable not found: {value or name}",
        failed_step="environment_check",
        safe_next_step="run_novvy_env_check_and_install_ffmpeg",
    )


def retry_after_seconds(headers: Any) -> float:
    if headers is None:
        return 0.0
    value = headers.get("Retry-After") if hasattr(headers, "get") else None
    if not isinstance(value, (str, int, float)):
        return 0.0
    try:
        return max(0.0, min(float(value), 8.0))
    except (TypeError, ValueError):
        return 0.0


def download_once(url: str, output: Path, max_bytes: int) -> None:
    headers = {"Accept": "video/*,application/octet-stream,*/*"}
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=180) as response, output.open("wb") as target:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ConcatError(
                    f"Remote storyboard clip exceeds {max_bytes} bytes.",
                    failed_step="source_download",
                    safe_next_step="provide_a_smaller_or_local_storyboard_clip",
                )
            target.write(chunk)
    if output.stat().st_size == 0:
        raise ConcatError(
            "Remote storyboard clip returned an empty body.",
            failed_step="source_download",
            safe_next_step="recover_the_generation_result_url_and_retry_concat",
        )


def download_remote_clip(url: str, output: Path, max_bytes: int) -> None:
    for attempt in range(1, 4):
        try:
            download_once(url, output, max_bytes)
            return
        except urllib.error.HTTPError as exc:
            retryable = exc.code in RETRYABLE_HTTP_STATUSES or exc.code >= 500
            if not retryable or attempt == 3:
                raise ConcatError(
                    f"Could not download storyboard result: HTTP {exc.code}",
                    failed_step="source_download",
                    safe_next_step="recover_or_refresh_the_failed_storyboard_result_url",
                ) from exc
            delay = retry_after_seconds(exc.headers) or min(2 ** (attempt - 1), 8)
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt == 3:
                raise ConcatError(
                    f"Could not download storyboard result: {exc}",
                    failed_step="source_download",
                    safe_next_step="check_network_then_retry_storyboard_concat",
                ) from exc
            delay = min(2 ** (attempt - 1), 8)
        finally:
            if output.exists() and output.stat().st_size == 0:
                output.unlink(missing_ok=True)
        time.sleep(delay)


def safe_remote_suffix(url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".mp4", ".mov", ".m4v", ".webm", ".mkv"} else ".mp4"


def materialize_clips(
    clips: list[dict[str, str]],
    temp_dir: Path,
    max_download_bytes: int,
) -> list[dict[str, Any]]:
    materialized: list[dict[str, Any]] = []
    for index, clip in enumerate(clips, start=1):
        source = clip["source"]
        if is_http_url(source):
            suffix = safe_remote_suffix(source)
            local_path = temp_dir / f"download-{index:03d}{suffix}"
            download_remote_clip(source, local_path, max_download_bytes)
            source_type = "remote"
            source_name = Path(urllib.parse.urlparse(source).path).name or f"shot-{index:03d}{suffix}"
        else:
            local_path = Path(source).expanduser().resolve()
            if not local_path.exists() or not local_path.is_file():
                raise ConcatError(
                    f"Storyboard clip not found: {local_path}",
                    failed_step="source_validation",
                    safe_next_step="recover_the_missing_approved_storyboard_clip",
                )
            source_type = "local"
            source_name = local_path.name

        alias_suffix = local_path.suffix.lower() or ".mp4"
        alias_path = temp_dir / f"clip-{index:03d}{alias_suffix}"
        if alias_path != local_path:
            alias_path.symlink_to(local_path)
        materialized.append(
            {
                "shotId": clip["shotId"],
                "sourceType": source_type,
                "sourceName": source_name,
                "path": alias_path,
            }
        )
    return materialized


def run_command(command: list[str], *, failed_step: str, safe_next_step: str) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown FFmpeg error").strip()[-1600:]
        raise ConcatError(
            f"Media command failed: {detail}",
            failed_step=failed_step,
            safe_next_step=safe_next_step,
        )
    return completed


def parse_float(value: object) -> float:
    if not isinstance(value, (str, int, float)):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number > 0 else 0.0


def probe_media(ffprobe: str, path: Path) -> dict[str, Any]:
    completed = run_command(
        [
            ffprobe,
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(path),
        ],
        failed_step="media_probe",
        safe_next_step="replace_or_recover_the_invalid_storyboard_video",
    )
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ConcatError(
            "ffprobe returned invalid JSON.",
            failed_step="media_probe",
            safe_next_step="run_novvy_env_check_and_verify_ffprobe",
        ) from exc

    streams = data.get("streams") if isinstance(data, dict) else []
    streams = streams if isinstance(streams, list) else []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if item.get("codec_type") == "audio"), None)
    if not isinstance(video, dict):
        raise ConcatError(
            f"Input does not contain a video stream: {path.name}",
            failed_step="media_probe",
            safe_next_step="replace_the_non_video_storyboard_result",
        )

    format_data = data.get("format") if isinstance(data, dict) else {}
    duration = parse_float(format_data.get("duration") if isinstance(format_data, dict) else None)
    if not duration:
        duration = parse_float(video.get("duration"))
    if not duration:
        raise ConcatError(
            f"Input video duration is unavailable: {path.name}",
            failed_step="media_probe",
            safe_next_step="replace_or_reencode_the_storyboard_video",
        )

    return {
        "duration": duration,
        "video": {
            "codec": str(video.get("codec_name") or ""),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "pixelFormat": str(video.get("pix_fmt") or ""),
            "frameRate": str(video.get("r_frame_rate") or ""),
            "timeBase": str(video.get("time_base") or ""),
        },
        "audio": (
            {
                "codec": str(audio.get("codec_name") or ""),
                "sampleRate": str(audio.get("sample_rate") or ""),
                "channels": int(audio.get("channels") or 0),
                "channelLayout": str(audio.get("channel_layout") or ""),
                "timeBase": str(audio.get("time_base") or ""),
            }
            if isinstance(audio, dict)
            else None
        ),
    }


def stream_copy_compatible(items: list[dict[str, Any]]) -> bool:
    if not items:
        return False
    first = items[0]["probe"]
    for item in items[1:]:
        current = item["probe"]
        if current["video"] != first["video"] or current["audio"] != first["audio"]:
            return False
    return True


def write_concat_list(path: Path, sources: list[Path]) -> None:
    lines = []
    for source in sources:
        escaped = str(source).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def concat_stream_copy(ffmpeg: str, sources: list[Path], output: Path, temp_dir: Path) -> None:
    concat_list = temp_dir / "concat-list.txt"
    write_concat_list(concat_list, sources)
    run_command(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            "-y",
            str(output),
        ],
        failed_step="stream_copy_concat",
        safe_next_step="normalize_storyboard_clips_then_retry_concat",
    )


def even_dimension(value: int, label: str) -> int:
    if value < 64 or value > 8192 or value % 2:
        raise ConcatError(
            f"{label} must be an even integer between 64 and 8192.",
            failed_step="cli_arguments",
            safe_next_step="fix_storyboard_output_dimensions",
        )
    return value


def transition_seconds(value: float) -> float:
    if value < MIN_TRANSITION_SECONDS or value > MAX_TRANSITION_SECONDS:
        raise ConcatError(
            f"--transition-seconds must be between {MIN_TRANSITION_SECONDS} and {MAX_TRANSITION_SECONDS}.",
            failed_step="cli_arguments",
            safe_next_step="choose_a_short_storyboard_crossfade_duration",
        )
    return value


def build_crossfade_filter(durations: list[float], duration: float) -> tuple[str, str, str]:
    if len(durations) < 2:
        raise ConcatError(
            "At least two clips are required for a crossfade transition.",
            failed_step="transition_setup",
            safe_next_step="provide_two_or_more_approved_storyboard_clips",
        )
    if any(item <= duration for item in durations):
        raise ConcatError(
            "Every storyboard clip must be longer than the crossfade duration.",
            failed_step="transition_setup",
            safe_next_step="shorten_the_transition_or_replace_the_too_short_storyboard_clip",
        )

    filters = []
    for index in range(len(durations)):
        filters.append(f"[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[v{index}]")
        filters.append(f"[{index}:a]asetpts=PTS-STARTPTS[a{index}]")

    video_label = "v0"
    audio_label = "a0"
    elapsed = durations[0]
    for index in range(1, len(durations)):
        next_video = f"vx{index}"
        next_audio = f"ax{index}"
        offset = elapsed - duration
        filters.append(
            f"[{video_label}][v{index}]xfade=transition=fade:duration={duration:.6f}:offset={offset:.6f}[{next_video}]"
        )
        filters.append(
            f"[{audio_label}][a{index}]acrossfade=d={duration:.6f}:c1=tri:c2=tri[{next_audio}]"
        )
        video_label = next_video
        audio_label = next_audio
        elapsed += durations[index] - duration
    return ";".join(filters), video_label, audio_label


def crossfade_normalized_clips(
    ffmpeg: str,
    sources: list[Path],
    durations: list[float],
    output: Path,
    *,
    fps: int,
    crf: int,
    duration: float,
) -> None:
    filter_complex, video_label, audio_label = build_crossfade_filter(durations, duration)
    command = [ffmpeg, "-v", "error"]
    for source in sources:
        command.extend(["-i", str(source)])
    command.extend(
        [
            "-filter_complex",
            filter_complex,
            "-map",
            f"[{video_label}]",
            "-map",
            f"[{audio_label}]",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-r",
            str(fps),
            "-fps_mode",
            "cfr",
            "-video_track_timescale",
            "90000",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-y",
            str(output),
        ]
    )
    run_command(
        command,
        failed_step="crossfade_concat",
        safe_next_step="inspect_the_normalized_clips_or_reduce_the_transition_duration",
    )


def normalize_clip(
    ffmpeg: str,
    source: Path,
    output: Path,
    probe: dict[str, Any],
    *,
    width: int,
    height: int,
    fps: int,
    crf: int,
) -> None:
    video_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={fps}"
    )
    command = [ffmpeg, "-v", "error", "-i", str(source)]
    has_audio = probe["audio"] is not None
    if not has_audio:
        command.extend(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
    command.extend(["-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0"])
    command.extend(
        [
            "-vf",
            video_filter,
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-fps_mode",
            "cfr",
            "-video_track_timescale",
            "90000",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-af",
            "aresample=async=1:first_pts=0",
            "-t",
            f"{probe['duration']:.6f}",
            "-movflags",
            "+faststart",
            "-y",
            str(output),
        ]
    )
    run_command(
        command,
        failed_step="media_normalization",
        safe_next_step="inspect_and_repair_the_failed_storyboard_clip",
    )


def normalize_and_crossfade(
    ffmpeg: str,
    items: list[dict[str, Any]],
    output: Path,
    temp_dir: Path,
    *,
    width: int,
    height: int,
    fps: int,
    crf: int,
    transition_duration: float,
) -> None:
    normalized: list[Path] = []
    for index, item in enumerate(items, start=1):
        normalized_path = temp_dir / f"normalized-{index:03d}.mp4"
        normalize_clip(
            ffmpeg,
            item["path"],
            normalized_path,
            item["probe"],
            width=width,
            height=height,
            fps=fps,
            crf=crf,
        )
        normalized.append(normalized_path)
    crossfade_normalized_clips(
        ffmpeg,
        normalized,
        [item["probe"]["duration"] for item in items],
        output,
        fps=fps,
        crf=crf,
        duration=transition_duration,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Concatenate approved Novvy storyboard videos in the exact --clip order."
    )
    parser.add_argument(
        "--clip",
        action="append",
        default=[],
        metavar="SHOT_ID=SOURCE",
        help="Approved storyboard result path or HTTP(S) URL. Repeat in final playback order.",
    )
    parser.add_argument(
        "--manifest",
        default="",
        help="Approved storyboard manifest. Preferred because it enforces versions, approvals, order, and one active snapshot.",
    )
    parser.add_argument("--output", required=True, help="Final .mp4 path inside Novvy workspace")
    parser.add_argument("--overwrite", action="store_true", help="Replace the exact output file if it already exists")
    parser.add_argument("--width", type=int, default=0, help="Normalized width; defaults to the first clip width")
    parser.add_argument("--height", type=int, default=0, help="Normalized height; defaults to the first clip height")
    parser.add_argument("--fps", type=int, default=30, help="Normalized frame rate. Defaults to 30")
    parser.add_argument("--crf", type=int, default=18, help="H.264 CRF used only when normalization is needed")
    parser.add_argument(
        "--transition-seconds",
        type=float,
        default=DEFAULT_TRANSITION_SECONDS,
        help=f"Crossfade duration at every shot boundary. Defaults to {DEFAULT_TRANSITION_SECONDS}",
    )
    parser.add_argument("--max-download-mb", type=int, default=DEFAULT_MAX_DOWNLOAD_MB)
    parser.add_argument("--ffmpeg", default="", help="Optional explicit ffmpeg executable")
    parser.add_argument("--ffprobe", default="", help="Optional explicit ffprobe executable")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> tuple[list[dict[str, str]], Path, str]:
    if args.manifest and args.clip:
        raise ConcatError(
            "Use either --manifest or --clip, not both.",
            failed_step="cli_arguments",
            safe_next_step="choose_the_approved_manifest_or_legacy_clip_arguments",
        )
    if args.manifest:
        clips, active_snapshot_id = parse_concat_manifest(args.manifest)
    else:
        clips = parse_clips(args.clip)
        active_snapshot_id = "legacy-unverified"
    output = ensure_workspace_path(Path(args.output), "Output")
    if output.suffix.lower() != ".mp4":
        raise ConcatError(
            "Output filename must end with .mp4.",
            failed_step="output_validation",
            safe_next_step="choose_an_mp4_output_path",
        )
    if output.exists() and not args.overwrite:
        raise ConcatError(
            f"Output already exists: {output}",
            failed_step="output_validation",
            safe_next_step="choose_a_new_output_version_or_pass_overwrite",
        )
    if bool(args.width) != bool(args.height):
        raise ConcatError(
            "--width and --height must be provided together.",
            failed_step="cli_arguments",
            safe_next_step="provide_both_normalized_dimensions_or_neither",
        )
    if args.fps < 1 or args.fps > 120:
        raise ConcatError(
            "--fps must be between 1 and 120.",
            failed_step="cli_arguments",
            safe_next_step="fix_storyboard_output_frame_rate",
        )
    if args.crf < 0 or args.crf > 51:
        raise ConcatError(
            "--crf must be between 0 and 51.",
            failed_step="cli_arguments",
            safe_next_step="fix_storyboard_h264_crf",
        )
    transition_seconds(args.transition_seconds)
    if args.max_download_mb < 1 or args.max_download_mb > 4096:
        raise ConcatError(
            "--max-download-mb must be between 1 and 4096.",
            failed_step="cli_arguments",
            safe_next_step="fix_storyboard_download_limit",
        )
    return clips, output, active_snapshot_id


def compact_clip_summary(item: dict[str, Any]) -> dict[str, Any]:
    probe = item["probe"]
    return {
        "shotId": item["shotId"],
        "sourceType": item["sourceType"],
        "sourceName": item["sourceName"],
        "durationSeconds": round(probe["duration"], 3),
        "video": probe["video"],
        "hasAudio": probe["audio"] is not None,
    }


def main() -> int:
    partial_output: Path | None = None
    try:
        args = parse_args()
        clips, output, active_snapshot_id = validate_args(args)
        ffmpeg = resolve_executable(args.ffmpeg, "ffmpeg")
        ffprobe = resolve_executable(args.ffprobe, "ffprobe")

        output.parent.mkdir(parents=True, exist_ok=True)
        temp_root = ensure_workspace_path(workspace_dir() / ".concat-temp", "Temporary directory")
        temp_root.mkdir(parents=True, exist_ok=True)
        partial_output = output.parent / f".{output.stem}.partial-{os.getpid()}.mp4"
        partial_output.unlink(missing_ok=True)

        warnings: list[str] = []
        with tempfile.TemporaryDirectory(prefix="storyboard-", dir=temp_root) as directory:
            temp_dir = Path(directory)
            items = materialize_clips(
                clips,
                temp_dir,
                args.max_download_mb * 1024 * 1024,
            )
            for item in items:
                item["probe"] = probe_media(ffprobe, item["path"])

            mode = "normalized_crossfade"
            first_video = items[0]["probe"]["video"]
            width = even_dimension(args.width or int(first_video["width"]), "Output width")
            height = even_dimension(args.height or int(first_video["height"]), "Output height")
            normalize_and_crossfade(
                ffmpeg,
                items,
                partial_output,
                temp_dir,
                width=width,
                height=height,
                fps=args.fps,
                crf=args.crf,
                transition_duration=args.transition_seconds,
            )

            output_probe = probe_media(ffprobe, partial_output)
            partial_output.replace(output)

        print(
            json_dumps(
                {
                    "ok": True,
                    "outputPath": str(output),
                    "mode": mode,
                    "clipCount": len(items),
                    "orderedShots": [item["shotId"] for item in items],
                    "activeSnapshotId": active_snapshot_id,
                    "clips": [compact_clip_summary(item) for item in items],
                    "inputDurationSeconds": round(sum(item["probe"]["duration"] for item in items), 3),
                    "outputDurationSeconds": round(output_probe["duration"], 3),
                    "transition": {
                        "type": "crossfade",
                        "durationSeconds": args.transition_seconds,
                        "boundaryCount": len(items) - 1,
                        "audioCrossfade": True,
                    },
                    "warnings": warnings,
                }
            )
        )
        return 0
    except ConcatError as exc:
        if partial_output is not None:
            partial_output.unlink(missing_ok=True)
        print(
            json_dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "failedStep": exc.failed_step,
                    "safeNextStep": exc.safe_next_step,
                }
            ),
            file=sys.stderr,
        )
        return 1
    except (OSError, subprocess.SubprocessError) as exc:
        if partial_output is not None:
            partial_output.unlink(missing_ok=True)
        print(
            json_dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "failedStep": "local_io",
                    "safeNextStep": "fix_local_media_or_workspace_permissions_then_retry_concat",
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
