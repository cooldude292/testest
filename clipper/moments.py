"""Ask the local LLM which parts of the transcript would make good short clips."""
import json
import re
import wave
from collections import Counter

import numpy as np
import requests

from . import config

WINDOW_SECONDS = 480
OVERLAP_SECONDS = 60

SYSTEM = (
    "You are a top short-form video editor. You find the moments in long videos that "
    "go viral as standalone TikToks, YouTube Shorts and Reels. You are picky."
)

PROMPT = """Below is a transcript excerpt from a {kind}. Each line is: [line_id] (mm:ss) text
{signal_help}
Find up to {k} moments that would work as standalone vertical clips of {min_len}-{max_len} seconds.

What goes viral:
- Big reactions: rage, screaming, hype, panic, laughing fits
- Fails, unexpected twists, things going horribly wrong
- Hot takes, roasts, arguments, someone getting called out
- Wild stories with a payoff, shocking facts, confessions

Boring, never pick these: menus, loading screens, settings, downloads, reading patch notes or chat, small talk, explaining controls, "anyway let's go", sponsor reads, intros, outros.

A great clip also:
- Makes sense with zero context.
- Starts on a strong line, never mid-thought or on filler.
- Ends right after the payoff.

For each clip give:
- start_line and end_line (inclusive line ids from the transcript)
- title: plain description for reference, max 8 words
- hook: the on-screen text at the top. It must NOT describe the clip and must NOT repeat the title. It creates curiosity or tension so people keep watching. Good: "He was NOT ready for this", "Chat saw it before he did", "Nobody expected him to say this". Bad: "Call of Duty gameplay", "Talking about downloads". Max 10 words, no emojis, no hashtags.
- score: virality 0-100. Be brutal: anything boring is under 30, only real bangers go above 80.
- reason: one sentence

If nothing here is actually good, return an empty list. An empty list beats a boring clip.

TRANSCRIPT:
{transcript}"""

SIGNAL_HELP = """Some lines carry signals in curly braces. {chat x3.2: KEKW, LMAO} means chat was 3.2x busier than normal right after that line, with its most spammed messages. {LOUD} means the speaker got much louder than usual. Chat spikes are the strongest sign something clip-worthy just happened, so look hard at those spots.
"""

RERANK = """These are candidate short clips cut from the same {kind}. Rank how likely each one is to actually blow up on TikTok and YouTube Shorts. Be brutal: a clip only scores high if a random person scrolling would stop and watch to the end.

For every candidate return its id, a new score 0-100, and the best hook you can write: on-screen curiosity text, max 10 words, not a description, not the title.

CANDIDATES:
{items}"""

RERANK_SCHEMA = {
    "type": "object",
    "properties": {
        "ranked": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "integer"}, "score": {"type": "integer"},
                               "hook": {"type": "string"}},
                "required": ["id", "score", "hook"],
            },
        }
    },
    "required": ["ranked"],
}

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


def ask_llm(prompt, schema=SCHEMA, think=False, num_predict=3000, system=SYSTEM, temperature=0.3):
    """One structured call to the local model. think=True lets qwen3 reason before answering:
    slower, but noticeably better at saying no to weak moments."""
    body = {
        "model": config.LLM_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "stream": False,
        "format": schema,
        "think": think,
        "keep_alive": "15m",
        "options": {"temperature": temperature, "num_ctx": config.LLM_CONTEXT, "num_predict": num_predict},
    }
    r = requests.post(f"{config.OLLAMA_URL}/api/chat", json=body, timeout=1800)
    if r.status_code == 400 and "think" in r.text:
        body.pop("think")
        r = requests.post(f"{config.OLLAMA_URL}/api/chat", json=body, timeout=1800)
    if r.status_code >= 500:
        # Usually the model failed to load: too big for this Mac, or an Ollama too old for it.
        # Run on the safe model instead of failing every call of an overnight run.
        from . import setup_tasks
        if setup_tasks.fall_back(_ollama_error(r)):
            body["model"] = config.LLM_MODEL
            r = requests.post(f"{config.OLLAMA_URL}/api/chat", json=body, timeout=1800)
    if not r.ok:
        raise RuntimeError(f"Ollama {r.status_code} on {body['model']}: {_ollama_error(r)}")
    content = r.json()["message"]["content"]
    return parse_json(content)


def _ollama_error(r):
    try:
        return str(r.json().get("error") or r.text)[:400]
    except ValueError:
        return r.text[:400]


def ollama_version():
    try:
        return requests.get(f"{config.OLLAMA_URL}/api/version", timeout=5).json().get("version", "?")
    except Exception:
        return "?"


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
        if "start_line" in obj or "id" in obj:
            clips.append(obj)
    if not clips:
        raise ValueError("LLM reply wasn't usable JSON")
    return {"clips": clips, "ranked": clips}


