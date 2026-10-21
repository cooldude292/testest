"""CI check: the Workbench loads a Twitch VOD and the preview actually plays in Safari (WebKit),
the same engine the app window uses. Run against `Clipworks --serve`."""
import sys
import time

from selenium import webdriver
from selenium.webdriver.common.by import By

URL = sys.argv[1]
d = webdriver.Safari()
try:
    d.get("http://127.0.0.1:8765/")
    time.sleep(2)
    d.find_element(By.ID, "src-input").send_keys(URL)
    d.find_element(By.ID, "src-load").click()
    for _ in range(60):
        if d.find_element(By.ID, "wb-loaded").is_displayed():
            break
        time.sleep(1)
    d.execute_script("video.muted = true; video.currentTime = 600; video.play();")
    state = {}
    for _ in range(45):
        state = d.execute_script("return {rs: video.readyState, t: video.currentTime, w: video.videoWidth,"
                                 " err: video.error && video.error.code, msg: document.getElementById('player-msg').innerText}")
        if state["rs"] >= 3 and state["t"] > 601 and state["w"] > 0:
            break
        time.sleep(1)
    d.save_screenshot("webkit_workbench.png")
    print("video state:", state)
    if not (state["rs"] >= 3 and state["w"] > 0):
        sys.exit("preview did not play in WebKit")
    print("PASS  WebKit preview playback")
finally:
    d.quit()
