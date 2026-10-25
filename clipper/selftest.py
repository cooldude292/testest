"""End-to-end checks run against the packaged app on a real Mac (CI), before anyone downloads it.

Usage: Clipworks.app/Contents/MacOS/Clipworks --selftest [--llm]
"""
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

results = []


def check(name, timeout=600):
    """Run one check in a thread with a deadline, so a hang names itself instead of stalling CI."""
    def wrap(fn):
        def run(*a):
            t = time.time()
            print(f"--> {name}", flush=True)
            box = {}

            def target():
                try:
                    box["detail"] = fn(*a) or ""
                except Exception:
                    box["error"] = traceback.format_exc()[-1500:]

            th = threading.Thread(target=target, daemon=True)
            th.start()
            th.join(timeout)
            if th.is_alive():
                results.append((name, False, f"TIMED OUT after {timeout}s"))
            elif "error" in box:
                results.append((name, False, box["error"]))
            else:
                results.append((name, True, f"{box['detail']} ({time.time() - t:.1f}s)"))
            print(f"    {'ok' if results[-1][1] else 'FAILED'}: {results[-1][2][:300]}", flush=True)
        return run
    return wrap


class Ctx:
    last = 0.0

    def stage(self, stage, progress, message):
        if time.time() - Ctx.last > 10:
            Ctx.last = time.time()
            print(f"   [{stage}] {message}", flush=True)

    def log(self, m):
        print("   log:", m, flush=True)

    def check(self):
        pass