def fit_length(lines, s, e, min_len, max_len):
    """Nudge a [s, e] line range so the clip lands inside the length limits."""
    while lines[e]["end"] - lines[s]["start"] < min_len and e + 1 < len(lines):
        if lines[e + 1]["end"] - lines[s]["start"] > max_len:
            break
        e += 1
    while lines[e]["end"] - lines[s]["start"] > max_len and e > s:
        e -= 1
    return s, e


def annotate(lines, audio_path=None, chat=None, chat_base=None):
    """Attach loudness and chat-spike signals to each line."""
    if audio_path:
        with wave.open(str(audio_path)) as wf:
            sr = wf.getframerate()
            dbs = []
            for ln in lines:
                wf.setpos(min(int(ln["start"] * sr), max(0, wf.getnframes() - 1)))
                n = max(1, int((ln["end"] - ln["start"]) * sr))
                a = np.frombuffer(wf.readframes(n), np.int16).astype(np.float32)
                dbs.append(20 * np.log10(np.sqrt(np.mean(a * a)) + 1.0) if a.size else 0.0)
        median = float(np.median(dbs)) if dbs else 0.0
        for ln, db in zip(lines, dbs):
            ln["loud"] = db > median + 6
    if chat:
        times = np.array([t for t, _ in chat])
        span = max(1.0, lines[-1]["end"] - lines[0]["start"])
        base = max(chat_base or len(chat) / span, 1e-3)
        for ln in lines:
            # Chat reacts a few seconds late, so look just past the line too.
            a, b = ln["start"] + 1, ln["end"] + 8
            lo, hi = np.searchsorted(times, a), np.searchsorted(times, b)
            ratio = (hi - lo) / (b - a) / base
            ln["chat"] = round(float(ratio), 1)
            if ratio >= 1.8:
                words = Counter()
                for _, text in chat[lo:hi]:
                    for w in set(text.split()[:4]):
                        words[w[:20]] += 1
                ln["chat_top"] = [w for w, c in words.most_common(3) if c >= 2]


def _signals(ln):
    bits = []
    if ln.get("chat", 0) >= 1.8:
        top = ", ".join(ln.get("chat_top") or [])
        bits.append(f"chat x{ln['chat']}" + (f": {top}" if top else ""))
    if ln.get("loud"):
        bits.append("LOUD")
    return "{" + "; ".join(bits) + "} " if bits else ""


def _signal_score(lines_in_clip, has_chat):
    """0-100 from the raw signals, so the LLM isn't the only judge."""
    if has_chat:
        peak = max((ln.get("chat", 0) for ln in lines_in_clip), default=0)
        return max(0.0, min(1.0, (peak - 1) / 3)) * 100
    loud = sum(1 for ln in lines_in_clip if ln.get("loud"))
    return min(1.0, loud / max(1, len(lines_in_clip)) * 3) * 100


def _norm(x):
    return re.sub(r"[^a-z0-9 ]", "", x.lower()).split()


def _bad_hook(hook, title, clip_lines):
    """Hooks that just repeat the title or quote the transcript aren't hooks."""
    h = _norm(hook)
    if not h or h == _norm(title):
        return True
    said = " " + " ".join(_norm(" ".join(ln["text"] for ln in clip_lines))) + " "
    return len(h) >= 3 and (" " + " ".join(h) + " ") in said


def find_moments(words, max_clips, min_len, max_len, ctx, audio_path=None, chat=None, chat_base=None,
                 kind="video"):
    lines = build_lines(words)
    if not lines:
        return []
    annotate(lines, audio_path, chat, chat_base)
    has_chat = bool(chat)
    wins = windows(lines)
    per_window = max(2, min(5, max_clips))
    help_text = SIGNAL_HELP if (has_chat or audio_path) else ""
    candidates = []
    failed, last_error = 0, None
    for n, (s, e) in enumerate(wins):
        ctx.check()
        ctx.stage("moments", n / len(wins), f"Asking {config.LLM_MODEL} about part {n+1} of {len(wins)}")
        transcript = "\n".join(f"[{ln['i']}] ({_mmss(ln['start'])}) {_signals(ln)}{ln['text']}" for ln in lines[s:e])
        prompt = PROMPT.format(kind=kind, signal_help=help_text, k=per_window, min_len=min_len,
                               max_len=max_len, transcript=transcript)
        picks = None
        for attempt in (1, 2):
            try:
                picks = ask_llm(prompt).get("clips", [])
                break
            except Exception as ex:  # one bad window shouldn't kill the job
                ctx.log(f"LLM failed on part {n+1} (try {attempt}): {ex}")
                last_error = ex
        if picks is None:
            failed += 1
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
            title = str(p.get("title", "")).strip()[:80]
            hook = str(p.get("hook", "")).strip()[:90]
            candidates.append({
                "start": max(0.0, start - 0.15),
                "end": end + 0.35,
                "title": title,
                "hook": "" if _bad_hook(hook, title, lines[a:b + 1]) else hook,
                "llm_score": max(0, min(100, int(p.get("score") or 0))),
                "signal_score": round(_signal_score(lines[a:b + 1], has_chat)),
                "peak_chat": max((ln.get("chat", 0) for ln in lines[a:b + 1]), default=0),
                "reason": str(p.get("reason", "")).strip(),
                "text": " ".join(ln["text"] for ln in lines[a:b + 1]),
            })
        ctx.log(f"Part {n+1}/{len(wins)}: {len(picks)} candidate(s)")

    if failed == len(wins):
        raise RuntimeError(f"The LLM failed on every part, so nothing was judged. Last error: {last_error}")

    # Drop near-duplicates (overlapping windows find the same moment twice).
    candidates.sort(key=lambda c: c["llm_score"] + c["signal_score"], reverse=True)
    unique = []
    for c in candidates:
        if not any(_overlap(c, o) for o in unique):
            unique.append(c)
    unique = unique[:max(3 * max_clips, 6)]
    _rerank(unique, kind, ctx)

    w_sig = 0.35 if has_chat else (0.15 if audio_path else 0.0)
    for c in unique:
        llm = c["llm_score"] if c.get("rerank_score") is None else (c["llm_score"] + c["rerank_score"]) / 2
        c["score"] = round((1 - w_sig) * llm + w_sig * c["signal_score"])
        if not c["hook"]:
            c["hook"] = c["title"]
    unique.sort(key=lambda c: c["score"], reverse=True)
    good = [c for c in unique if c["score"] >= 35]
    if not good and unique:
        ctx.log("Nothing here scored well. Keeping the single best moment anyway")
        good = unique[:1]
    return good[:max_clips]


