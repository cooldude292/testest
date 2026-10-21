# Clipper

A bare-bones, fully local OpusClip. Paste a YouTube / Twitch / Kick link (anything
yt-dlp handles) or pick a file, and it spits out vertical 9:16 clips with
word-by-word captions and a hook title. Nothing leaves your machine.

## Run it (Mac, Apple Silicon)

```bash
mkdir -p ~/Clipper && curl -fsSL https://github.com/cooldude292/testest/archive/refs/heads/claude/busy-mccarthy-3t772e.tar.gz | tar xz --strip-components=1 -C ~/Clipper && ~/Clipper/start.sh
```

That installs Homebrew if needed, then `ffmpeg`, `uv`, `deno` and `ollama`, sets up
Python, and opens http://127.0.0.1:8765. The page shows the model downloads
(about 5GB for the LLM, 1.6GB for Whisper) with live progress. Jobs you submit
before that finishes just wait in line.

Next time, just run `~/Clipper/start.sh`. Running the long command again
updates the code and keeps your models and clips.

## What happens to a video

1. **Download**: yt-dlp, capped at 1080p. Use "Only this part" (like `1:00:00-1:45:00`)
   on long streams. For Twitch and Kick it grabs just the chunks in that range, in
   parallel, so 10 minutes out of an 8 hour VOD takes seconds.
2. **Chat** (Twitch only): pulls the chat replay for that range, plus a sample of
   the whole stream to know what "normal" chat speed is. Chat spiking is the best
   sign something happened.
3. **Transcribe**: Whisper large-v3-turbo through MLX, word-level timestamps.
4. **Find moments**: the transcript goes to a local LLM (`qwen3:8b` via Ollama) in
   ~8 minute chunks, with chat spikes and loud moments marked on each line. Then a
   second pass ranks all the candidates against each other and rewrites the hooks.
   The final score mixes the LLM's opinion with the raw chat/loudness signals, and
   anything that scores under 35 gets dropped.
5. **Render**, with the layout picked automatically:
   - **follow faces**: big faces on screen (podcasts, just chatting). The crop follows
     whoever's mouth is moving and frames the group when everyone fits.
   - **facecam top, game bottom**: a small face that stays in one spot is a webcam
     overlay, so it goes on top and the middle of the gameplay goes underneath.
   - **zoom into gameplay**: no faces at all. Crops into the middle of the game.
   - **fit + blur** and **center crop** are there if you want to force them.

Clips land in `~/Clipper/workspace/jobs/<job>/clip_01.mp4` and so on. Failed jobs have a
Retry button that reuses the download and transcript.

## Knobs

Set these before `start.sh`, e.g. `CLIPPER_LLM=qwen3:14b ~/Clipper/start.sh`.

| Variable | Default | What |
|---|---|---|
| `CLIPPER_LLM` | `qwen3:8b` | Any Ollama model. `qwen3:14b` is smarter and still fits in 24GB. |
| `CLIPPER_WHISPER` | `mlx-community/whisper-large-v3-turbo` | Any MLX Whisper repo. |
| `CLIPPER_COOKIES_FROM` | unset | `chrome`, `safari`, `firefox`... Force using that browser's logins for downloads. |
| `CLIPPER_PORT` | `8765` | Web page port. |
| `CLIPPER_DATA` | `./workspace` | Where jobs and clips go. |

## Known rough edges

- YouTube sometimes says "confirm you're not a bot". Clipper then retries with your
  browser's cookies automatically. Being logged into YouTube in Chrome helps.
  macOS may pop a Keychain prompt for that; allow it.
- Speaker tracking watches mouths, not audio. Fast back-and-forth or people
  chewing gum can fool it. Pick "center crop" or "fit + blur" if it gets weird.
- A really tiny facecam might not get detected, and then you get the gameplay zoom
  instead of the split.
- Reaction content (streamer watching a video) can come out confusing, because the clip
  shows the reaction but the thing they're reacting to is off to the side.
- The LLM's virality score is a guess. Watch the clips.
