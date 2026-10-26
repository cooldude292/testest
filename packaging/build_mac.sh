#!/usr/bin/env bash
# Builds dist/Clipworks.dmg on an Apple Silicon Mac. Used by CI; works locally too.
set -uo pipefail
set -e
cd "$(dirname "$0")/.."
mkdir -p build/bin

fetch_zip() {  # url, binary name
  curl -fsSL -o "build/$2.zip" "$1"
  unzip -o -q "build/$2.zip" -d "build/$2_unz"
  find "build/$2_unz" -type f -name "$2" -exec cp {} "build/bin/$2" \;
  chmod +x "build/bin/$2"
  test -x "build/bin/$2"
}

fetch_gz() {  # url, binary name
  curl -fsSL "$1" | gunzip > "build/bin/$2"
  chmod +x "build/bin/$2"
}

works() { [ -x "build/bin/$1" ] && "build/bin/$1" -hide_banner -version >/dev/null 2>&1; }

echo "==> Static ffmpeg/ffprobe (arm64)"
# Cached between CI runs; otherwise try the primary build host, then a GitHub-hosted fallback.
for b in ffmpeg ffprobe; do
  if works "$b"; then echo "$b: cached"; continue; fi
  if ! fetch_zip "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/$b.zip" "$b" || ! works "$b"; then
    echo "$b: primary host failed, using ffmpeg-static fallback"
    fetch_gz "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/$b-darwin-arm64.gz" "$b"
  fi
  works "$b"
done
build/bin/ffmpeg -hide_banner -version | head -1
otool -L build/bin/ffmpeg | tail -n +2

echo "==> deno (yt-dlp needs a JS runtime for YouTube)"
[ -x build/bin/deno ] || fetch_zip "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip" deno
build/bin/deno --version | head -1

echo "==> Icon"
python packaging/make_icon.py build/Clipworks.iconset
iconutil -c icns build/Clipworks.iconset -o build/Clipworks.icns

echo "==> PyInstaller"
pyinstaller --noconfirm --clean packaging/clipworks.spec

echo "==> Sign (ad-hoc) and verify"
codesign --force --deep --sign - dist/Clipworks.app
codesign --verify --deep --strict dist/Clipworks.app

echo "==> DMG"
rm -rf build/dmg && mkdir -p build/dmg
cp -R dist/Clipworks.app build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -volname "Clipworks" -srcfolder build/dmg -ov -format UDZO dist/Clipworks.dmg
du -sh dist/Clipworks.app dist/Clipworks.dmg
