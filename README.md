# Clipworks

Local clip factory for streams and long videos. Load a stream, find the good part,
send it to the factory, get finished 9:16 clips with captions and a hook. Everything
runs on your Mac. No accounts, no uploads, no subscription.

## Install (Mac, Apple Silicon)

1. Download **[Clipworks.dmg](https://github.com/cooldude292/testest/releases/download/clipworks-latest/Clipworks.dmg)**.
2. Open it and drag Clipworks into Applications.
3. Open Clipworks. macOS will refuse the first time because the app isn't signed with
   a paid Apple developer account. Go to **System Settings → Privacy & Security**, scroll
   down, click **Open Anyway**. You only do this once.
   (Terminal alternative: `xattr -dr com.apple.quarantine /Applications/Clipworks.app`)

On first launch the System page downloads the AI models (about 7GB total: the
language model, the speech model, and Ollama if you don't have it). You can load
footage while that runs; the factory starts once they're ready.

## How it works

**Workbench.** Paste a Twitch, YouTube or Kick link, or open a file. It plays right
there. Under the player is a timeline:

- Twitch: a heatmap of chat activity for the whole stream (built from the chat replay,
  about a minute for a 4 hour stream). Hot spots are listed on the right.
- YouTube: the "most replayed" graph, when YouTube has one.
- Drag on the timeline to select a range, drag the edges to trim, or use
  <kbd>I</kbd> / <kbd>O</kbd> to mark in and out at the playhead. <kbd>Space</kbd> plays,
  <kbd>J</kbd>/<kbd>L</kbd> jump 10 seconds, arrow keys 5 (shift for 60).

Pick how many clips, how long, and the layout, then **Send to Factory**. Nothing is
transcribed up front. Only the range you sent gets downloaded and processed.

**Factory.** Each work order moves through the stations:
Intake (download just that range) → Audio → Chat → Transcribe (Whisper on the
GPU) → Analysis (local LLM picks moments using the transcript, chat spikes and
loudness, then ranks them and writes hooks) → Assembly (reframe, captions, encode).

**Inventory.** Finished clips, searchable and sortable. They're also copied to
`~/Movies/Clipworks/WO-1234 <title>/`.

Layouts, picked automatically unless you choose one:
- **Facecam over gameplay** when there's a webcam overlay
- **Follow speaker** for podcasts and just chatting
- **Gameplay zoom** when there are no faces
- **Full frame, blurred fill** and **Center crop** if you want them

## Building

GitHub Actions builds the DMG on a macOS runner on every push to this branch
(`.github/workflows/mac-app.yml`), runs a self-test against the packaged app
(transcription, rendering, Twitch loading, and a real Ollama call), and publishes
it to the `clipworks-latest` release.

Locally on a Mac: `pip install -r requirements-app.txt && bash packaging/build_mac.sh`.

Developer mode without packaging: `./start.sh` runs the same engine and opens the UI
in your browser.

## Settings

Environment variables, mostly for development:

| Variable | Default | What |
|---|---|---|
| `CLIPPER_LLM` | `qwen3:8b` | Any Ollama model. `qwen3:14b` is smarter and fits in 24GB. |
| `CLIPPER_WHISPER` | `mlx-community/whisper-large-v3-turbo` | Any MLX Whisper repo. |
| `CLIPPER_COOKIES_FROM` | unset | `chrome`, `safari`, `firefox`... use that browser's logins for downloads. |

## Known rough edges

- Unsigned app, so the one-time Open Anyway step.
- YouTube sometimes demands a login. Clipworks retries with your browser's cookies;
  macOS may ask for Keychain access when it does.
- Speaker tracking watches mouths, not audio. Fast back-and-forth can fool it.
- A really tiny facecam might not get detected; you'll get the gameplay zoom instead.
- Reaction content can come out confusing, since the clip shows the reaction but not
  always what they're reacting to.
- The LLM's virality score is a guess. Watch the clips.
