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

It's a production console: a command line at the top, four modules on
<kbd>F1</kbd>–<kbd>F4</kbd>, and a status bar at the bottom showing what the factory is doing.

**F1 Workbench.** Paste a Twitch, YouTube or Kick link into the command line and press
GO (or Enter), or use Open file. The source plays in the monitor. Under it is the
signal timeline:

- Twitch: chat density for the whole stream, built from the chat replay (about a
  minute for a 4 hour stream). The strongest stretches are listed under Signal Peaks.
- YouTube: the "most replayed" graph, when YouTube has one.
- Drag on the timeline to select a range, drag the edges to trim, or mark In and Out
  at the playhead with <kbd>I</kbd> / <kbd>O</kbd>. <kbd>Space</kbd> plays,
  <kbd>J</kbd>/<kbd>L</kbd> jump 10 seconds, arrows 5 (shift for 60), <kbd>/</kbd> jumps
  to the command line.

Then fill in the work order and **Dispatch to Factory**:
- **AI selection**: the factory finds the best clips inside your range (you pick how
  many and how long).
- **Exact cut**: your range is the clip (3 seconds to 3 minutes). The factory just
  reframes it, captions it and writes the hook.

Nothing is transcribed up front. Only the range you dispatched gets downloaded and processed.

**F2 Factory.** Work orders (WO-1001, WO-1002...) on a production line. Each one moves
through Intake (download just that range) → Audio → Chat → Transcribe (Whisper on the
GPU) → Analysis (local LLM picks moments from the transcript, chat spikes and
loudness, ranks them, writes hooks) → Assembly (reframe, captions, encode). Select an
order to see its stations, spec and production log.

**F3 Inventory.** Every finished clip with score, hook, source timecode and layout.
Select one to play it, read the rationale and transcript, download it or reveal it in
Finder. Clips are also copied to `~/Movies/Clipworks/WO-1234 <title>/`.

**F4 System.** Model provisioning and configuration.

Commands you can type: a URL or file path, `WB` `FAC` `INV` `SYS`, `IN`, `OUT`, `SEND`,
`WO 1001`, `HELP`.

Layouts, picked automatically unless you choose one:
- **Facecam / gameplay** when there's a webcam overlay
- **Follow speaker** for podcasts and just chatting
- **Gameplay zoom** when there are no faces
- **Full frame / blur** and **Center crop** if you want them

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
