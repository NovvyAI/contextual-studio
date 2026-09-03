#!/usr/bin/env python3
"""Prepare bounded video evidence for Novvy ad creative analysis."""

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path


def plugin_root_from_script() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").exists():
            return parent
    # Vendored project-local skills are not wrapped in a plugin bundle.
    return Path(__file__).resolve().parents[1]


PLUGIN_ROOT = plugin_root_from_script()
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))

from novvy_config import read_config, resolve_binary, workspace_dir  # noqa: E402


CONFIG = read_config()
EVIDENCE_SCHEMA_VERSION = 4
DEFAULT_FRAME_COUNT = 20
DEFAULT_FRAME_INTERVAL_SECONDS = 5.0
DEFAULT_MAX_ANALYZE_SECONDS = 900.0
FINGERPRINT_CHUNK_BYTES = 1024 * 1024


def run_json(command: list[str]) -> dict:
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def run(command: list[str], *, quiet: bool = False) -> bool:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        if not quiet:
            print(result.stderr.strip(), file=sys.stderr)
        return False
    return True


def require_binary(name: str) -> str:
    path = resolve_binary(name, CONFIG) or shutil.which(name)
    if not path:
        raise RuntimeError(f"Required binary not found: {name}")
    return path


def content_fingerprint(video_path: Path) -> str:
    """Build a stable, fast fingerprint from file size and three content regions."""
    size = video_path.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    positions = sorted({0, max((size - FINGERPRINT_CHUNK_BYTES) // 2, 0), max(size - FINGERPRINT_CHUNK_BYTES, 0)})
    with video_path.open("rb") as handle:
        for position in positions:
            handle.seek(position)
            digest.update(position.to_bytes(8, "big", signed=False))
            digest.update(handle.read(FINGERPRINT_CHUNK_BYTES))
    return digest.hexdigest()


def default_output_dir(video_fingerprint: str) -> Path:
    return workspace_dir() / "video-memory" / "evidence" / video_fingerprint[:20] / "evidence"


def project_dir_for_output(output_dir: Path) -> Path:
    if output_dir.name == "evidence":
        return output_dir.parent
    return output_dir


def ensure_workspace_output(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    root = workspace_dir().expanduser().resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise RuntimeError(f"{label} must be inside Novvy workspace: {root}") from exc
    return resolved


def probe_video(ffprobe: str, video_path: Path) -> dict:
    return run_json(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,width,height,avg_frame_rate,duration",
            "-of",
            "json",
            str(video_path),
        ]
    )


def parse_duration(metadata: dict) -> float:
    duration = metadata.get("format", {}).get("duration")
    if duration:
        return max(float(duration), 0.0)

    stream_durations = [
        float(stream["duration"])
        for stream in metadata.get("streams", [])
        if stream.get("codec_type") == "video" and stream.get("duration")
    ]
    return max(stream_durations, default=0.0)


def video_stream(metadata: dict) -> dict:
    for stream in metadata.get("streams", []):
        if stream.get("codec_type") == "video":
            return stream
    return {}


def timestamps_for(duration: float, requested_frame_count: int) -> list[float]:
    if duration <= 0:
        return [0.0]

    requested = max(1, requested_frame_count)
    count = requested
    end = max(duration - 0.1, 0.0)
    if count == 1:
        return [min(end / 2, end)]
    return [end * index / (count - 1) for index in range(count)]


def timestamps_for_interval(duration: float, interval_seconds: float, max_duration_seconds: float) -> list[float]:
    analyzed_duration = min(duration, max_duration_seconds) if max_duration_seconds > 0 else duration
    if analyzed_duration <= 0:
        return [0.0]
    end = max(analyzed_duration - 0.1, 0.0)
    interval = max(interval_seconds, 0.1)
    timestamps = [index * interval for index in range(int(end // interval) + 1)]
    return sorted({round(min(timestamp, end), 3) for timestamp in timestamps})


def extract_frames(ffmpeg: str, video_path: Path, output_dir: Path, timestamps: list[float]) -> list[dict]:
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    frames = []

    for index, timestamp in enumerate(timestamps, start=1):
        frame_path = frames_dir / f"frame_{index:03d}_{timestamp:08.2f}s.png"
        attempts = []
        for offset in (0.0, 0.5, 1.0):
            attempt = max(timestamp - offset, 0.0)
            if attempt not in attempts:
                attempts.append(attempt)

        for attempt_index, attempt in enumerate(attempts):
            ok = run(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{attempt:.3f}",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-y",
                    str(frame_path),
                ],
                quiet=attempt_index < len(attempts) - 1,
            )
            if ok and frame_path.exists():
                frames.append(
                    {
                        "frameIndex": index,
                        "timestampSeconds": round(attempt, 3),
                        "requestedTimestampSeconds": round(timestamp, 3),
                        "path": str(frame_path),
                    }
                )
                break

    return frames


def grid_for_count(frame_count: int) -> tuple[int, int]:
    if frame_count <= 1:
        return (1, 1)
    if frame_count <= 4:
        cols = 2
    elif frame_count <= 9:
        cols = 3
    elif frame_count <= 16:
        cols = 4
    else:
        cols = 5
    return (cols, math.ceil(frame_count / cols))


def make_overview_sheet_with_pillow(frames: list[dict], sheet_path: Path) -> bool:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False

    if not frames:
        return False

    cols, rows = grid_for_count(len(frames))
    margin = 16
    padding = 10
    label_height = 26
    max_thumb_width = 360
    max_thumb_height = 360
    cells = []

    for frame in frames:
        with Image.open(frame["path"]) as image:
            thumbnail = image.convert("RGB")
            resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
            thumbnail.thumbnail((max_thumb_width, max_thumb_height), resampling)
            cells.append((frame, thumbnail.copy()))

    cell_width = max(image.width for _, image in cells)
    cell_image_height = max(image.height for _, image in cells)
    cell_height = label_height + cell_image_height
    width = margin * 2 + cols * cell_width + (cols - 1) * padding
    height = margin * 2 + rows * cell_height + (rows - 1) * padding

    canvas = Image.new("RGB", (width, height), (16, 16, 16))
    draw = ImageDraw.Draw(canvas)

    for index, (frame, image) in enumerate(cells):
        col = index % cols
        row = index // cols
        x = margin + col * (cell_width + padding)
        y = margin + row * (cell_height + padding)
        label = f"{frame['frameIndex']:03d} | {frame['timestampSeconds']:.2f}s"
        draw.text((x, y), label, fill=(235, 235, 235))
        image_x = x + (cell_width - image.width) // 2
        canvas.paste(image, (image_x, y + label_height))

    canvas.save(sheet_path, format="PNG")
    return sheet_path.exists()


def link_or_copy(source: Path, target: Path) -> None:
    if target.exists():
        target.unlink()
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)


def make_overview_sheet_with_ffmpeg(
    ffmpeg: str,
    frames: list[dict],
    output_dir: Path,
    sheet_path: Path,
    sheet_index: int,
) -> bool:
    if not frames:
        return False

    cols, rows = grid_for_count(len(frames))
    input_dir = output_dir / "overview_inputs" / f"overview_{sheet_index:02d}"
    input_dir.mkdir(parents=True, exist_ok=True)

    for index, frame in enumerate(frames, start=1):
        link_or_copy(Path(frame["path"]), input_dir / f"frame_{index:03d}.png")

    ok = run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-framerate",
            "1",
            "-i",
            str(input_dir / "frame_%03d.png"),
            "-vf",
            f"scale=360:-2,tile={cols}x{rows}:padding=8:margin=8:color=black",
            "-frames:v",
            "1",
            "-y",
            str(sheet_path),
        ]
    )
    return ok and sheet_path.exists()


def make_overview_sheets(ffmpeg: str, frames: list[dict], output_dir: Path, frames_per_sheet: int) -> list[dict]:
    if not frames:
        return []

    sheets_dir = output_dir / "overview_sheets"
    sheets_dir.mkdir(parents=True, exist_ok=True)
    sheet_size = max(1, frames_per_sheet)
    sheets = []

    for sheet_index, start in enumerate(range(0, len(frames), sheet_size), start=1):
        group = frames[start : start + sheet_size]
        sheet_path = sheets_dir / f"overview_{sheet_index:02d}.png"
        created = make_overview_sheet_with_pillow(group, sheet_path)
        if not created:
            created = make_overview_sheet_with_ffmpeg(ffmpeg, group, output_dir, sheet_path, sheet_index)

        if created:
            sheets.append(
                {
                    "sheetIndex": sheet_index,
                    "frameStartIndex": group[0]["frameIndex"],
                    "frameEndIndex": group[-1]["frameIndex"],
                    "frameCount": len(group),
                    "path": str(sheet_path),
                }
            )

    return sheets


def overview_input_batches(overview_sheets: list[dict], max_images_per_request: int = 20) -> list[dict]:
    batch_size = max(1, max_images_per_request)
    batches = []
    for batch_index, start in enumerate(range(0, len(overview_sheets), batch_size), start=1):
        group = overview_sheets[start : start + batch_size]
        batches.append(
            {
                "batchIndex": batch_index,
                "imageCount": len(group),
                "sheetIndexes": [sheet["sheetIndex"] for sheet in group],
                "paths": [sheet["path"] for sheet in group],
            }
        )
    return batches


def extract_audio_preview(ffmpeg: str, video_path: Path, output_dir: Path) -> str | None:
    audio_path = output_dir / "audio_preview.wav"
    ok = run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-t",
            "30",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-y",
            str(audio_path),
        ]
    )
    if ok and audio_path.exists():
        return str(audio_path)
    return None


