"""Overnight mode: give it a whole stream, get back the best clips from it.

1. Audio only for the whole stream (Twitch has an audio rendition, so 4 hours is a minute or two).
2. Signals for every second: chat speed, chat asking for a clip, clips viewers already made,
   YouTube's most-replayed graph, loudness (discover.py, measured against real viewer clips).
3. The strongest spots become candidates. With no audience signal at all (a local file, a
   YouTube video with no graph) the LLM reads the whole transcript to propose them instead.
4. Transcribe around the candidates, in cached 10 minute chunks.
5. A strict judge looks at each candidate with the transcript AND what chat typed (chat says
   what happened on screen, which the transcript can't), cuts tight boundaries, and says no a lot.
6. Survivors play a tournament against each other, a few at a time.
7. Video is downloaded only for the winners, which get reframed and captioned into Packaging.

Every step saves to the work order folder, so Retry after a crash picks up where it stopped.
"""
import json
import random
import re
import wave
from collections import Counter

import numpy as np

from . import chat, config, discover, download, moments, render, setup_tasks, sources, transcribe
from .util import ffmpeg

CHUNK = 600                 # seconds per transcription chunk
CTX_BEFORE, CTX_AFTER = 110, 45   # transcript the judge sees around a candidate
GROUP = 6                   # clips per tournament heat

JUDGE_SYSTEM = (
    "You run a clipping channel that posts stream highlights to TikTok, YouTube Shorts and Reels. "
    "You have watched thousands of clips flop. You only post moments a stranger scrolling past would stop for, "
    "and you reject most of what you see."
)

JUDGE = """Candidate moment from a {kind}{by}. You can't see the video. You get:
- TRANSCRIPT: what the streamer and anyone on mic said. Format: [line_id] (h:mm:ss) text. Lines can carry
  {{chat x4.1}} (chat that much busier than normal right after it) and {{LOUD}}. ">>>" marks where the audience reacted hardest.
- CHAT: what viewers typed right then, most repeated first. Chat often tells you what happened on screen.
{viewer_clips}
Common junk that spikes chat but makes a bad clip: raids, subs and gift subs, giveaways, donation or TTS
messages, reading chat, the stream starting or ending, ads, waiting or loading, inside jokes, anything
that needs earlier context, and moments where the payoff is purely visual and nobody says anything about it.

Decide:
- verdict: "clip" or "skip".
- what_happens: one plain sentence, concretely what happens (use chat to infer what's on screen).
- start_line, end_line: the tight cut, {min_len}-{max_len} seconds. Start where a stranger needs to start to get it,
  not earlier. End right after the payoff and the reaction to it. Never end mid-sentence.
- standalone 0-10: would someone with zero context get it?
- payoff 0-10: is there a real peak: a punchline, a fail, a rage, a shock, a clutch, a reveal?
- first_seconds 0-10: do the first 3 seconds make you want to keep watching?
- title: plain description, max 8 words.
- hook: on-screen text at the top. Creates curiosity, does NOT describe or repeat the title or quote the transcript.
  Good: "He was NOT ready for this", "Chat saw it before he did". Max 10 words, no emojis, no hashtags.
- score 0-100 on this scale: 90+ would do millions of views. 75 is a solid clip a big clipping channel posts.
  60 is fine filler. 40 is meh. Under 30 is junk.
- reject_reason: if skip, why in a few words.

TRANSCRIPT:
{transcript}

CHAT:
{chat}"""

JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["clip", "skip"]},
        "what_happens": {"type": "string"},
        "start_line": {"type": "integer"}, "end_line": {"type": "integer"},
        "standalone": {"type": "integer"}, "payoff": {"type": "integer"}, "first_seconds": {"type": "integer"},
        "title": {"type": "string"}, "hook": {"type": "string"},
        "score": {"type": "integer"}, "reject_reason": {"type": "string"},
    },
    "required": ["verdict", "what_happens", "start_line", "end_line", "standalone", "payoff", "first_seconds",
                 "title", "hook", "score", "reject_reason"],
}

