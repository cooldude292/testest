import subprocess


def ffmpeg(*args):
    """Run ffmpeg quietly; on failure raise with its actual error text instead of a bare exit code."""
    p = subprocess.run(["ffmpeg", "-y", "-v", "error", *map(str, args)], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg: " + (p.stderr.strip()[-600:] or f"exit {p.returncode}"))
