#!/usr/bin/env bash
# One-shot setup + launch for Clipper. Safe to run again any time.
set -e
cd "$(dirname "$0")"

say() { printf "\n\033[1;33m==> %s\033[0m\n" "$*"; }

if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
      if [ -x "$b" ]; then eval "$("$b" shellenv)"; fi
    done
  fi
  if ! command -v brew >/dev/null 2>&1; then
    say "Installing Homebrew (it will ask for your Mac password)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
  NEED=""
  for p in ffmpeg uv deno ollama; do
    command -v "$p" >/dev/null 2>&1 || NEED="$NEED $p"
  done
  if [ -n "$NEED" ]; then
    say "Installing:$NEED"
    brew install $NEED
  fi
else
  command -v ffmpeg >/dev/null 2>&1 || { echo "Install ffmpeg first (e.g. sudo apt install ffmpeg)"; exit 1; }
  if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  command -v ollama >/dev/null 2>&1 || echo "Heads up: Ollama isn't installed. Get it from https://ollama.com"
fi

say "Setting up Python packages"
[ -d .venv ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -q -r requirements.txt
# YouTube breaks old yt-dlp versions constantly, so always grab the newest.
uv pip install --python .venv/bin/python -q -U "yt-dlp[default]"

say "Starting Clipper. Model downloads show up on the page."
exec .venv/bin/python -m clipper