RANK = """These short clips were all cut from the same {kind}. Order them from the one most likely to blow up on
TikTok and Shorts to the least. Think about a stranger scrolling: which ones stop them and keep them to the end?

{items}

Return every id exactly once, best first."""

RANK_SCHEMA = {"type": "object", "properties": {"order": {"type": "array", "items": {"type": "integer"}}},
               "required": ["order"]}


class Sub:
    """Ctx wrapper that relabels progress from code written for one-shot jobs."""

    def __init__(self, ctx, stage, prefix, lo=0.0, hi=1.0):
        self.ctx, self.st, self.prefix, self.lo, self.hi = ctx, stage, prefix, lo, hi

    def stage(self, _stage, frac, msg):
        f = None if frac is None else self.lo + (self.hi - self.lo) * frac
        self.ctx.stage(self.st, f, f"{self.prefix}{msg}")

    def log(self, msg):
        self.ctx.log(msg)

    def check(self):
        self.ctx.check()


def _load(path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _save(path, obj):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj))
    tmp.replace(path)


def wav_duration(path):
    with wave.open(str(path)) as wf:
        return wf.getnframes() / wf.getframerate()


def wav_loudness(path):
    """Per-second dB straight from the wav, a minute at a time (a 10 h stream is ~1 GB of samples)."""
    out = []
    with wave.open(str(path)) as wf:
        sr = wf.getframerate()
        while True:
            a = np.frombuffer(wf.readframes(sr * 60), np.int16).astype(np.float32) / 32768.0
            sec = len(a) // sr
            if sec == 0:
                break
            b = a[: sec * sr].reshape(sec, sr)
            out.append(20 * np.log10(np.sqrt((b ** 2).mean(axis=1)) + 1e-5))
    return np.concatenate(out) if out else np.zeros(1)


# ---------------------------------------------------------------- signals

def gather_signals(job, ctx, wav, meta, duration):
    d = job.dir
    msgs, clips = [], []
    tid = meta.get("twitch_id")
    if tid:
        ctx.stage("signals", 0.0, "Reading the whole chat replay")
        try:
            full = sources.cached_chat(tid)
            if full:
                msgs = full[0]
            else:
                msgs = chat.fetch(tid, 0, duration, Sub(ctx, "signals", "", 0.0, 0.85))
                config.CACHE_DIR.joinpath(f"chat_{tid}.json").write_text(
                    json.dumps({"duration": duration, "messages": msgs}))
            ctx.log(f"Chat replay: {len(msgs)} messages")
        except Exception as ex:
            ctx.log(f"Couldn't read chat, going without it: {ex}")
        ctx.stage("signals", 0.9, "Looking up clips viewers made")
        try:
            clips = chat.vod_clips(tid)
            ctx.log(f"Viewers made {len(clips)} clips of this stream")
        except Exception as ex:
            ctx.log(f"Couldn't read viewer clips: {ex}")
    heat = meta.get("heatmap")
    if heat:
        ctx.log("Using YouTube's most-replayed graph")
    ctx.stage("signals", 0.95, "Measuring loudness")
    lp = d / "loudness.npy"
    loud = np.load(lp) if lp.exists() else wav_loudness(wav)
    np.save(lp, loud)
    return msgs, clips, heat, loud


# Clip titles written by other people's clipping bots, or auto-filled, tell the judge nothing.
_BOT_TITLE = re.compile(r"^[\d\s\W]+$|https?://|check out this clip|baseline|viewer signal|chat burst|messages;", re.I)


