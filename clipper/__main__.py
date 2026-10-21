import os
import socket
import threading
import webbrowser

from . import config


def main():
    url = f"http://127.0.0.1:{config.PORT}"
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", config.PORT)) == 0:
            print(f"Clipper is already running at {url}")
            webbrowser.open(url)
            return

    import uvicorn
    from .server import app

    if not os.environ.get("CLIPPER_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"\n  Clipper running at {url}  (Ctrl+C to stop)\n")
    uvicorn.run(app, host="127.0.0.1", port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
