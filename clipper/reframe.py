"""Work out where to point a 9:16 crop: follow whoever is talking, or fall back to a blurred fit."""
import cv2
import numpy as np

from . import config

SAMPLES_PER_SEC = 6
DETECT_WIDTH = 640
MIN_FACE_FRAC = 0.06      # faces narrower than this share of the frame are ignored (crowds, facecams)
SWITCH_HOLD = 1.2         # seconds to stay on a speaker before allowing a switch
SWITCH_MARGIN = 1.35      # new speaker must be this much more active to steal focus


class Track:
    def __init__(self, tid, cx, cy, w, t):
        self.id, self.cx, self.cy, self.w, self.last_t = tid, cx, cy, w, t
        self.mouth = None
        self.activity = 0.0


def _mouth_patch(gray, f):
    """Small grayscale patch around the mouth from YuNet landmarks (scaled frame coords)."""
    x, y, w, h = f[:4]
    rmx, rmy, lmx, lmy = f[10], f[11], f[12], f[13]
    cx, cy = (rmx + lmx) / 2, (rmy + lmy) / 2
    half_w = max(abs(lmx - rmx) * 0.8, w * 0.2)
    x0, x1 = int(cx - half_w), int(cx + half_w)
    y0, y1 = int(cy - h * 0.12), int(cy + h * 0.22)
    H, W = gray.shape
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    patch = cv2.resize(gray[y0:y1, x0:x1], (32, 20)).astype(np.float32)
    return (patch - patch.mean()) / (patch.std() + 1e-3)


def analyze(video_path, layout="auto", ctx=None):
    """Returns dict(mode, xs per frame or None, fps, n, W, H)."""
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    crop_w = int(round(H * config.OUT_W / config.OUT_H))
    base = {"fps": fps, "n": n, "W": W, "H": H, "crop_w": crop_w}

    if crop_w >= W or layout == "fit":
        cap.release()
        return {**base, "mode": "fit", "xs": None}
    if layout == "center":
        cap.release()
        return {**base, "mode": "track", "xs": [W / 2] * max(n, 1)}

    scale = DETECT_WIDTH / W
    dw, dh = DETECT_WIDTH, int(round(H * scale))
    det = cv2.FaceDetectorYN.create(str(config.FACE_MODEL), "", (dw, dh), 0.7, 0.3, 50)
    det.setInputSize((dw, dh))

    step = max(1, int(round(fps / SAMPLES_PER_SEC)))
    tracks, next_id = [], 0
    samples = []          # (frame_idx, target_x or None, track_id)
    focus, focus_since = None, -1e9
    with_face = 0
    idx = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if idx % step:
            idx += 1
            continue
        ok, frame = cap.retrieve()
        if not ok:
            break
        t = idx / fps
        small = cv2.resize(frame, (dw, dh))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        _, faces = det.detect(small)
        faces = [] if faces is None else [f for f in faces if f[2] >= MIN_FACE_FRAC * dw]

        # Match detections to tracks by nearest center.
        seen = []
        for f in sorted(faces, key=lambda f: -f[2]):
            cx, cy, w = f[0] + f[2] / 2, f[1] + f[3] / 2, f[2]
            best, best_d = None, 0.6 * w
            for tr in tracks:
                if tr in seen:
                    continue
                d = abs(tr.cx - cx) + abs(tr.cy - cy)
                if d < best_d:
                    best, best_d = tr, d
            if best is None:
                best = Track(next_id, cx, cy, w, t)
                next_id += 1
                tracks.append(best)
            best.cx, best.cy, best.w, best.last_t = cx, cy, w, t
            patch = _mouth_patch(gray, f)
            if patch is not None and best.mouth is not None:
                motion = float(np.abs(patch - best.mouth).mean())
                best.activity = 0.7 * best.activity + 0.3 * motion
            best.mouth = patch
            seen.append(best)
        tracks = [tr for tr in tracks if t - tr.last_t < 1.0]

        target, tid = None, None
        if seen:
            with_face += 1
            left = min(tr.cx - tr.w for tr in seen)
            right = max(tr.cx + tr.w for tr in seen)
            if len(seen) > 1 and (right - left) / scale <= 0.9 * crop_w:
                target, tid = (left + right) / 2, -1   # everyone fits, frame the group
            else:
                cur = next((tr for tr in seen if tr.id == focus), None)
                loudest = max(seen, key=lambda tr: tr.activity)
                if cur is None:
                    cur = loudest
                    focus, focus_since = cur.id, t
                elif (loudest is not cur and t - focus_since >= SWITCH_HOLD
                      and loudest.activity > cur.activity * SWITCH_MARGIN):
                    cur = loudest
                    focus, focus_since = cur.id, t
                target, tid = cur.cx, cur.id
        samples.append((idx, None if target is None else target / scale, tid))
        if ctx and len(samples) % 30 == 0:
            ctx.check()
        idx += 1
    cap.release()
    n = max(n, idx)
    base["n"] = n

    if layout == "auto" and (not samples or with_face / len(samples) < 0.4):
        return {**base, "mode": "fit", "xs": None}

    return {**base, "mode": "track", "xs": _smooth(samples, n, W, crop_w, fps)}


def _smooth(samples, n, W, crop_w, fps):
    """Per-frame crop centers: hold still inside a dead zone, ease toward the target, hard-cut on speaker switches."""
    lo, hi = crop_w / 2, W - crop_w / 2
    first = next((x for _, x, _ in samples if x is not None), W / 2)
    raw, ids = [first] * n, [None] * n
    last_x, last_id = first, None
    si = 0
    for f in range(n):
        while si < len(samples) and samples[si][0] <= f:
            if samples[si][1] is not None:
                last_x, last_id = samples[si][1], samples[si][2]
            si += 1
        raw[f], ids[f] = last_x, last_id

    dead = 0.06 * crop_w
    alpha = min(0.25, 6.0 / fps)
    xs, x, prev_id = [], raw[0], ids[0]
    for f in range(n):
        target = raw[f]
        if ids[f] != prev_id and abs(target - x) > 0.3 * crop_w:
            x = target
        elif abs(target - x) > dead:
            x += (target - x) * alpha
        prev_id = ids[f]
        xs.append(min(hi, max(lo, x)))
    return xs
