#!/usr/bin/env python3
"""Compose protagonist view references and an optional final card into one PNG panel."""

import argparse
import json
import math
import mimetypes
import os
import sys
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path


def plugin_root_from_script() -> Path:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").exists():
            return parent
    return Path(__file__).resolve().parents[1]


PLUGIN_ROOT = plugin_root_from_script()
sys.path.insert(0, str(PLUGIN_ROOT / "scripts"))

from novvy_config import workspace_dir  # noqa: E402

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps, UnidentifiedImageError
except ModuleNotFoundError:
    bundled_python = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
    if bundled_python.exists() and Path(sys.executable).resolve() != bundled_python.resolve():
        os.execv(str(bundled_python), [str(bundled_python), *sys.argv])
    raise


SLOTS = [
    ("male_front", "Male front"),
    ("male_side", "Male side"),
    ("female_front", "Female front"),
    ("female_side", "Female side"),
]
FINAL_CARD_SLOT = ("final_card", "Final card")


def is_http_url(source: str) -> bool:
    return source.lower().startswith(("http://", "https://"))


def ensure_workspace_output(path: Path, label: str) -> Path:
    resolved = path.expanduser().resolve()
    root = workspace_dir().expanduser().resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"{label} must be inside Novvy workspace: {root}") from exc
    return resolved


def read_source(source: str, max_bytes: int) -> tuple[bytes, str]:
    if is_http_url(source):
        request = urllib.request.Request(source, headers={"User-Agent": "Codex Novvy reference panel"})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read(max_bytes + 1)
            content_type = response.headers.get_content_type() or "image/png"
        if len(data) > max_bytes:
            raise ValueError(f"Remote image is too large: {source}")
        return data, content_type

    path = Path(source).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if not path.is_file():
        raise ValueError(f"Not a file: {path}")
    if path.stat().st_size > max_bytes:
        raise ValueError(f"Local image is too large: {path}")
    mime_type = mimetypes.guess_type(str(path))[0] or "image/png"
    return path.read_bytes(), mime_type


def load_image(source: str, max_bytes: int) -> tuple[Image.Image, str]:
    data, mime_type = read_source(source, max_bytes)
    try:
        image = Image.open(BytesIO(data))
        image.load()
    except UnidentifiedImageError as exc:
        raise ValueError(f"Unsupported or unreadable image: {source}") from exc

    if image.mode in ("RGBA", "LA"):
        background = Image.new("RGBA", image.size, (255, 255, 255, 255))
        background.alpha_composite(image.convert("RGBA"))
        image = background.convert("RGB")
    else:
        image = image.convert("RGB")

    return image, mime_type


def font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def source_name(source: str) -> str:
    if is_http_url(source):
        parsed = urllib.parse.urlparse(source)
        return Path(parsed.path).name or parsed.netloc
    return Path(source).expanduser().name


def draw_label(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], text: str) -> None:
    label_font = font(24)
    x1, y1, x2, y2 = box
    draw.rectangle((x1, y1, x2, y2), fill=(17, 24, 39))
    draw.text((x1 + 14, y1 + 10), text, fill=(255, 255, 255), font=label_font)


def paste_contained(canvas: Image.Image, image: Image.Image, box: tuple[int, int, int, int]) -> None:
    x1, y1, x2, y2 = box
    contained = ImageOps.contain(image, (x2 - x1, y2 - y1), method=Image.Resampling.LANCZOS)
    px = x1 + ((x2 - x1) - contained.width) // 2
    py = y1 + ((y2 - y1) - contained.height) // 2
    canvas.paste(contained, (px, py))


