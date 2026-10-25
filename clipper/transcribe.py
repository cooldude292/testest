"""Speech to text with word-level timestamps."""
import types
import wave

import numpy as np

from . import config


def transcribe(audio_path, duration, ctx, span=None):
    """Returns a flat list of words: [{"w": text, "s": start, "e": end}, ...].

    span=(a, b) transcribes just that stretch of a 16 kHz mono wav (times stay absolute), so
    a 10-hour stream never has to sit in memory at once."""
    if span:
        a, b = span
        audio = read_wav(audio_path, a, b)
        fn = _mlx if config.IS_APPLE_SILICON else _faster_whisper
        words = fn(audio, len(audio) / 16000, ctx)
        return [{"w": w["w"], "s": w["s"] + a, "e": w["e"] + a} for w in words]
    if config.IS_APPLE_SILICON:
        return _mlx(str(audio_path), duration, ctx)
    return _faster_whisper(read_wav(audio_path), duration, ctx)


def read_wav(path, a=None, b=None):
    """Float samples of a 16-bit wav, optionally just seconds a..b."""
    with wave.open(str(path)) as wf:
        sr = wf.getframerate()
        if a is not None:
            wf.setpos(min(int(a * sr), wf.getnframes()))
            n = int((b - a) * sr)
        else:
            n = wf.getnframes()
        return np.frombuffer(wf.readframes(n), np.int16).astype(np.float32) / 32768.0


def _mlx(audio, duration, ctx):
    import mlx_whisper
    import mlx_whisper.transcribe as mt

    # mlx_whisper reports progress through tqdm; swap in a bar that feeds our status.
    class Bar:
        def __init__(self, total=None, **_):
            self.total = total or 1
            self.n = 0

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def update(self, n=1):
            self.n += n
            frac = min(1.0, self.n / self.total)
            ctx.stage("transcribe", frac, f"Transcribing: {frac*duration/60:.1f} / {duration/60:.1f} min")
            ctx.check()

    mt.tqdm = types.SimpleNamespace(tqdm=Bar)
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=config.WHISPER_MODEL,
        word_timestamps=True,
        condition_on_previous_text=False,
        verbose=False,
    )
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({"w": w["word"], "s": float(w["start"]), "e": float(w["end"])})
    return words


_fw_model = None


def _faster_whisper(audio, duration, ctx):
    # Takes samples, not a path: faster-whisper's own decoder breaks on newer PyAV.
    global _fw_model
    from faster_whisper import WhisperModel

    if _fw_model is None:
        _fw_model = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    model = _fw_model
    segments, info = model.transcribe(
        audio,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    total = info.duration or duration or 1
    words = []
    for seg in segments:
        ctx.check()
        for w in seg.words or []:
            words.append({"w": w.word, "s": float(w.start), "e": float(w.end)})
        frac = min(1.0, seg.end / total)
        ctx.stage("transcribe", frac, f"Transcribing: {seg.end/60:.1f} / {total/60:.1f} min")
    return words
