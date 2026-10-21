"""Draws the Clipworks app icon and writes a macOS .iconset folder (iconutil turns it into .icns)."""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


def draw(size=1024):
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    # macOS icon grid: ~824px rounded square centered in 1024
    pad, r = int(s * 0.098), int(s * 0.18)
    box = (pad, pad, s - pad, s - pad)
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((box[0], box[1] + s * 0.012, box[2], box[3] + s * 0.012), r, fill=(0, 0, 0, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(s * 0.012)))
    grad = Image.new("RGBA", (s, s))
    top, bot = (63, 112, 242), (24, 52, 160)
    for y in range(s):
        t = y / s
        ImageDraw.Draw(grad).line([(0, y), (s, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bot)) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, r, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    # three bars, like a cut list
    x0 = int(s * 0.29)
    for i, frac in enumerate((0.42, 0.27, 0.34)):
        y = int(s * (0.36 + i * 0.12))
        h = int(s * 0.062)
        d.rounded_rectangle((x0, y, x0 + int(s * frac), y + h), h // 2, fill=(255, 255, 255, 245 - i * 30))
    return img


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "build/Clipworks.iconset")
    out.mkdir(parents=True, exist_ok=True)
    big = draw(1024)
    for px in (16, 32, 128, 256, 512):
        big.resize((px, px), Image.LANCZOS).save(out / f"icon_{px}x{px}.png")
        big.resize((px * 2, px * 2), Image.LANCZOS).save(out / f"icon_{px}x{px}@2x.png")
    big.save(out.parent / "icon_1024.png")