def compose_panel(slot_sources: dict[str, str], output_path: Path, max_bytes: int) -> dict:
    tile_w = 420
    image_h = 450
    label_h = 52
    gap = 22
    margin = 30
    columns = 3
    slots = [*SLOTS]
    if slot_sources.get("final_card"):
        slots.append(FINAL_CARD_SLOT)
    include_note = "final_card" not in slot_sources
    rows = math.ceil((len(slots) + (1 if include_note else 0)) / columns)
    tile_h = image_h + label_h
    width = margin * 2 + columns * tile_w + (columns - 1) * gap
    height = margin * 2 + rows * tile_h + (rows - 1) * gap
    canvas = Image.new("RGB", (width, height), (245, 247, 250))
    draw = ImageDraw.Draw(canvas)
    body_font = font(18)

    slot_outputs = []
    for index, (slot, label) in enumerate(slots):
        row = index // columns
        col = index % columns
        x1 = margin + col * (tile_w + gap)
        y1 = margin + row * (tile_h + gap)
        x2 = x1 + tile_w
        y2 = y1 + tile_h
        draw.rounded_rectangle((x1, y1, x2, y2), radius=12, fill=(255, 255, 255), outline=(210, 214, 220), width=2)
        draw_label(draw, (x1, y1, x2, y1 + label_h), label)
        image, mime_type = load_image(slot_sources[slot], max_bytes)
        paste_contained(canvas, image, (x1 + 12, y1 + label_h + 12, x2 - 12, y2 - 12))
        slot_outputs.append(
            {
                "slot": slot,
                "label": label,
                "source": slot_sources[slot],
                "sourceName": source_name(slot_sources[slot]),
                "sourceMimeType": mime_type,
            }
        )

    if include_note:
        blank_index = len(slots)
        row = blank_index // columns
        col = blank_index % columns
        x1 = margin + col * (tile_w + gap)
        y1 = margin + row * (tile_h + gap)
        x2 = x1 + tile_w
        y2 = y1 + tile_h
        draw.rounded_rectangle((x1, y1, x2, y2), radius=12, fill=(255, 255, 255), outline=(210, 214, 220), width=2)
        draw_label(draw, (x1, y1, x2, y1 + label_h), "Video prompt note")
        note = "Use this panel as the single video reference.\nKeep characters consistent.\nKeep final card readable."
        draw.multiline_text((x1 + 22, y1 + label_h + 36), note, fill=(55, 65, 81), font=body_font, spacing=8)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, format="PNG", optimize=True)
    return {
        "path": str(output_path),
        "fileName": output_path.name,
        "mimeType": "image/png",
        "slots": slot_outputs,
        "uploadInput": {
            "path": str(output_path),
            "script": 'SKILL_DIR="<novvy-ad-creative skill root>"; NOVVY_PYTHON_BIN="$("$SKILL_DIR/scripts/novvy_python.sh")" && "$NOVVY_PYTHON_BIN" "$SKILL_DIR/scripts/upload_ai_platform_asset.py"',
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compose a Novvy video reference panel from confirmed images.")
    parser.add_argument("--male-front", required=True, help="Male protagonist front-view image path or URL")
    parser.add_argument("--male-side", required=True, help="Male protagonist side-view image path or URL")
    parser.add_argument("--female-front", required=True, help="Female protagonist front-view image path or URL")
    parser.add_argument("--female-side", required=True, help="Female protagonist side-view image path or URL")
    parser.add_argument("--final-card", help="Approved final landing card image path or URL")
    parser.add_argument(
        "--output",
        default=str(workspace_dir() / "reference-panel.png"),
        help="Output PNG path. Defaults to ~/novvy_ad_workplace/reference-panel.png",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=25 * 1024 * 1024,
        help="Maximum bytes per input image. Defaults to 25 MiB.",
    )
    args = parser.parse_args()

    slot_sources = {
        "male_front": args.male_front,
        "male_side": args.male_side,
        "female_front": args.female_front,
        "female_side": args.female_side,
    }
    if args.final_card:
        slot_sources["final_card"] = args.final_card

    try:
        output_path = ensure_workspace_output(Path(args.output), "Output file")
        reference_panel = compose_panel(slot_sources, output_path, args.max_bytes)
    except (OSError, ValueError, FileNotFoundError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps({"referencePanel": reference_panel}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
