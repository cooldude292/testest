"""Word-by-word highlighted captions and a hook title, drawn straight onto frames.

Done with Pillow instead of ffmpeg subtitles so it doesn't matter whether the
local ffmpeg was built with libass.
"""
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import config

FONT_PATH = Path(__file__).parent / "fonts" / "Montserrat.ttf"
CAP_SIZE = 78
HIGHLIGHT_SCALE = 1.12
CAP_TOP = 1300
HOOK_TOP = 230
SPLIT_SEAM = 640
MAX_TEXT_W = 960
WHITE = (255, 255, 255)
YELLOW = (255, 215, 0)
BLACK = (0, 0, 0)


def _font(size, weight="Black"):
    f = ImageFont.truetype(str(FONT_PATH), size)
    try:
        f.set_variation_by_name(weight)
    except Exception:
        pass
    return f


def _clean(word):
    w = word.strip().upper()
    return re.sub(r"^[\"'(\[]+|[\"',.;:)\]]+$", "", w)


def _chunks(words, max_words=3, max_chars=16):
    out, cur = [], []
    for w in words:
        if cur and (len(cur) >= max_words
                    or sum(len(x["t"]) + 1 for x in cur) + len(w["t"]) > max_chars
                    or w["s"] - cur[-1]["e"] > 0.4):
            out.append(cur)
            cur = []
        cur.append(w)
        if w["raw"].strip()[-1:] in ".?!,":
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def _to_bgra(img):
    a = np.asarray(img)
    return np.ascontiguousarray(a[..., [2, 1, 0, 3]])


def _blend(frame, ov, x, y):
    h, w = ov.shape[:2]
    H, W = frame.shape[:2]
    if y >= H or x >= W:
        return
    h, w = min(h, H - y), min(w, W - x)
    region = frame[y:y + h, x:x + w].astype(np.float32)
    a = ov[:h, :w, 3:4].astype(np.float32) / 255.0
    frame[y:y + h, x:x + w] = (region * (1 - a) + ov[:h, :w, :3] * a).astype(np.uint8)


class Captions:
    def __init__(self, words, clip_start, clip_end, hook="", layout="track"):
        # Split layout has a face in the top pane, so the hook sits on the seam instead.
        self.split = layout == "split"
        self.cap_top = 1420 if self.split else CAP_TOP
        dur = clip_end - clip_start
        local = []
        for w in words:
            if w["e"] < clip_start or w["s"] > clip_end:
                continue
            t = _clean(w["w"])
            if t:
                local.append({"t": t, "raw": w["w"], "s": max(0.0, w["s"] - clip_start),
                              "e": min(dur, w["e"] - clip_start)})

        self.events = []  # (start, end, [words], highlighted index)
        chunks = _chunks(local)
        for ci, ch in enumerate(chunks):
            chunk_end = ch[-1]["e"]
            if ci + 1 < len(chunks) and chunks[ci + 1][0]["s"] - chunk_end < 0.5:
                chunk_end = chunks[ci + 1][0]["s"]  # no flicker between close chunks
            for wi, w in enumerate(ch):
                end = ch[wi + 1]["s"] if wi + 1 < len(ch) else chunk_end
                self.events.append((w["s"], max(end, w["s"] + 0.05), [x["t"] for x in ch], wi))

        self.font = _font(CAP_SIZE)
        self.font_hi = _font(int(CAP_SIZE * HIGHLIGHT_SCALE))
        self.cache = {}
        self.ptr = 0
        self.hook = self._render_hook(hook) if hook else None

    def _render_hook(self, text):
        font = _font(56, "ExtraBold")
        words, lines, cur = text.split(), [], ""
        for w in words:
            trial = f"{cur} {w}".strip()
            if cur and font.getlength(trial) > MAX_TEXT_W - 80:
                lines.append(cur)
                cur = w
            else:
                cur = trial
        if cur:
            lines.append(cur)
        lh = 70
        pad = 28
        tw = int(max(font.getlength(ln) for ln in lines))
        bw, bh = tw + pad * 2, lh * len(lines) + pad * 2 - 6
        img = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((0, 0, bw - 1, bh - 1), radius=22, fill=WHITE + (255,))
        for i, ln in enumerate(lines):
            x = (bw - font.getlength(ln)) / 2
            d.text((x, pad + i * lh), ln, font=font, fill=BLACK + (255,))
        y = SPLIT_SEAM - bh // 2 if self.split else HOOK_TOP
        return _to_bgra(img), (config.OUT_W - bw) // 2, y

    def _render_event(self, words, hi):
        space = self.font.getlength(" ")
        widths = [(self.font_hi if i == hi else self.font).getlength(w) for i, w in enumerate(words)]
        # Greedy wrap in case a chunk is too wide for one line.
        lines, cur, cur_w = [], [], 0.0
        for i, w in enumerate(widths):
            add = w if not cur else cur_w + space + w
            if cur and add > MAX_TEXT_W:
                lines.append((cur, cur_w))
                cur, cur_w = [i], w
            else:
                cur, cur_w = cur + [i], add
        lines.append((cur, cur_w))
        lh = int(CAP_SIZE * 1.25)
        stroke = 8
        h = lh * len(lines) + 40
        img = Image.new("RGBA", (config.OUT_W, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        for li, (idxs, lw) in enumerate(lines):
            x = (config.OUT_W - lw) / 2
            base = 20 + li * lh + int(CAP_SIZE * 0.9)
            for i in idxs:
                f = self.font_hi if i == hi else self.font
                d.text((x, base), words[i], font=f, anchor="ls",
                       fill=(YELLOW if i == hi else WHITE) + (255,),
                       stroke_width=stroke, stroke_fill=BLACK + (255,))
                x += widths[i] + space
        return _to_bgra(img)

    def apply(self, frame, t):
        """Draw onto a BGR frame (OUT_W x OUT_H) in place. t must not go backwards."""
        if self.hook is not None:
            ov, x, y = self.hook
            _blend(frame, ov, x, y)
        while self.ptr < len(self.events) and self.events[self.ptr][1] <= t:
            self.ptr += 1
        if self.ptr < len(self.events):
            s, e, words, hi = self.events[self.ptr]
            if s <= t < e:
                ov = self.cache.get(self.ptr)
                if ov is None:
                    ov = self.cache[self.ptr] = self._render_event(words, hi)
                _blend(frame, ov, 0, self.cap_top)
