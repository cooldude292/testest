"""Twitch VOD chat replay. Chat blowing up is the best "something happened" signal a stream has."""
import threading
from concurrent.futures import ThreadPoolExecutor

import requests

GQL = "https://gql.twitch.tv/gql"
CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"  # Twitch's public web client id
QUERY_HASH = "b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a"
SLICE = 300  # seconds of VOD per worker


def _page(session, video_id, offset):
    body = [{
        "operationName": "VideoCommentsByOffsetOrCursor",
        "variables": {"videoID": video_id, "contentOffsetSeconds": int(offset)},
        "extensions": {"persistedQuery": {"version": 1, "sha256Hash": QUERY_HASH}},
    }]
    for attempt in range(3):
        try:
            r = session.post(GQL, json=body, timeout=20)
            r.raise_for_status()
            comments = ((r.json()[0].get("data") or {}).get("video") or {}).get("comments")
            return (comments or {}).get("edges") or []
        except (requests.RequestException, ValueError, IndexError):
            if attempt == 2:
                raise
    return []


def fetch(video_id, start, end, ctx):
    """All chat messages between start and end (VOD seconds) as [(t, text)], sorted.

    Twitch only allows paging by timestamp without an integrity token, and each request
    returns ~60 messages, so we step forward from the last message seen."""
    session = requests.Session()
    session.headers["Client-Id"] = CLIENT_ID
    slices = [(s, min(end, s + SLICE)) for s in range(int(start), int(end), SLICE)]
    found = {}
    lock = threading.Lock()
    done = [0]

    def work(rng):
        a, b = rng
        off = a
        while off < b:
            ctx.check()
            edges = _page(session, video_id, off)
            if not edges:
                break
            last = off
            with lock:
                for e in edges:
                    n = e["node"]
                    last = n["contentOffsetSeconds"]
                    if a <= last < b:
                        text = "".join(f.get("text") or "" for f in n["message"]["fragments"])
                        found[n["id"]] = (float(last), text)
            off = max(last + 1, off + 1)
        with lock:
            done[0] += 1
            ctx.stage("chat", done[0] / len(slices),
                      f"Reading Twitch chat: {done[0]}/{len(slices)} chunks, {len(found)} messages")

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(work, slices))
    return sorted(found.values())


def baseline_rate(video_id, vod_duration, samples=40):
    """Typical messages/second across the whole VOD, from one page at evenly spaced points.
    Needed so a hot section isn't judged against itself."""
    session = requests.Session()
    session.headers["Client-Id"] = CLIENT_ID
    step = vod_duration / (samples + 1)

    def rate(i):
        try:
            edges = _page(session, video_id, step * (i + 1))
        except Exception:
            return None
        ts = [e["node"]["contentOffsetSeconds"] for e in edges]
        if len(ts) < 10 or ts[-1] <= ts[0]:
            return None
        return (len(ts) - 1) / (ts[-1] - ts[0])

    with ThreadPoolExecutor(8) as pool:
        rates = [r for r in pool.map(rate, range(samples)) if r]
    return float(sorted(rates)[len(rates) // 2]) if rates else None


# ---------- viewer clips and channels ----------

def _gql(query):
    r = requests.post(GQL, headers={"Client-Id": CLIENT_ID}, json={"query": query}, timeout=30)
    r.raise_for_status()
    return r.json().get("data") or {}


_CLIP_FIELDS = "id title viewCount durationSeconds videoOffsetSeconds"


def vod_clips(video_id):
    """Clips viewers made of this VOD: [{title, viewCount, durationSeconds, videoOffsetSeconds}].

    The VOD's own clip list stops at 100 and can't be paged without an integrity token, so the
    channel's top clips for the last day/week/month are merged in too."""
    v = _gql('query{video(id:"%s"){owner{login} clips(first:100){edges{node{%s}}}}}' % (video_id, _CLIP_FIELDS))
    v = v.get("video") or {}
    out = {e["node"]["id"]: e["node"] for e in ((v.get("clips") or {}).get("edges") or [])}
    login = (v.get("owner") or {}).get("login")
    if login:
        for period in ("LAST_DAY", "LAST_WEEK", "LAST_MONTH"):
            for sort in ("VIEWS_DESC", "CREATED_AT_DESC"):
                try:
                    d = _gql('query{user(login:"%s"){clips(first:100, criteria:{period:%s, sort:%s})'
                             '{edges{node{%s video{id}}}}}}' % (login, period, sort, _CLIP_FIELDS))
                except requests.RequestException:
                    continue
                for e in (((d.get("user") or {}).get("clips") or {}).get("edges") or []):
                    n = e["node"]
                    if (n.pop("video", None) or {}).get("id") == str(video_id) and n.get("videoOffsetSeconds") is not None:
                        out[n["id"]] = n
    return [c for c in out.values() if c.get("videoOffsetSeconds") is not None]


def latest_vods(login, n=5):
    """Most recent past broadcasts of a channel: [{id, title, lengthSeconds, publishedAt}]."""
    d = _gql('query{user(login:"%s"){videos(first:%d, type:ARCHIVE, sort:TIME){edges{node{id title lengthSeconds publishedAt}}}}}'
             % (login, n))
    return [e["node"] for e in (((d.get("user") or {}).get("videos") or {}).get("edges") or [])]
