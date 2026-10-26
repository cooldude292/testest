"""Clipworks desktop app: runs the engine in-process and shows it in a native window."""
import multiprocessing
import os
import socket
import sys
import threading
import time

os.environ.setdefault("CLIPWORKS_APP", "1")


def _free_port(preferred):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", preferred)) != 0:
            return preferred
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    # Libraries that spawn helper processes re-run this executable in a packaged app;
    # without this, each helper would open another Clipworks window.
    multiprocessing.freeze_support()

    if "--selftest" in sys.argv:
        from clipper import selftest
        code = selftest.run(sys.argv[sys.argv.index("--selftest") + 1:])
        sys.stdout.flush()
        os._exit(code)  # don't wait on library worker threads

    from clipper import install
    if install.run():  # just copied into /Applications and reopened from there
        return

    from clipper import config
    port = _free_port(config.PORT)

    import uvicorn
    from clipper import setup_tasks
    from clipper.server import app

    if "--serve" in sys.argv:  # engine only, no window (CI browser tests)
        uvicorn.run(app, host="127.0.0.1", port=config.PORT, log_level="warning")
        return

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                break
        time.sleep(0.1)

    import webview
    webview.settings["ALLOW_DOWNLOADS"] = True

    class Api:
        def pick_file(self):
            kind = getattr(getattr(webview, "FileDialog", None), "OPEN", None) or webview.OPEN_DIALOG
            picked = window.create_file_dialog(
                kind, allow_multiple=False,
                file_types=("Video files (*.mp4;*.mov;*.mkv;*.webm;*.m4v;*.ts)", "All files (*.*)"))
            return picked[0] if picked else None

    window = webview.create_window(config.APP_NAME, f"http://127.0.0.1:{port}/", js_api=Api(),
                                   width=1440, height=900, min_size=(1100, 700), background_color="#121417")
    webview.start()
    server.should_exit = True
    setup_tasks.stop_ollama()


if __name__ == "__main__":
    main()
