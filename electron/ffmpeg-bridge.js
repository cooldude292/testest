/* ─── Lumen Desktop — FFmpeg bridge ──────────────────────────────
 *  Called directly from main.js (not over IPC).
 *  Wraps ffprobe and ffmpeg via the ffmpeg-static package.
 * ─────────────────────────────────────────────────────────────── */
"use strict";

const { spawn } = require("child_process");
const path = require("path");

/* ── Resolve paths to ffmpeg / ffprobe ────────────────────────── */
function resolveBinaries() {
  let ffmpegPath = null;
  let ffprobePath = null;

  try {
    /* ffmpeg-static exports the path to the ffmpeg binary */
    ffmpegPath = require("ffmpeg-static");

    /* ffprobe sits alongside ffmpeg in the same directory */
    if (ffmpegPath) {
      const dir = path.dirname(ffmpegPath);
      const ext = process.platform === "win32" ? ".exe" : "";
      ffprobePath = path.join(dir, "ffprobe" + ext);
    }
  } catch (_) {
    /* ffmpeg-static not installed — graceful degradation */
  }

  return { ffmpegPath, ffprobePath };
}

/* ── Parse time string "HH:MM:SS.mmm" → seconds ─────────────── */
function parseTime(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(":").map(parseFloat);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parseFloat(timeStr) || 0;
}

/* ── probe(filePath) → Object | null ─────────────────────────── */
async function probe(filePath) {
  const { ffprobePath } = resolveBinaries();

  if (!ffprobePath) {
    console.warn("ffprobe-bridge: ffprobe not available (ffmpeg-static not installed)");
    return null;
  }

  return new Promise((resolve) => {
    const args = [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ];

    let stdout = "";
    let stderr = "";

    const proc = spawn(ffprobePath, args);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      console.warn("ffprobe-bridge: spawn error:", err.message);
      resolve(null);
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.warn("ffprobe-bridge: exited with code", code, stderr.slice(0, 200));
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        console.warn("ffprobe-bridge: JSON parse error:", parseErr.message);
        resolve(null);
      }
    });
  });
}

/* ── export(opts, progressCb) → { success, path } ───────────── */
/*
 * opts:
 *   inputPath   {string}  - source file
 *   outputPath  {string}  - destination file
 *   codec       {string}  - video codec  (e.g. "libx264")
 *   crf         {number}  - CRF value    (e.g. 23)
 *   width       {number}  - output width  (0 = passthrough)
 *   height      {number}  - output height (0 = passthrough)
 *   fps         {number}  - frame rate    (0 = passthrough)
 *   audioCodec  {string}  - audio codec  (e.g. "aac")
 *   audioBitrate {string} - audio bitrate (e.g. "192k")
 */
async function exportMedia(opts, progressCb) {
  const { ffmpegPath, ffprobePath } = resolveBinaries();

  if (!ffmpegPath) {
    console.warn("ffmpeg-bridge: ffmpeg not available (ffmpeg-static not installed)");
    return { success: false, error: "ffmpeg not available" };
  }

  const {
    inputPath,
    outputPath,
    codec = "libx264",
    crf = 23,
    width = 0,
    height = 0,
    fps = 0,
    audioCodec = "aac",
    audioBitrate = "192k",
  } = opts;

  /* First probe to get total duration for progress calculation */
  let totalSeconds = 0;
  try {
    const meta = await probe(inputPath);
    if (meta && meta.format && meta.format.duration) {
      totalSeconds = parseFloat(meta.format.duration) || 0;
    }
  } catch (_) {
    /* ignore probe failure — progress will not be reported */
  }

  return new Promise((resolve) => {
    const args = ["-y", "-i", inputPath];

    /* Video options */
    args.push("-c:v", codec);
    if (crf != null) args.push("-crf", String(crf));

    if (width > 0 && height > 0) {
      args.push("-vf", "scale=" + width + ":" + height);
    } else if (width > 0) {
      args.push("-vf", "scale=" + width + ":-2");
    } else if (height > 0) {
      args.push("-vf", "scale=-2:" + height);
    }

    if (fps > 0) args.push("-r", String(fps));

    /* Audio options */
    args.push("-c:a", audioCodec);
    if (audioBitrate) args.push("-b:a", audioBitrate);

    args.push(outputPath);

    let stderr = "";

    const proc = spawn(ffmpegPath, args);

    /* ffmpeg writes progress to stderr */
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (totalSeconds > 0 && progressCb) {
        /* Parse lines like "frame= 120 fps= 25 ... time=00:00:04.80 ..." */
        const match = text.match(/time=(\d+:\d+:\d+\.?\d*)/);
        if (match) {
          const elapsed = parseTime(match[1]);
          const pct = Math.min(1, elapsed / totalSeconds);
          try {
            progressCb(pct);
          } catch (_) {
            /* ignore callback errors */
          }
        }
      }
    });

    proc.on("error", (err) => {
      console.warn("ffmpeg-bridge: spawn error:", err.message);
      resolve({ success: false, error: err.message });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        if (progressCb) {
          try { progressCb(1); } catch (_) {}
        }
        resolve({ success: true, path: outputPath });
      } else {
        const errSnippet = stderr.slice(-500);
        console.warn("ffmpeg-bridge: exited with code", code, errSnippet);
        resolve({ success: false, error: "ffmpeg exited with code " + code });
      }
    });
  });
}

module.exports = {
  probe,
  export: exportMedia,
};
