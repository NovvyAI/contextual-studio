from pathlib import Path
import sys

from PIL import Image


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: convert-image-to-png.py INPUT OUTPUT")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    with Image.open(source) as image:
        image.convert("RGBA").save(output, format="PNG")


if __name__ == "__main__":
    main()