def run(args):
    import os
    os.environ["CLIPWORKS_NO_SETUP"] = "1"
    from clipper import config
    tmp = Path(tempfile.mkdtemp())
    print(f"Clipworks selftest  frozen={config.FROZEN}  data={config.DATA}")

    @check("bundled tools on PATH")
    def tools():
        found = {b: shutil.which(b) for b in ("ffmpeg", "ffprobe", "deno")}
        missing = [b for b, p in found.items() if not p]
        if missing:
            raise RuntimeError(f"missing: {missing}")
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        return f"{found}  videotoolbox={'h264_videotoolbox' in enc} x264={'libx264' in enc}"

    @check("web UI served")
    def web():
        from fastapi.testclient import TestClient
        from clipper.server import app
        c = TestClient(app)
        for path in ("/", "/static/app.js", "/static/app.css", "/static/vendor/hls.min.js", "/static/vendor/inter.woff2",
                     "/fonts/Montserrat.ttf", "/api/sfx", "/api/sfx/file/boom"):
            r = c.get(path)
            if r.status_code != 200:
                raise RuntimeError(f"{path} -> {r.status_code}")
        return "all assets 200"

    speech = tmp / "speech.aiff"

    @check("transcribe (MLX Whisper tiny)", 900)
    def stt():
        subprocess.run(["say", "-o", str(speech), "This is a test of the clip factory. "
                        "Chat is going crazy right now. Nobody expected that."], check=True)
        import mlx.core as mx
        try:
            mx.eval(mx.array([1.0, 2.0]) * 2)
        except Exception:
            mx.set_default_device(mx.cpu)   # CI VMs have no Metal GPU
        from clipper import config as cfg, transcribe
        cfg.WHISPER_MODEL = "mlx-community/whisper-tiny"
        wav = tmp / "speech.wav"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(speech), "-ac", "1", "-ar", "16000", str(wav)], check=True)
        words = transcribe.transcribe(wav, 6.0, Ctx())
        text = "".join(w["w"] for w in words).lower()
        if "clip" not in text and "chat" not in text:
            raise RuntimeError(f"unexpected transcript: {text!r}")
        (tmp / "words.json").write_text(json.dumps(words))
        return f"{len(words)} words: {text.strip()[:80]}"

    @check("render a vertical clip with captions")
    def rend():
        from clipper import render
        src = tmp / "src.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=8",
                        "-i", str(speech), "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(src)],
                       check=True)
        words = json.loads((tmp / "words.json").read_text()) if (tmp / "words.json").exists() else \
            [{"w": " test", "s": 0.5, "e": 1.0}]
        clip = {"start": 0.0, "end": 6.0, "hook": "Nobody expected that", "title": "test"}
        out = tmp / "clip.mp4"
        render.render_clip(src, words, clip, out, tmp, "auto", Ctx(), "selftest")
        info = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration",
                               "-of", "json", str(out)], capture_output=True, text=True).stdout
        d = json.loads(info)
        w, h = d["streams"][0]["width"], d["streams"][0]["height"]
        if (w, h) != (1080, 1920):
            raise RuntimeError(f"bad size {w}x{h}")
        return f"{w}x{h} {float(d['format']['duration']):.1f}s layout={clip['layout']}"

    @check("package: sound effects, zoom punch, trim, new hook")
    def pkg():
        from clipper import packaging, sfx
        lib = sfx.library()
        if len(lib) < 10:
            raise RuntimeError(f"sound library too small: {len(lib)}")
        base = tmp / "clip_base.mp4"
        if not base.exists():
            raise RuntimeError("factory render didn't leave a base file")
        words = json.loads((tmp / "words.json").read_text()) if (tmp / "words.json").exists() else []
        spec = packaging.clean_spec({"hook": "selftest hook", "hook_on": True, "captions_on": True, "color": "green",
                                     "trim": [0.5, 5.0], "sfx": [{"t": 0.6, "sound": "whoosh", "vol": 0.8, "fx": "none"},
                                                                 {"t": 2.0, "sound": "boom", "vol": 0.9, "fx": "zoom"}]}, 5.5)
        out = tmp / "pkg.mp4"
        packaging.compose(base, words, spec, "zoom", out)
        d = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration",
                                       "-of", "json", str(out)], capture_output=True, text=True).stdout)
        kinds = sorted(s["codec_type"] for s in d["streams"])
        if kinds != ["audio", "video"] or abs(float(d["format"]["duration"]) - 4.5) > 0.3:
            raise RuntimeError(f"bad package: {kinds} {d['format']['duration']}")
        loud = subprocess.run(["ffmpeg", "-hide_banner", "-ss", "1.45", "-t", "0.4", "-i", str(out), "-af", "volumedetect",
                               "-f", "null", "-"], capture_output=True, text=True).stderr
        peak = float(loud.split("max_volume:")[1].split("dB")[0])
        if peak < -12:
            raise RuntimeError(f"boom not audible in the mix (peak {peak} dB)")
        return f"{len(lib)} sounds, 4.5s package, boom peak {peak} dB"

    @check("load Twitch VOD (preview + chat)")
    def twitch():
        from clipper import chat, sources
        url = args[args.index("--twitch") + 1] if "--twitch" in args else None
        if not url:
            return "skipped (no --twitch url)"
        info = sources.probe(url)
        msgs = chat.fetch(info["twitch_id"], 600, 660, Ctx())
        return f"{info['title'][:40]} preview={info['preview_type']} chat_msgs_1min={len(msgs)}"

    @check("Ollama download + real LLM call", 1200)
    def llm():
        if "--llm" not in args:
            return "skipped (pass --llm)"
        from clipper import config as cfg, moments, setup_tasks
        cfg.LLM_MODEL = "qwen3:0.6b"
        setup_tasks._ollama("ollama")
        setup_tasks._llm("llm")
        words = json.loads((tmp / "words.json").read_text())
        lines = moments.build_lines(words)
        transcript = "\n".join(f"[{ln['i']}] (00:0{int(ln['start'])}) {ln['text']}" for ln in lines)
        out = moments.ask_llm(moments.PROMPT.format(kind="video", signal_help="", k=1, min_len=2, max_len=10,
                                                    transcript=transcript))
        from clipper import packaging
        marks = packaging.suggest_sfx(words, "Nobody expected that", 6.0)
        if not marks:
            raise RuntimeError("sound suggestions came back empty")
        return f"moments: {json.dumps(out)[:100]} | suggested sfx: {[(m['t'], m['sound']) for m in marks]}"

    @check("overnight auto run on a whole Twitch VOD (scaled down)", 2400)
    def auto():
        url = args[args.index("--twitch") + 1] if "--twitch" in args else None
        if not url or "--llm" not in args:
            return "skipped (needs --twitch and --llm)"
        from clipper import autoclip, config as cfg, jobs
        cfg.JUDGE_THINK = True
        j = jobs.Job(url, {"mode": "auto", "max_clips": 1, "max_candidates": 3, "min_len": 10, "max_len": 40,
                           "layout": "auto"}, jid="selftest-auto")
        autoclip.run(j, Ctx())
        if not j.clips:
            raise RuntimeError("no clips came out")
        c = j.clips[0]
        out = j.dir / c["file"]
        d = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height:format=duration",
                                       "-of", "json", str(out)], capture_output=True, text=True).stdout)
        if (d["streams"][0]["width"], d["streams"][0]["height"]) != (1080, 1920):
            raise RuntimeError(f"bad clip {d}")
        judged = json.loads((j.dir / "judged.json").read_text())
        return (f"{len(judged)} judged, clip at {c['abs_start']:.0f}s score {c['score']} "
                f"({float(d['format']['duration']):.0f}s) why={c.get('why')} | {c.get('what_happens', '')[:80]}")

    for fn in (tools, web, stt, rend, pkg, twitch, llm, auto):
        fn()
    if "--llm" in args:
        from clipper import setup_tasks
        setup_tasks.stop_ollama()
    sys.stdout.flush()

    print("\n=== SELFTEST RESULTS ===")
    ok = True
    for name, passed, detail in results:
        ok &= passed
        print(f"{'PASS' if passed else 'FAIL'}  {name}: {detail}")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