def extract_tail_audio_preview(ffmpeg: str, video_path: Path, output_dir: Path, duration: float) -> str | None:
    if duration <= 35:
        return str(output_dir / "audio_preview.wav") if (output_dir / "audio_preview.wav").is_file() else None
    audio_path = output_dir / "audio_tail_preview.wav"
    ok = run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-sseof",
            "-30",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-y",
            str(audio_path),
        ]
    )
    if ok and audio_path.exists():
        return str(audio_path)
    return None


def write_markdown(output_dir: Path, summary: dict) -> str:
    markdown_path = output_dir / "evidence.md"
    lines = [
        "# Video Evidence",
        "",
        f"- Source: `{summary['source']}`",
        f"- Project: `{summary['projectName']}`",
        f"- Project dir: `{summary['projectDir']}`",
        f"- Duration: `{summary['durationSeconds']}` seconds",
        f"- Size: `{summary['width']}x{summary['height']}`",
        f"- Requested frames: `{summary['requestedFrameCount']}`",
        f"- Extracted frames: `{summary['actualFrameCount']}`",
        f"- Overview sheets: `{len(summary['overviewSheets'])}`",
        f"- Max images per multimodal request: `{summary['maxImagesPerMultimodalRequest']}`",
        f"- Audio preview: `{summary['audioPreview'] or 'not generated'}`",
        f"- Tail audio preview: `{summary['audioTailPreview'] or 'not generated'}`",
        "",
        "## Codex UI Images",
        "",
    ]
    for image in summary["codexUiImages"]:
        lines.append(f"![{image['label']}]({image['path']})")
        lines.append("")
    lines.extend(
        [
            "",
            "## Overview Sheets",
            "",
        ]
    )
    for sheet in summary["overviewSheets"]:
        lines.append(
            f"- Sheet `{sheet['sheetIndex']}`: frames `{sheet['frameStartIndex']}`-`{sheet['frameEndIndex']}` "
            f"(`{sheet['frameCount']}` frames): `{sheet['path']}`"
        )
    lines.extend(
        [
            "",
            "## Overview Input Batches",
            "",
        ]
    )
    for batch in summary["overviewInputBatches"]:
        lines.append(
            f"- Batch `{batch['batchIndex']}`: `{batch['imageCount']}` images, sheets "
            f"`{batch['sheetIndexes']}`"
        )
    lines.extend(
        [
            "",
            "## Sampled Frames",
            "",
        ]
    )
    for frame in summary["frames"]:
        lines.append(f"- Frame `{frame['frameIndex']}` at `{frame['timestampSeconds']}` seconds: `{frame['path']}`")
    markdown_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(markdown_path)


