#!/usr/bin/env python3
"""Generate extension toolbar icons: green merge/branch motif on light rounded square."""

from __future__ import annotations

import math
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("Install Pillow: pip install pillow", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "icons"
SIZES = (16, 32, 48, 128)

# GitHub-ish green on very light background
BG = (250, 251, 252, 255)
GREEN = (26, 127, 55, 255)  # #1a7f37
GREEN_LIGHT = (46, 160, 67, 255)


def draw_icon(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = max(1, round(size * 0.08))
    corner = max(2, round(size * 0.22))
    draw.rounded_rectangle(
        [pad, pad, size - pad, size - pad],
        radius=corner,
        fill=BG,
        outline=GREEN,
        width=max(1, round(size / 32)),
    )

    cx = size * 0.5
    cy = size * 0.48
    w = size * 0.42
    stroke = max(1.5, size * 0.09)

    def line_fr(xy: list[tuple[float, float]], fill, width_: float) -> None:
        draw.line(xy, fill=fill, width=max(1, int(round(width_))))

    # Left branch up-left
    line_fr(
        [
            (cx - w * 0.35, cy - w * 0.42),
            (cx - w * 0.12, cy - w * 0.08),
            (cx, cy),
        ],
        GREEN,
        stroke,
    )
    # Right branch up-right
    line_fr(
        [
            (cx + w * 0.35, cy - w * 0.42),
            (cx + w * 0.12, cy - w * 0.08),
            (cx, cy),
        ],
        GREEN_LIGHT,
        stroke * 0.92,
    )
    # Stem down (merge into trunk)
    stem_h = w * 0.52
    line_fr(
        [(cx, cy), (cx, cy + stem_h)],
        GREEN,
        stroke * 1.05,
    )
    # Small merge node
    r = max(1.0, size * 0.055)
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=GREEN,
    )
    return img


def main() -> None:
    ICONS.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        im = draw_icon(s)
        path = ICONS / f"icon{s}.png"
        im.save(path, "PNG", optimize=True)
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
