"""Speech to text with word-level timestamps."""
import types
import wave

import numpy as np

from . import config


def transcribe(audio_path, duration, ctx):
    """Returns a flat list of words: [{"w": text, "s": start, "e": end}, ...]."""
    if config.IS_APPLE_SILICON:
        return _mlx(audio_path, duration, ctx)
    return _faster_whisper(audio_path, duration, ctx)


def _mlx(audio_path, duration, ctx):
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
        str(audio_path),
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


def _faster_whisper(audio_path, duration, ctx):
    from faster_whisper import WhisperModel

    model = WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")
    # Hand over samples instead of a path: faster-whisper's own decoder breaks on newer PyAV.
    with wave.open(str(audio_path)) as wf:
        audio = np.frombuffer(wf.readframes(wf.getnframes()), np.int16).astype(np.float32) / 32768.0
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