def codex_ui_images(overview_sheets: list[dict]) -> list[dict]:
    images = []
    for sheet in overview_sheets:
        images.append(
            {
                "kind": "overview_sheet",
                "label": f"overview_{sheet['sheetIndex']:02d}",
                "path": sheet["path"],
            }
        )
    return images


def cached_summary(
    output_dir: Path,
    *,
    video_path: Path,
    video_fingerprint: str,
    frame_interval_seconds: float,
    max_duration_seconds: float,
    audio_requested: bool,
) -> dict | None:
    metadata_path = output_dir / "metadata.json"
    try:
        summary = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if summary.get("schemaVersion") != EVIDENCE_SCHEMA_VERSION:
        return None
    if summary.get("sourceFingerprint") != video_fingerprint:
        return None
    if float(summary.get("frameIntervalSeconds") or 0) != frame_interval_seconds:
        return None
    if float(summary.get("maxAnalyzeDurationSeconds") or 0) != max_duration_seconds:
        return None
    if not summary.get("overviewSheets"):
        return None

    required_paths = [sheet.get("path") for sheet in summary["overviewSheets"]]
    required_paths.extend(frame.get("path") for frame in summary.get("frames", []))
    if any(not path or not Path(path).is_file() for path in required_paths):
        return None
    if audio_requested:
        if not summary.get("audioPreviewRequested"):
            return None
        if summary.get("audioPreview") and not Path(summary["audioPreview"]).is_file():
            return None
        if summary.get("audioTailPreview") and not Path(summary["audioTailPreview"]).is_file():
            return None
    else:
        summary["audioPreviewRequested"] = False
        summary["audioPreviewStatus"] = "disabled"
        summary["audioPreview"] = None
        summary["audioTailPreview"] = None

    previous_source = summary.get("source")
    summary["source"] = str(video_path)
    summary["cachedFromSource"] = previous_source if previous_source != str(video_path) else None
    summary["evidenceCacheHit"] = True
    summary["codexUiImages"] = codex_ui_images(summary["overviewSheets"])
    metadata_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return summary