def candidates_from_signals(score, parts, clips, duration, n, stream_title=""):
    """Strongest spots in the stream, plus every moment viewers clipped hard."""
    centers = discover.peaks(score, k=n, min_gap=60)
    out = [{"t": float(t), "src": "signal"} for t in centers]
    # Viewer clips: group the ones about the same moment, strongest first.
    ev = sorted((c["videoOffsetSeconds"] + (c.get("durationSeconds") or 30) - 6, c.get("viewCount", 0),
                 c.get("title") or "") for c in clips)
    groups = []
    for t, v, title in ev:
        if groups and t - groups[-1]["last"] <= 45:
            g = groups[-1]
            g["views"] += v
            g["n"] += 1
            g["last"] = t
            g["ts"].append(t)
            g["titles"].append((v, title))
        else:
            groups.append({"last": t, "views": v, "n": 1, "ts": [t], "titles": [(v, title)]})
    groups.sort(key=lambda g: -sum(np.log1p(v) ** 2 for v, _ in g["titles"]))  # same weighting as discover.clip_feature
    for g in groups[: max(10, n // 2)]:
        t = float(np.median(g["ts"]))
        # Untitled clips inherit the stream title, which says nothing about the moment.
        st = stream_title.strip().lower()
        titles = list(dict.fromkeys(x.strip() for _, x in sorted(g["titles"], reverse=True)
                                    if len(x.strip()) >= 2 and x.strip().lower() != st and not _BOT_TITLE.search(x)))[:4]
        hit = next((c for c in out if abs(c["t"] - t) < 45), None)
        if hit:
            hit.update(clip_views=g["views"], clip_count=g["n"], clip_titles=titles)
        else:
            out.append({"t": t, "src": "viewers", "clip_views": g["views"], "clip_count": g["n"],
                        "clip_titles": titles})
    for c in out:
        t = int(min(max(c["t"], 0), len(score) - 1))
        c["signal"] = float(score[max(0, t - 10): t + 10].max()) if len(score) else 0.0
        c["why"] = discover.explain(parts, t) if parts else []
        if c.get("clip_count") and "viewers clipped this" not in c["why"]:
            c["why"] = ["viewers clipped this"] + c["why"][:2]
    return [c for c in out if 30 < c["t"] < duration - 5]


def candidates_from_transcript(words, ctx, kind, min_len, max_len):
    """No audience signal: let the LLM read everything and point at moments, which the judge then vets."""
    lines = moments.build_lines(words)
    wins = moments.windows(lines)
    out = []
    for n, (s, e) in enumerate(wins):
        ctx.check()
        ctx.stage("mining", n / max(1, len(wins)), f"Reading the transcript for moments: part {n + 1}/{len(wins)}")
        transcript = "\n".join(f"[{ln['i']}] ({moments._mmss(ln['start'])}) {ln['text']}" for ln in lines[s:e])
        prompt = moments.PROMPT.format(kind=kind, signal_help="", k=5, min_len=min_len, max_len=max_len,
                                       transcript=transcript)
        try:
            picks = moments.ask_llm(prompt).get("clips", [])
        except Exception as ex:
            ctx.log(f"Part {n + 1}: LLM failed ({ex})")
            continue
        for p in picks:
            try:
                b = min(int(p["end_line"]), e - 1)
            except (KeyError, TypeError, ValueError):
                continue
            if s <= b and int(p.get("score") or 0) >= 40:
                out.append({"t": lines[b]["end"] - 5, "src": "transcript", "signal": 0.0, "why": ["the AI liked it"]})
    out.sort(key=lambda c: c["t"])
    dedup = []
    for c in out:
        if not dedup or c["t"] - dedup[-1]["t"] > 40:
            dedup.append(c)
    return dedup


# ---------------------------------------------------------------- transcript

def transcribe_spans(job, ctx, wav, duration, spans):
    """Words for every 10-minute chunk touching spans, each chunk cached on disk."""
    cdir = job.dir / "transcript"
    cdir.mkdir(exist_ok=True)
    need = sorted({int(t // CHUNK) for a, b in spans for t in np.arange(max(0, a), min(duration, b), CHUNK / 2)}
                  | {int(min(duration, b) // CHUNK) for a, b in spans})
    need = [i for i in need if i * CHUNK < duration]
    words = []
    for k, i in enumerate(need):
        ctx.check()
        f = cdir / f"{i:04d}.json"
        got = _load(f)
        if got is None:
            a, b = i * CHUNK, min(duration, (i + 1) * CHUNK)
            label = f"Transcribing chunk {k + 1}/{len(need)} ({_tc(a)}-{_tc(b)}): "
            sub = Sub(ctx, "transcribe", label, k / len(need), (k + 1) / len(need))
            # A little overlap so a word on the seam isn't cut in half; keep each word once.
            raw = transcribe.transcribe(wav, None, sub, span=(max(0, a - 2), min(duration, b + 2)))
            got = [w for w in raw if a <= w["s"] < b]
            _save(f, got)
        words.extend(got)
    words.sort(key=lambda w: w["s"])
    return words


# ---------------------------------------------------------------- judging

def _chat_digest(msgs_t, msgs_x, t, k=30):
    """What chat typed right after t: most repeated messages with counts, then a sample of the rest."""
    lo, hi = np.searchsorted(msgs_t, t - 4), np.searchsorted(msgs_t, t + 22)
    texts = [msgs_x[i].strip() for i in range(lo, hi) if msgs_x[i].strip()]
    if not texts:
        return "(nothing)"
    cnt = Counter(x[:60].upper() for x in texts)
    top = [f"{x} (x{c})" for x, c in cnt.most_common(12) if c >= 2]
    rest = [x[:100] for x in texts if cnt[x[:60].upper()] < 2]
    random.Random(int(t)).shuffle(rest)
    return "\n".join(top + rest[: max(0, k - len(top))])


def _lines_for(words, a, b):
    inside = [w for w in words if a <= w["s"] < b]
    lines = moments.build_lines(inside)
    return lines


def judge(cand, words, msgs_t, msgs_x, chat_base, kind, channel, min_len, max_len):
    t = cand["t"]
    lines = _lines_for(words, t - CTX_BEFORE, t + CTX_AFTER)
    if len(lines) < 2:
        return {**cand, "verdict": "skip", "reject_reason": "nobody talks here", "score": 0}
    if len(msgs_t):
        local = [(msgs_t[i], msgs_x[i]) for i in range(np.searchsorted(msgs_t, t - CTX_BEFORE),
                                                         np.searchsorted(msgs_t, t + CTX_AFTER + 10))]
        moments.annotate(lines, chat=local, chat_base=chat_base)
    peak_line = min(lines, key=lambda ln: abs(ln["end"] - t))["i"]
    transcript = "\n".join(
        f"{'>>> ' if ln['i'] == peak_line else ''}[{ln['i']}] ({_tc(ln['start'])}) "
        f"{'{chat x%s} ' % ln['chat'] if ln.get('chat', 0) >= 1.8 else ''}{ln['text']}" for ln in lines)
    vc = ""
    if cand.get("clip_titles"):
        vc = ("- VIEWER CLIPS: viewers already clipped this " + str(cand.get("clip_count", 1)) +
              " time(s), titled: " + "; ".join(f'"{x}"' for x in cand["clip_titles"]) + "\n")
    prompt = JUDGE.format(kind=kind, by=f" by {channel}" if channel else "", viewer_clips=vc, min_len=int(min_len),
                          max_len=int(max_len), transcript=transcript,
                          chat=_chat_digest(msgs_t, msgs_x, t) if len(msgs_t) else "(no chat for this source)")
    r = None
    for think in (config.JUDGE_THINK, False):
        try:
            r = moments.ask_llm(prompt, JUDGE_SCHEMA, think=think, num_predict=6000 if think else 1500,
                                system=JUDGE_SYSTEM, temperature=0.2)
            break
        except Exception as ex:
            err = ex
    if r is None:
        return {**cand, "verdict": "error", "reject_reason": f"LLM failed: {err}", "score": 0}

    try:
        a, b = int(r.get("start_line", 0)), int(r.get("end_line", len(lines) - 1))
    except (TypeError, ValueError):
        a, b = 0, len(lines) - 1
    a, b = sorted((max(0, min(a, len(lines) - 1)), max(0, min(b, len(lines) - 1))))
    a, b = moments.fit_length(lines, a, b, min_len, max_len)
    start, end = lines[a]["start"], lines[b]["end"]
    if end - start < min_len * 0.6:  # judge picked something too short: widen around the peak
        start, end = max(lines[0]["start"], t - min_len * 0.7), t + min_len * 0.3
    end = min(end, start + max_len)
    title = str(r.get("title", "")).strip()[:80]
    hook = str(r.get("hook", "")).strip()[:90]
    sub = [max(0, min(10, int(r.get(k) or 0))) for k in ("standalone", "payoff", "first_seconds")]
    return {**cand,
            "verdict": "clip" if str(r.get("verdict", "")).lower() == "clip" else "skip",
            "start": max(0.0, start - 0.15), "end": end + 0.35,
            "title": title, "hook": "" if moments._bad_hook(hook, title, lines[a:b + 1]) or _copied(hook) else hook,
            "what_happens": str(r.get("what_happens", "")).strip()[:300],
            "reject_reason": str(r.get("reject_reason", "")).strip()[:200],
            "standalone": sub[0], "payoff": sub[1], "first_seconds": sub[2],
            "llm_score": max(0, min(100, int(r.get("score") or 0))),
            "text": " ".join(ln["text"] for ln in lines[a:b + 1])}


_EXAMPLE_HOOKS = {"he was not ready for this", "chat saw it before he did", "nobody expected him to say this"}


def _copied(hook):
    """Small models love pasting the prompt's example hooks onto everything."""
    return re.sub(r"[^a-z ]", "", hook.lower()).strip() in _EXAMPLE_HOOKS


def tournament(pool, kind, ctx, rounds=3):
    """Rank in small heats, reshuffled each round. Returns {index: 0..1 strength}."""
    if len(pool) < 2:
        return {0: 1.0} if pool else {}
    pts = {i: [] for i in range(len(pool))}
    heats_total = rounds * int(np.ceil(len(pool) / GROUP))
    done = 0
    for rnd in range(rounds):
        idx = list(range(len(pool)))
        random.Random(rnd).shuffle(idx)
        for g in range(0, len(idx), GROUP):
            ctx.check()
            heat = idx[g:g + GROUP]
            done += 1
            ctx.stage("rank", done / heats_total, f"Head to head: heat {done}/{heats_total}")
            if len(heat) < 2:
                continue
            items = "\n".join(
                f"[id {k}] {pool[i]['what_happens']} | hook: {pool[i]['hook'] or pool[i]['title']} | "
                f"\"{pool[i]['text'][:500]}\"" for k, i in enumerate(heat))
            try:
                order = moments.ask_llm(RANK.format(kind=kind, items=items), RANK_SCHEMA, temperature=0.1).get("order", [])
            except Exception as ex:
                ctx.log(f"Heat {done} failed: {ex}")
                continue
            seen = []
            for k in order:
                if isinstance(k, int) and 0 <= k < len(heat) and k not in seen:
                    seen.append(k)
            seen += [k for k in range(len(heat)) if k not in seen]
            for rank, k in enumerate(seen):
                pts[heat[k]].append(1 - rank / (len(heat) - 1))
    return {i: float(np.mean(v)) if v else 0.5 for i, v in pts.items()}


# ---------------------------------------------------------------- the run

def run(job, ctx):
    o = job.options
    d = job.dir
    d.mkdir(parents=True, exist_ok=True)
    max_clips = int(o.get("max_clips", 15))
    min_len, max_len = float(o.get("min_len", 15)), float(o.get("max_len", 60))
    min_score = float(o.get("min_score", 55))

    wav, title, meta = download.fetch_audio(job.source, d, Sub(ctx, "audio", ""))
    job.title = title
    duration = wav_duration(wav)
    ctx.log(f"Audio for the whole thing: {title} ({duration / 3600:.1f} h)")
    kind = "livestream" if meta.get("twitch_id") or "kick.com" in job.source else "video"
    channel = meta.get("channel") or ""

    msgs, clips, heat, loud = gather_signals(job, ctx, wav, meta, duration)
    score, parts = discover.score_timeline(chat=msgs or None, loud_db=loud, clips=clips or None,
                                           duration=duration, heat=heat)
    has_audience = bool(msgs or clips or heat)
    n_cand = int(min(max(duration / 180, 25), int(o.get("max_candidates", 120))))

    cpath = d / "candidates.json"
    cands = _load(cpath)
    words = None
    if cands is None:
        if has_audience:
            cands = candidates_from_signals(score, parts, clips, duration, n_cand, title)
            cands = sorted(cands, key=lambda c: -c["signal"])[: int(n_cand * 1.5) + 1]
            ctx.log(f"{len(cands)} candidate moments from the audience signals")
        else:
            ctx.log("No chat, viewer clips or replay graph here. Reading the whole transcript instead")
            words = transcribe_spans(job, ctx, wav, duration, [(0, duration)])
            setup_tasks.ensure_ollama()
            cands = candidates_from_transcript(words, ctx, kind, min_len, max_len)
            for c in cands:
                c["signal"] = float(score[int(min(c["t"], len(score) - 1))]) if len(score) else 0.0
            ctx.log(f"{len(cands)} candidate moments from the transcript")
        _save(cpath, cands)
    if not cands:
        raise RuntimeError("Couldn't find a single candidate moment in this source")

    spans = [(c["t"] - CTX_BEFORE, c["t"] + CTX_AFTER) for c in cands]
    words = transcribe_spans(job, ctx, wav, duration, spans)
    ctx.log(f"Transcribed {len(words)} words around the candidates")
    _free_whisper()  # the judge model wants every GB it can get

    # ---- judge
    setup_tasks.ensure_ollama()
    msgs_t = np.array([m[0] for m in msgs]) if msgs else np.array([])
    msgs_x = [m[1] for m in msgs]
    chat_base = len(msgs) / duration if msgs else None
    jpath = d / "judged.json"
    judged = _load(jpath) or {}
    for k, c in enumerate(cands):
        ctx.check()
        key = f"{c['t']:.0f}"
        if key in judged and judged[key].get("verdict") != "error":
            continue
        kept = sum(1 for v in judged.values() if v.get("verdict") == "clip")
        ctx.stage("judge", k / len(cands), f"Judging moment {k + 1}/{len(cands)} at {_tc(c['t'])} "
                                           f"({kept} kept so far)")
        judged[key] = judge(c, words, msgs_t, msgs_x, chat_base, kind, channel, min_len, max_len)
        _save(jpath, judged)
    results = list(judged.values())
    errors = sum(1 for r in results if r["verdict"] == "error")
    if errors == len(results):
        raise RuntimeError(f"The LLM failed on every moment: {results[0].get('reject_reason')}")

    # ---- combine judge + audience into one score
    sig = np.array([r.get("signal", 0.0) for r in results])
    pct = {i: float((sig < s).mean() * 100) for i, s in enumerate(sig)} if has_audience else {}
    top_views = sorted((r.get("clip_views", 0) for r in results), reverse=True)[:3]
    alive = []
    for i, r in enumerate(results):
        if r["verdict"] == "error":
            continue
        viewers_loved = r.get("clip_views", 0) and r.get("clip_views", 0) >= (top_views[-1] if top_views else 1e9)
        if r["verdict"] == "skip" and not viewers_loved:
            continue  # the judge can't see the screen, so a top viewer clip survives a "skip"
        quality = r["llm_score"] * 0.6 + (r["standalone"] + r["payoff"] + r["first_seconds"]) / 30 * 100 * 0.4
        r["signal_pct"] = round(pct.get(i, 0))
        r["base"] = 0.65 * quality + 0.35 * r["signal_pct"] if has_audience else quality
        alive.append(r)
    alive.sort(key=lambda r: -r["base"])
    uniq = []
    for r in alive:
        if not any(_overlap(r, u) for u in uniq):
            uniq.append(r)
    pool = uniq[: max(3 * max_clips, 12)]
    ctx.log(f"Judge kept {len(alive)} of {len(results)} moments; {len(pool)} go to the head to head")

    strength = tournament(pool, kind, ctx) if len(pool) > 1 else {0: 1.0}
    for i, r in enumerate(pool):
        r["rank_score"] = round(strength.get(i, 0.5) * 100)
        r["score"] = round(0.7 * r["base"] + 0.3 * r["rank_score"])
        if not r["hook"]:
            r["hook"] = r["title"]
        r["reason"] = r["what_happens"]
    pool.sort(key=lambda r: -r["score"])
    winners = [r for r in pool if r["score"] >= min_score][:max_clips]
    floor = min(5, max_clips, len(pool))
    if len(winners) < floor:
        winners = pool[:floor]  # a quiet stream still gets its best few
    _save(d / "ranked.json", pool)
    ctx.log(f"Making {len(winners)} clip(s)")
    # Packaging reads clip words from transcript.json with whole-stream times.
    (d / "transcript.json").write_text(json.dumps(words))

    # ---- video for the winners only, then render
    for n, c in enumerate(winners, 1):
        ctx.check()
        c["abs_start"], c["abs_end"] = c["start"], c["end"]
        name = f"clip_{n:02d}.mp4"
        if (d / name).exists() and (d / name.replace(".mp4", "_base.mp4")).exists():
            c["file"], c["thumb"] = name, name.replace(".mp4", ".jpg")
            c.setdefault("layout", "track")
            job.clips.append(c)
            continue
        label = f"Clip {n}/{len(winners)}"
        if meta.get("local"):
            src, off = meta["local"], 0.0
        else:
            cdir = d / f"src_{n:02d}"
            cdir.mkdir(exist_ok=True)
            sec = f"{max(0, c['start'] - 3):.0f}-{c['end'] + 3:.0f}"
            src, _, m = download.fetch(meta.get("webpage_url") or job.source, cdir, sec,
                                       Sub(ctx, "video", f"{label}: "))
            off = m.get("offset", 0.0)
        local = {**c, "start": c["start"] - off, "end": c["end"] - off}
        lw = [{"w": w["w"], "s": w["s"] - off, "e": w["e"] - off} for w in words
              if w["e"] > c["start"] - 1 and w["s"] < c["end"] + 1]
        render.render_clip(src, lw, local, d / name, d, o.get("layout", "auto"), ctx, label)
        c["layout"], c["file"] = local["layout"], name
        thumb = name.replace(".mp4", ".jpg")
        try:
            ffmpeg("-ss", min(1.5, (c["end"] - c["start"]) / 2), "-i", d / name, "-frames:v", "1",
                   "-vf", "scale=360:-2", "-q:v", "4", d / thumb)
            c["thumb"] = thumb
        except RuntimeError:
            pass
        if not meta.get("local"):
            for p in (d / f"src_{n:02d}").glob("*"):
                p.unlink(missing_ok=True)
        job.clips.append(c)
        ctx.log(f"{name}: score {c['score']} | {c['what_happens'][:90]}")
        job.save(force=True)


def _free_whisper():
    try:
        import mlx.core as mx
        from mlx_whisper.transcribe import ModelHolder
        ModelHolder.model = ModelHolder.model_path = None
        mx.clear_cache()
    except Exception:
        pass
    transcribe._fw_model = None


def _overlap(a, b):
    inter = min(a["end"], b["end"]) - max(a["start"], b["start"])
    return inter > 0.25 * min(a["end"] - a["start"], b["end"] - b["start"])


def _tc(t):
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}"


def resolve(source):
    """A channel link (twitch.tv/name) means its latest past broadcast."""
    m = re.match(r"^https?://(?:www\.|m\.)?twitch\.tv/([A-Za-z0-9_]{3,25})/?(?:videos/?)?(?:\?.*)?$", source.strip())
    if m and m.group(1).lower() not in ("videos", "directory", "settings"):
        vods = chat.latest_vods(m.group(1), 1)
        if not vods:
            raise ValueError(f"{m.group(1)} has no past broadcasts")
        return f"https://www.twitch.tv/videos/{vods[0]['id']}", vods[0].get("title") or ""
    return source.strip(), ""
