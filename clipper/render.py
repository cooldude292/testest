"""Cut a moment out, reframe it to 9:16, burn captions, encode."""
import subprocess

import cv2
import numpy as np

from . import captions, config, reframe
from .util import ffmpeg


def _encoder_args():
    if config.IS_APPLE_SILICON:
        return ["-c:v", "h264_videotoolbox", "-b:v", "10M"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]


def has_audio(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    return bool(out.stdout.strip())


def cut_segment(src, start, end, out):
    ffmpeg("-ss", f"{start:.3f}", "-i", src, "-t", f"{end-start:.3f}",
           "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=-2:'min(1080,ih)'",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", "-b:a", "192k", out)


def _blur_bg(frame):
    """Darkened, blurred copy of the frame zoomed to cover the whole 9:16 canvas."""
    OW, OH = config.OUT_W, config.OUT_H
    h, w = frame.shape[:2]
    cover = max(OW / w, OH / h)
    bw, bh = int(w * cover + 0.5), int(h * cover + 0.5)
    small = cv2.resize(frame, (max(1, bw // 10), max(1, bh // 10)), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), 4)
    bg = cv2.resize(small, (bw, bh), interpolation=cv2.INTER_LINEAR)
    x0, y0 = (bw - OW) // 2, (bh - OH) // 2
    return (bg[y0:y0 + OH, x0:x0 + OW] * 0.55).astype(np.uint8)


def _fit_frame(frame):
    """Whole frame centered on a blurred, zoomed copy of itself."""
    OW, OH = config.OUT_W, config.OUT_H
    h, w = frame.shape[:2]
    bg = _blur_bg(frame)
    fit = min(OW / w, OH / h)
    fw, fh = int(w * fit) // 2 * 2, int(h * fit) // 2 * 2
    fg = cv2.resize(frame, (fw, fh), interpolation=cv2.INTER_AREA)
    ox, oy = (OW - fw) // 2, (OH - fh) // 2
    bg[oy:oy + fh, ox:ox + fw] = fg
    return bg


def _zoom_frame(frame):
    """Middle of the gameplay, big, on a blurred background."""
    OW, OH = config.OUT_W, config.OUT_H
    h, w = frame.shape[:2]
    cw = min(w, int(h * reframe.ZOOM_ASPECT))
    x0 = (w - cw) // 2
    th = int(OW / reframe.ZOOM_ASPECT) // 2 * 2
    fg = cv2.resize(frame[:, x0:x0 + cw], (OW, th), interpolation=cv2.INTER_LINEAR)
    bg = _blur_bg(frame)
    oy = (OH - th) // 2
    bg[oy:oy + th] = fg
    return bg


def _split_frame(frame, cam):
    """Facecam on top, middle of the gameplay underneath."""
    OW, OH, TOP = config.OUT_W, config.OUT_H, reframe.SPLIT_TOP
    h, w = frame.shape[:2]
    x, y, cw_, ch_ = cam
    top = cv2.resize(frame[y:y + ch_, x:x + cw_], (OW, TOP), interpolation=cv2.INTER_LINEAR)
    bh = OH - TOP
    gw = min(w, int(h * OW / bh))
    gx = (w - gw) // 2
    bottom = cv2.resize(frame[:, gx:gx + gw], (OW, bh), interpolation=cv2.INTER_LINEAR)
    return np.vstack([top, bottom])


def render_clip(src, words, clip, out_path, work_dir, layout, ctx, label):
    seg = work_dir / f"{out_path.stem}_seg.mp4"
    ctx.stage("render", None, f"{label}: cutting")
    cut_segment(src, clip["start"], clip["end"], seg)

    ctx.stage("render", None, f"{label}: finding faces")
    plan = reframe.analyze(seg, layout, ctx)
    clip["layout"] = plan["mode"]
    caps = captions.Captions(words, clip["start"], clip["end"], clip.get("hook", ""), plan["mode"])

    OW, OH = config.OUT_W, config.OUT_H
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{OW}x{OH}", "-r", f"{plan['fps']:.5f}", "-i", "-",
           "-i", str(seg), "-map", "0:v"]
    if has_audio(seg):
        cmd += ["-map", "1:a", "-c:a", "copy"]
    cmd += [*_encoder_args(), "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", "-shortest", str(out_path)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    cap = cv2.VideoCapture(str(seg))
    n, xs, cw = plan["n"], plan["xs"], plan["crop_w"]
    i = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if plan["mode"] == "fit":
                out = _fit_frame(frame)
            elif plan["mode"] == "zoom":
                out = _zoom_frame(frame)
            elif plan["mode"] == "split":
                out = _split_frame(frame, plan["facecam"])
            else:
                x = xs[min(i, len(xs) - 1)]
                x0 = int(round(x - cw / 2))
                x0 = max(0, min(frame.shape[1] - cw, x0))
                out = cv2.resize(frame[:, x0:x0 + cw], (OW, OH), interpolation=cv2.INTER_LINEAR)
            caps.apply(out, i / plan["fps"])
            proc.stdin.write(out.tobytes())
            i += 1
            if i % 15 == 0:
                ctx.stage("render", i / max(n, 1), f"{label}: rendering {plan['mode']} ({i}/{n} frames)")
                ctx.check()
    finally:
        cap.release()
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        err = proc.stderr.read().decode(errors="ignore")
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {err[-800:]}")
    seg.unlink(missing_ok=True)