def clear_generated_evidence(output_dir: Path) -> None:
    for directory_name in ("frames", "overview_sheets", "overview_inputs"):
        target = output_dir / directory_name
        if target.is_dir():
            shutil.rmtree(target)
    for file_name in ("audio_preview.wav", "audio_tail_preview.wav", "evidence.md", "metadata.json"):
        target = output_dir / file_name
        if target.exists():
            target.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="Sample one video at a fixed interval into timestamped overview sheets.")
    parser.add_argument("video", nargs="?", help="Local video file path")
    parser.add_argument("--input", dest="input_video", help="Local video file path. Alias for the positional video argument.")
    parser.add_argument(
        "--output-dir",
        help="Output directory. Defaults to the content-addressed cache inside ~/novvy_ad_workplace/video-memory",
    )
    parser.add_argument("--frame-count", type=int, default=DEFAULT_FRAME_COUNT, help="Maximum uniformly sampled frames. Defaults to 20")
    parser.add_argument("--max-frames", type=int, default=0, help="Deprecated compatibility cap; when set, lowers --frame-count")
    parser.add_argument("--frame-interval-seconds", type=float, default=DEFAULT_FRAME_INTERVAL_SECONDS, help="Sample interval in seconds. Defaults to 5")
    parser.add_argument("--max-duration-seconds", type=float, default=DEFAULT_MAX_ANALYZE_SECONDS, help="Analyze only the first N seconds. Defaults to 900")
    parser.add_argument("--overview-frame-count", type=int, default=20, help="Frames per overview sheet. Defaults to 20")
    parser.add_argument("--audio-preview", dest="audio_preview", action="store_true", default=False, help="Optionally extract the first and final 30 seconds as 16 kHz mono wav. Disabled by default")
    parser.add_argument("--no-audio-preview", dest="audio_preview", action="store_false", help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args.video and args.input_video:
        parser.error("pass the video path either as the positional argument or with --input, not both")

    video_argument = args.input_video or args.video
    if not video_argument:
        parser.error("video path is required")

    video_path = Path(video_argument).expanduser().resolve()
    if not video_path.exists():
        print(f"Video file not found: {video_path}", file=sys.stderr)
        return 2
    if not video_path.is_file():
        print(f"Expected one video file, not a directory: {video_path}", file=sys.stderr)
        return 2

    requested_frame_count = max(args.frame_count, 1)
    if args.max_frames > 0:
        requested_frame_count = min(requested_frame_count, args.max_frames)
    requested_frame_count = min(requested_frame_count, DEFAULT_FRAME_COUNT)
    try:
        video_fingerprint = content_fingerprint(video_path)
        requested_output_dir = Path(args.output_dir) if args.output_dir else default_output_dir(video_fingerprint)
        output_dir = ensure_workspace_output(requested_output_dir, "Output directory")
        output_dir.mkdir(parents=True, exist_ok=True)
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        ffmpeg = require_binary("ffmpeg")
        ffprobe = require_binary("ffprobe")
        metadata = probe_video(ffprobe, video_path)
    except (RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    duration = parse_duration(metadata)
    stream = video_stream(metadata)
    cached = cached_summary(
        output_dir,
        video_path=video_path,
        video_fingerprint=video_fingerprint,
        frame_interval_seconds=args.frame_interval_seconds,
        max_duration_seconds=args.max_duration_seconds,
        audio_requested=args.audio_preview,
    )
    if cached is not None:
        print(json.dumps(cached, indent=2, ensure_ascii=False))
        return 0

    clear_generated_evidence(output_dir)
    timestamps = timestamps_for_interval(duration, args.frame_interval_seconds, args.max_duration_seconds)
    frames = extract_frames(ffmpeg, video_path, output_dir, timestamps)
    overview_sheets = make_overview_sheets(ffmpeg, frames, output_dir, max(args.overview_frame_count, 1))
    if not frames or not overview_sheets:
        print("Unable to extract video frames and create overview sheets", file=sys.stderr)
        return 1
    overview_batches = overview_input_batches(overview_sheets, 20)
    audio_preview = extract_audio_preview(ffmpeg, video_path, output_dir) if args.audio_preview else None
    audio_tail_preview = (
        extract_tail_audio_preview(ffmpeg, video_path, output_dir, duration) if args.audio_preview and audio_preview else None
    )
    project_dir = project_dir_for_output(output_dir)

    summary = {
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "source": str(video_path),
        "sourceFingerprint": video_fingerprint,
        "fingerprintStrategy": "sha256-size-head-middle-tail-1MiB",
        "evidenceCacheHit": False,
        "projectName": project_dir.name,
        "projectDir": str(project_dir),
        "outputDir": str(output_dir),
        "durationSeconds": round(duration, 3),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "avgFrameRate": stream.get("avg_frame_rate"),
        "samplingMode": "fixed_interval_first_900_seconds",
        "frameIntervalSeconds": args.frame_interval_seconds,
        "maxAnalyzeDurationSeconds": args.max_duration_seconds,
        "analyzedDurationSeconds": round(min(duration, args.max_duration_seconds), 3) if args.max_duration_seconds > 0 else round(duration, 3),
        "requestedFrameCount": len(timestamps),
        "actualFrameCount": len(frames),
        "overviewFrameCount": len(frames),
        "maxImagesPerMultimodalRequest": 20,
        "frames": frames,
        "overviewSheets": overview_sheets,
        "overviewInputBatches": overview_batches,
        "contactSheet": overview_sheets[0]["path"] if overview_sheets else None,
        "audioPreviewRequested": args.audio_preview,
        "audioPreviewStatus": "created" if audio_preview else "not_available" if args.audio_preview else "disabled",
        "audioPreview": audio_preview,
        "audioTailPreview": audio_tail_preview,
    }
    summary["codexUiImages"] = codex_ui_images(overview_sheets)
    summary["markdown"] = write_markdown(output_dir, summary)

    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
