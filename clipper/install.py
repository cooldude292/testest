"""Keep exactly one Clipworks on the Mac.

Opened from the DMG (or Downloads): copy into /Applications, old version to the Trash, reopen
from there. Opened from /Applications: trash leftover copies and the DMG, eject the disk image.
Everything goes to the Trash rather than being deleted, so a mistake is recoverable.
"""
import glob
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

APPS = Path("/Applications")
NAME = "Clipworks"


def _bundle():
    """Path of the running .app, or None when not running as a packaged Mac app."""
    if sys.platform != "darwin" or not getattr(sys, "frozen", False):
        return None
    p = Path(sys.executable).resolve()
    for parent in p.parents:
        if parent.suffix == ".app":
            return parent
    return None


def _trash(path):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return
    trash = Path.home() / ".Trash"
    dest = trash / path.name
    if dest.exists():
        dest = trash / f"{path.stem} {time.strftime('%H.%M.%S')}{path.suffix}"
    try:
        shutil.move(str(path), str(dest))
    except OSError:
        pass


def _install(bundle):
    target = APPS / f"{NAME}.app"
    staging = APPS / f".{NAME}-new.app"
    shutil.rmtree(staging, ignore_errors=True)
    subprocess.run(["ditto", str(bundle), str(staging)], check=True)
    # The copy came from a downloaded DMG; the user already approved it once.
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", str(staging)], capture_output=True)
    if target.exists():
        _trash(target)
    staging.rename(target)
    subprocess.Popen(["open", "-n", str(target)])


def _cleanup(bundle):
    home = Path.home()
    for pattern in (f"{home}/Downloads/{NAME}*.app", f"{home}/Desktop/{NAME}*.app", f"{home}/Applications/{NAME}*.app",
                    f"/Applications/{NAME} *.app", f"{home}/Downloads/{NAME}*.dmg", f"{home}/Desktop/{NAME}*.dmg"):
        for p in glob.glob(pattern):
            if Path(p).resolve() != bundle:
                _trash(p)
    for vol in glob.glob(f"/Volumes/{NAME}*"):
        subprocess.run(["hdiutil", "detach", vol, "-quiet"], capture_output=True)


def run():
    """Returns True when this process should quit because the installed copy was launched."""
    if os.environ.get("CLIPWORKS_NO_INSTALL"):
        return False
    bundle = _bundle()
    if not bundle:
        return False
    try:
        if bundle.parent != APPS:
            _install(bundle)
            return True
        _cleanup(bundle)
    except Exception as ex:  # never block the app from opening over housekeeping
        print(f"install/cleanup skipped: {ex}", file=sys.stderr)
    return False
