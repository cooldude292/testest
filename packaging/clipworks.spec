# PyInstaller spec for the Clipworks macOS app. Run from the repo root via packaging/build_mac.sh.
from PyInstaller.utils.hooks import collect_all

datas = [("clipper/static", "clipper/static"), ("clipper/fonts", "clipper/fonts"),
         ("clipper/models", "clipper/models")]
binaries = [("build/bin/ffmpeg", "bin"), ("build/bin/ffprobe", "bin"), ("build/bin/deno", "bin")]
hiddenimports = ["uvicorn.logging", "uvicorn.loops.auto", "uvicorn.protocols.http.auto",
                 "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on", "clipper.selftest"]
for pkg in ("mlx", "mlx_whisper", "yt_dlp", "yt_dlp_ejs", "cv2", "webview", "tiktoken", "tiktoken_ext",
            "numba", "llvmlite", "certifi"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(["app_main.py"], pathex=["."], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
             excludes=["torch", "torchvision", "torchaudio", "tkinter", "matplotlib", "IPython", "pytest",
                       "faster_whisper", "ctranslate2"],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Clipworks", console=False,
          argv_emulation=False, target_arch="arm64", codesign_identity=None)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="Clipworks")
app = BUNDLE(coll, name="Clipworks.app", icon="build/Clipworks.icns", bundle_identifier="com.clipworks.desktop",
             info_plist={
                 "CFBundleName": "Clipworks", "CFBundleDisplayName": "Clipworks",
                 "CFBundleShortVersionString": "2026.10", "CFBundleVersion": "2026.10",
                 "LSMinimumSystemVersion": "13.0", "NSHighResolutionCapable": True,
                 "NSRequiresAquaSystemAppearance": False, "LSApplicationCategoryType": "public.app-category.video",
             })
