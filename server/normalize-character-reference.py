from pathlib import Path
import sys

from PIL import Image, ImageOps


MIN_WIDTH = 300


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: normalize-character-reference.py INPUT OUTPUT")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        if width < MIN_WIDTH:
            scale = MIN_WIDTH / width
            image = image.resize((MIN_WIDTH, max(1, round(height * scale))), Image.Resampling.LANCZOS)
        image.convert("RGB").save(output, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