def _overlap(a, b):
    inter = min(a["end"], b["end"]) - max(a["start"], b["start"])
    return inter > 0.3 * min(a["end"] - a["start"], b["end"] - b["start"])


def _rerank(cands, kind, ctx):
    """Second opinion: let the LLM compare all candidates side by side and rewrite the hooks."""
    if len(cands) < 2:
        return
    ctx.stage("moments", 0.95, f"Ranking the {len(cands)} best candidates against each other")
    items = []
    for i, c in enumerate(cands):
        sig = f"chat x{c['peak_chat']}, " if c["peak_chat"] >= 1.8 else ""
        text = c["text"] if len(c["text"]) <= 600 else c["text"][:600] + "..."
        items.append(f"[id {i}] ({sig}{c['end'] - c['start']:.0f}s) \"{text}\"")
    try:
        ranked = ask_llm(RERANK.format(kind=kind, items="\n".join(items)), RERANK_SCHEMA).get("ranked", [])
    except Exception as ex:
        ctx.log(f"Ranking pass failed, keeping first-pass scores: {ex}")
        return
    for r in ranked:
        try:
            c = cands[int(r["id"])]
        except (KeyError, ValueError, TypeError, IndexError):
            continue
        c["rerank_score"] = max(0, min(100, int(r.get("score") or 0)))
        hook = str(r.get("hook", "")).strip()[:90]
        if hook and not _bad_hook(hook, c["title"], [{"text": c["text"]}]):
            c["hook"] = hook


PACKAGE = """This is the full transcript of a short clip from a {kind} that an editor already cut by hand.
Write the packaging for it.

- title: plain description for reference, max 8 words
- hook: the on-screen text at the top. It must NOT describe the clip and must NOT repeat the title or quote it.
  It creates curiosity or tension so people keep watching. Max 10 words, no emojis, no hashtags.
- score: virality 0-100, be honest
- reason: one sentence

TRANSCRIPT:
{text}"""

PACKAGE_SCHEMA = {
    "type": "object",
    "properties": {"title": {"type": "string"}, "hook": {"type": "string"}, "score": {"type": "integer"},
                   "reason": {"type": "string"}},
    "required": ["title", "hook", "score", "reason"],
}


def exact_clip(words, duration, ctx, audio_path=None, chat=None, chat_base=None, kind="video"):
    """Editor picked the exact range: keep it whole, just write the hook and score it."""
    lines = build_lines(words)
    annotate(lines, audio_path, chat, chat_base) if lines else None
    text = " ".join(ln["text"] for ln in lines)
    ctx.stage("moments", None, f"Writing the hook with {config.LLM_MODEL}")
    try:
        p = ask_llm(PACKAGE.format(kind=kind, text=text[:6000]), PACKAGE_SCHEMA)
    except Exception as ex:
        ctx.log(f"Packaging pass failed, using defaults: {ex}")
        p = {}
    title = str(p.get("title", "")).strip()[:80] or "Exact cut"
    hook = str(p.get("hook", "")).strip()[:90]
    if _bad_hook(hook, title, lines):
        hook = title
    llm = max(0, min(100, int(p.get("score") or 0)))
    sig = round(_signal_score(lines, bool(chat))) if lines else 0
    w = 0.35 if chat else (0.15 if audio_path else 0.0)
    return {"start": 0.0, "end": duration, "title": title, "hook": hook, "llm_score": llm, "signal_score": sig,
            "peak_chat": max((ln.get("chat", 0) for ln in lines), default=0), "reason": str(p.get("reason", "")).strip(),
            "text": text, "score": round((1 - w) * llm + w * sig)}
