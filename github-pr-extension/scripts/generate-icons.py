#!/usr/bin/env python3
"""Generate toolbar icons (green PR glyph on light rounded square). Requires Pillow."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (26, 127, 55)  # #1a7f37
BG = (246, 248, 250)  # #f6f8fa
BORDER = (208, 215, 222)


def rounded_rect(draw: ImageDraw.ImageDraw, xy: tuple, r: int, fill, outline=None, width=0):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)


def draw_pr(draw: ImageDraw.ImageDraw, s: int, margin_frac: float = 0.22) -> None:
    m = int(s * margin_frac)

    def sc(v: float) -> int:
        return m + int((s - 2 * m) * v / 16)

    r = max(1.5, (s - 2 * m) * 2.25 / 16)
    lw = max(1, int(s / 16))
    for cx, cy in [(4, 4), (4, 12), (12.75, 8)]:
        x, y = sc(cx), sc(cy)
        draw.ellipse([x - r, y - r, x + r, y + r], outline=GREEN, width=lw)
    x4, y4 = sc(4), sc(4)
    x4b, y12 = sc(4), sc(12)
    x6, y8 = sc(6.5), sc(8)
    x12, y8b = sc(12.25), sc(8)
    draw.line([x4, y4 + int(r), x4b, y12 - int(r)], fill=GREEN, width=lw)
    draw.line([x6 + int(r * 0.3), y8, x12 - int(r * 0.5), y8b], fill=GREEN, width=lw)


def make(size: int, path: Path) -> None:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    rr = max(2, size // 5)
    rounded_rect(draw, (0, 0, size - 1, size - 1), rr, BG)
    rounded_rect(draw, (0, 0, size - 1, size - 1), rr, None, outline=BORDER, width=1)
    draw_pr(draw, size)
    img.save(path, "PNG")


def main() -> None:
    root = Path(__file__).resolve().parents[1] / "icons"
    root.mkdir(parents=True, exist_ok=True)
    for n in (16, 32, 48, 128):
        make(n, root / f"icon{n}.png")
    print(f"Wrote icons to {root}")


if __name__ == "__main__":
    main()
