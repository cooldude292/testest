# PyInstaller spec for the Clipworks macOS app. Run from the repo root via packaging/build_mac.sh.
import os

from PyInstaller.utils.hooks import collect_all

ROOT = os.path.dirname(SPECPATH)  # spec lives in packaging/, everything else is relative to the repo
R = lambda *p: os.path.join(ROOT, *p)

datas = [(R("clipper/static"), "clipper/static"), (R("clipper/fonts"), "clipper/fonts"),
         (R("clipper/models"), "clipper/models")]
binaries = [(R("build/bin/ffmpeg"), "bin"), (R("build/bin/ffprobe"), "bin"), (R("build/bin/deno"), "bin")]
hiddenimports = ["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                 "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on", "clipper.selftest"]
for pkg in ("mlx", "mlx_whisper", "yt_dlp", "yt_dlp_ejs", "cv2", "webview", "tiktoken", "tiktoken_ext",
            "numba", "llvmlite", "certifi"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis([R("app_main.py")], pathex=[ROOT], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
             excludes=["torch", "torchvision", "torchaudio", "tkinter", "matplotlib", "IPython", "pytest",
                       "faster_whisper", "ctranslate2"],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Clipworks", console=False,
          argv_emulation=False, target_arch="arm64", codesign_identity=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Clipworks")
app = BUNDLE(coll, name="Clipworks.app", icon=R("build/Clipworks.icns"), bundle_identifier="com.clipworks.desktop",
             info_plist={
                 "CFBundleName": "Clipworks", "CFBundleDisplayName": "Clipworks",
                 "CFBundleShortVersionString": "2026.10", "CFBundleVersion": "2026.10",
                 "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True,
                 "NSRequiresAquaSystemAppearance": False, "LSApplicationCategoryType": "public.app-category.video",
             })
