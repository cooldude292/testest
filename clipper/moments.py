"""Ask the local LLM which parts of the transcript would make good short clips."""
import json
import re

import requests

from . import config

WINDOW_SECONDS = 480
OVERLAP_SECONDS = 60

SYSTEM = (
    "You are a top short-form video editor. You find the moments in long videos that "
    "go viral as standalone TikToks, YouTube Shorts and Reels. You are picky."
)

PROMPT = """Below is a transcript excerpt. Each line is: [line_id] (mm:ss) text

Find up to {k} moments that work as standalone vertical clips of {min_len}-{max_len} seconds.

A great clip:
- Makes sense with zero context. No "he said that", no references to things explained earlier.
- Starts on a strong line: a bold claim, a question, tension, or a story opening. Never starts mid-thought or on filler like "so yeah" or "anyway".
- Has a payoff: a punchline, a surprising fact, a hot take, conflict, emotion, or a story that resolves.
- Ends right after the payoff instead of trailing off.
Skip intros, outros, sponsor reads, housekeeping and rambling.

For each clip give:
- start_line and end_line (inclusive line ids from the transcript)
- title: max 8 words
- hook: on-screen text for the top of the video, max 10 words, punchy, makes people stay. No emojis, no hashtags.
- score: virality 0-100. Be harsh. Most moments are under 60.
- reason: one sentence on why it works

If nothing here is good, return an empty list.

TRANSCRIPT:
{transcript}"""

SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_line": {"type": "integer"},
                    "end_line": {"type": "integer"},
                    "title": {"type": "string"},
                    "hook": {"type": "string"},
                    "score": {"type": "integer"},
                    "reason": {"type": "string"},
                },
                "required": ["start_line", "end_line", "title", "hook", "score", "reason"],
            },
        }
    },
    "required": ["clips"],
}


def build_lines(words, max_len=12.0, gap=0.8):
    """Group words into sentence-ish lines the LLM can point at."""
    lines, cur = [], []

    def flush():
        if cur:
            lines.append({
                "start": cur[0]["s"],
                "end": cur[-1]["e"],
                "text": "".join(w["w"] for w in cur).strip(),
            })
            cur.clear()

    for w in words:
        if cur and (w["s"] - cur[-1]["e"] > gap or w["e"] - cur[0]["s"] > max_len):
            flush()
        cur.append(w)
        if w["w"].strip()[-1:] in ".?!" and cur[-1]["e"] - cur[0]["s"] > 2.0:
            flush()
    flush()
    for i, ln in enumerate(lines):
        ln["i"] = i
    return lines


def windows(lines):
    """Overlapping chunks of lines, each about WINDOW_SECONDS long."""
    out, s = [], 0
    while s < len(lines):
        e = s
        while e < len(lines) and lines[e]["end"] - lines[s]["start"] < WINDOW_SECONDS:
            e += 1
        e = max(e, s + 1)
        out.append((s, e))
        if e >= len(lines):
            break
        nxt = e
        while nxt > s + 1 and lines[nxt - 1]["start"] > lines[e - 1]["end"] - OVERLAP_SECONDS:
            nxt -= 1
        s = max(nxt, s + 1)
    return out


def _mmss(t):
    t = int(t)
    return f"{t//3600}:{t%3600//60:02d}:{t%60:02d}" if t >= 3600 else f"{t//60:02d}:{t%60:02d}"


def ask_llm(prompt):
    body = {
        "model": config.LLM_MODEL,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "stream": False,
        "format": SCHEMA,
        "think": False,
        "keep_alive": "15m",
        "options": {"temperature": 0.3, "num_ctx": config.LLM_CONTEXT, "num_predict": 3000},
    }
    r = requests.post(f"{config.OLLAMA_URL}/api/chat", json=body, timeout=900)
    if r.status_code == 400 and "think" in r.text:
        body.pop("think")
        r = requests.post(f"{config.OLLAMA_URL}/api/chat", json=body, timeout=900)
    r.raise_for_status()
    content = r.json()["message"]["content"]
    return parse_json(content)


def parse_json(text):
    text = text.strip()
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    # Broken or cut-off JSON: keep whichever individual clip objects still parse.
    clips = []
    for m in re.finditer(r"\{[^{}]*\}", text):
        try:
            obj = json.loads(m.group(0))
        except json.JSONDecodeError:
            continue
        if "start_line" in obj:
            clips.append(obj)
    if not clips:
        raise ValueError("LLM reply wasn't usable JSON")
    return {"clips": clips}


def fit_length(lines, s, e, min_len, max_len):
    """Nudge a [s, e] line range so the clip lands inside the length limits."""
    while lines[e]["end"] - lines[s]["start"] < min_len and e + 1 < len(lines):
        if lines[e + 1]["end"] - lines[s]["start"] > max_len:
            break
        e += 1
    while lines[e]["end"] - lines[s]["start"] > max_len and e > s:
        e -= 1
    return s, e


def find_moments(words, max_clips, min_len, max_len, ctx):
    lines = build_lines(words)
    if not lines:
        return []
    wins = windows(lines)
    per_window = max(2, min(5, max_clips))
    candidates = []
    for n, (s, e) in enumerate(wins):
        ctx.check()
        ctx.stage("moments", n / len(wins), f"Asking {config.LLM_MODEL} about part {n+1} of {len(wins)}")
        transcript = "\n".join(f"[{ln['i']}] ({_mmss(ln['start'])}) {ln['text']}" for ln in lines[s:e])
        prompt = PROMPT.format(k=per_window, min_len=min_len, max_len=max_len, transcript=transcript)
        picks = None
        for attempt in (1, 2):
            try:
                picks = ask_llm(prompt).get("clips", [])
                break
            except Exception as ex:  # one bad window shouldn't kill the job
                ctx.log(f"LLM failed on part {n+1} (try {attempt}): {ex}")
        if picks is None:
            continue
        for p in picks:
            try:
                a, b = int(p["start_line"]), int(p["end_line"])
            except (KeyError, TypeError, ValueError):
                continue
            if b < a:
                a, b = b, a
            a, b = max(a, s), min(b, e - 1)
            if a > b:
                continue
            a, b = fit_length(lines, a, b, min_len, max_len)
            start, end = lines[a]["start"], lines[b]["end"]
            dur = end - start
            if dur < min_len * 0.6:
                continue
            if dur > max_len:
                end = start + max_len
            candidates.append({
                "start": max(0.0, start - 0.15),
                "end": end + 0.35,
                "title": str(p.get("title", "")).strip()[:80],
                "hook": str(p.get("hook", "")).strip()[:90],
                "score": max(0, min(100, int(p.get("score") or 0))),
                "reason": str(p.get("reason", "")).strip(),
                "text": " ".join(ln["text"] for ln in lines[a:b + 1]),
            })
        ctx.log(f"Part {n+1}/{len(wins)}: {len(picks)} candidate(s)")

    # Best first, drop anything that mostly overlaps a better pick.
    candidates.sort(key=lambda c: c["score"], reverse=True)
    chosen = []
    for c in candidates:
        overlap = any(
            min(c["end"], o["end"]) - max(c["start"], o["start"])
            > 0.3 * min(c["end"] - c["start"], o["end"] - o["start"])
            for o in chosen
        )
        if not overlap:
            chosen.append(c)
        if len(chosen) >= max_clips:
            break
    return chosen
