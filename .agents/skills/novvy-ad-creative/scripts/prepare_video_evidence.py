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
    return Path(__file__).resolve().parents[3]


PLUGIN_ROOT = plugin_root_from_script()
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))

from novvy_config import read_config, resolve_binary, workspace_dir  # noqa: E402


CONFIG = read_config()
EVIDENCE_SCHEMA_VERSION = 3
DEFAULT_FRAME_COUNT = 20
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
    """Return a stable, inexpensive fingerprint covering three file regions."""
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
    count = min(requested, max(1, math.ceil(duration)))
    end = max(duration - 0.1, 0.0)
    if count == 1:
        return [min(end / 2, end)]
    return [end * index / (count - 1) for index in range(count)]


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
        preview = output_dir / "audio_preview.wav"
        return str(preview) if preview.is_file() else None
    audio_path = output_dir / "audio_tail_preview.wav"
    ok = run([
        ffmpeg, "-hide_banner", "-loglevel", "error", "-sseof", "-30", "-i", str(video_path),
        "-vn", "-ac", "1", "-ar", "16000", "-y", str(audio_path),
    ])
    return str(audio_path) if ok and audio_path.exists() else None


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


def cached_summary(output_dir: Path, video_fingerprint: str, requested_frame_count: int, audio_requested: bool) -> dict | None:
    metadata_path = output_dir / "metadata.json"
    try:
        summary = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if summary.get("schemaVersion") != EVIDENCE_SCHEMA_VERSION:
        return None
    if summary.get("sourceFingerprint") != video_fingerprint or summary.get("requestedFrameCount") != requested_frame_count:
        return None
    required = [item.get("path") for item in summary.get("frames", []) + summary.get("overviewSheets", [])]
    if not required or any(not value or not Path(value).is_file() for value in required):
        return None
    if audio_requested and summary.get("audioPreview") and not Path(summary["audioPreview"]).is_file():
        return None
    summary["cacheHit"] = True
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare bounded video evidence for analysis.")
    parser.add_argument("video", nargs="?", help="Local video file path")
    parser.add_argument("--input", dest="input_video", help="Local video file path. Alias for the positional video argument.")
    parser.add_argument(
        "--output-dir",
        help="Output directory. Defaults to the content-addressed cache inside ~/novvy_ad_workplace/video-memory",
    )
    parser.add_argument("--frame-count", type=int, default=DEFAULT_FRAME_COUNT, help="Uniformly sample this many frames across the full video")
    parser.add_argument("--frame-interval-seconds", type=float, default=None, help="Deprecated compatibility option; use --frame-count")
    parser.add_argument("--overview-frame-count", type=int, default=20, help="Maximum frames per overview sheet")
    parser.add_argument("--max-frames", type=int, default=0, help="Optional hard cap for sampled frames. 0 means no cap")
    parser.add_argument("--audio-preview", dest="audio_preview", action="store_true", default=True, help="Extract first 30 seconds as 16 kHz mono wav. Enabled by default")
    parser.add_argument("--no-audio-preview", dest="audio_preview", action="store_false", help="Disable the default 30 second audio preview")
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

    requested_frame_count = max(args.max_frames or args.frame_count, 1)
    overview_frame_count = max(args.overview_frame_count, 1)
    video_fingerprint = content_fingerprint(video_path)
    try:
        requested_output_dir = Path(args.output_dir) if args.output_dir else default_output_dir(video_fingerprint)
        output_dir = ensure_workspace_output(requested_output_dir, "Output directory")
        output_dir.mkdir(parents=True, exist_ok=True)
    except (RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    cached = cached_summary(output_dir, video_fingerprint, requested_frame_count, args.audio_preview)
    if cached is not None:
        print(json.dumps(cached, indent=2, ensure_ascii=False))
        return 0

    try:
        ffmpeg = require_binary("ffmpeg")
        ffprobe = require_binary("ffprobe")
        metadata = probe_video(ffprobe, video_path)
    except (RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    duration = parse_duration(metadata)
    stream = video_stream(metadata)
    timestamps = timestamps_for(duration, requested_frame_count)
    frames = extract_frames(ffmpeg, video_path, output_dir, timestamps)
    overview_sheets = make_overview_sheets(ffmpeg, frames, output_dir, overview_frame_count)
    overview_batches = overview_input_batches(overview_sheets, 20)
    audio_preview = extract_audio_preview(ffmpeg, video_path, output_dir) if args.audio_preview else None
    audio_tail_preview = extract_tail_audio_preview(ffmpeg, video_path, output_dir, duration) if args.audio_preview else None
    project_dir = project_dir_for_output(output_dir)

    summary = {
        "schemaVersion": EVIDENCE_SCHEMA_VERSION,
        "cacheHit": False,
        "sourceFingerprint": video_fingerprint,
        "source": str(video_path),
        "projectName": project_dir.name,
        "projectDir": str(project_dir),
        "outputDir": str(output_dir),
        "durationSeconds": round(duration, 3),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "avgFrameRate": stream.get("avg_frame_rate"),
        "requestedFrameCount": requested_frame_count,
        "actualFrameCount": len(frames),
        "overviewFrameCount": overview_frame_count,
        "maxImagesPerMultimodalRequest": 20,
        "frames": frames,
        "overviewSheets": overview_sheets,
        "overviewInputBatches": overview_batches,
        "contactSheet": overview_sheets[0]["path"] if overview_sheets else None,
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
