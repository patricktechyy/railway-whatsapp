import json
import os
import secrets
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, Optional

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SESSIONS_FILE = DATA_DIR / "sessions.json"
TOKENS_FILE = DATA_DIR / "websockify_tokens"
PROFILES_DIR = DATA_DIR / "profiles"
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
BASE_URL = os.environ.get("BASE_URL", "")
START_DISPLAY = int(os.environ.get("START_DISPLAY", "101"))
SCREEN = os.environ.get("SCREEN", "1366x768x24")

app = FastAPI(title="Private WhatsApp Browser Gateway")
lock = threading.Lock()
runtime: Dict[str, Dict[str, subprocess.Popen]] = {}
sessions: Dict[str, dict] = {}


def load_sessions():
    global sessions
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    if SESSIONS_FILE.exists():
        try:
            sessions = json.loads(SESSIONS_FILE.read_text())
        except Exception:
            sessions = {}
    else:
        sessions = {}
    sync_tokens()


def save_sessions():
    tmp = SESSIONS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(sessions, indent=2))
    tmp.replace(SESSIONS_FILE)


def sync_tokens():
    lines = []
    for s in sessions.values():
        lines.append(f"{s['token']}: 127.0.0.1:{s['vnc_port']}")
    TOKENS_FILE.write_text("\n".join(lines) + ("\n" if lines else ""))


def next_numbers():
    used = {(s["display"], s["vnc_port"]) for s in sessions.values()}
    n = START_DISPLAY
    while (n, 5900 + (n - 100)) in used:
        n += 1
    return n, 5900 + (n - 100)


def run_as_browser(cmd, env=None):
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return subprocess.Popen(
        ["runuser", "-u", "browser", "--"] + cmd,
        env=merged,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )


def start_session(sid: str):
    s = sessions[sid]
    profile = PROFILES_DIR / sid
    profile.mkdir(parents=True, exist_ok=True)
    subprocess.run(["chown", "-R", "browser:browser", str(profile)], check=False)

    display = f":{s['display']}"
    env = {
        "DISPLAY": display,
        "HOME": "/home/browser",
        "XDG_RUNTIME_DIR": "/run/user/1000",
        "MOZ_ENABLE_WAYLAND": "0",
    }

    xvfb = run_as_browser(["Xvfb", display, "-screen", "0", SCREEN, "-nolisten", "tcp"], env)
    time.sleep(0.4)
    wm = run_as_browser(["openbox", "--sm-disable"], env)
    vnc = run_as_browser([
        "x11vnc", "-display", display,
        "-rfbport", str(s["vnc_port"]),
        "-forever", "-shared", "-noxdamage", "-nopw", "-localhost"
    ], env)
    time.sleep(0.4)
    firefox = run_as_browser([
        "firefox", "--no-remote", "--new-instance",
        "--profile", str(profile), "https://web.whatsapp.com/"
    ], env)

    runtime[sid] = {"xvfb": xvfb, "wm": wm, "vnc": vnc, "firefox": firefox}


def stop_process(p: Optional[subprocess.Popen]):
    if p is None or p.poll() is not None:
        return
    try:
        os.killpg(p.pid, signal.SIGTERM)
        p.wait(timeout=3)
    except Exception:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass


def stop_session(sid: str):
    procs = runtime.pop(sid, {})
    # Kill Firefox first, then display stack.
    for name in ("firefox", "vnc", "wm", "xvfb"):
        stop_process(procs.get(name))


def monitor_sessions():
    while True:
        time.sleep(5)
        with lock:
            for sid in list(sessions):
                procs = runtime.get(sid)
                if not procs:
                    try:
                        start_session(sid)
                    except Exception:
                        pass
                    continue
                # If a display stack died, rebuild it. This preserves the Firefox profile.
                if any(p.poll() is not None for p in procs.values()):
                    stop_session(sid)
                    try:
                        start_session(sid)
                    except Exception:
                        pass


@app.on_event("startup")
def startup():
    load_sessions()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (Path("/run/user/1000")).mkdir(parents=True, exist_ok=True)
    subprocess.run(["chown", "browser:browser", "/run/user/1000"], check=False)
    for sid in sessions:
        try:
            start_session(sid)
        except Exception:
            pass
    threading.Thread(target=monitor_sessions, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True, "sessions": len(sessions), "running": len(runtime)}


@app.post("/api/sessions")
def create_session(x_admin_key: Optional[str] = Header(default=None)):
    if not ADMIN_KEY or not secrets.compare_digest(x_admin_key or "", ADMIN_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")
    with lock:
        display, vnc_port = next_numbers()
        sid = secrets.token_urlsafe(18).replace("-", "_")
        token = secrets.token_urlsafe(32)
        sessions[sid] = {
            "id": sid,
            "token": token,
            "display": display,
            "vnc_port": vnc_port,
            "created_at": int(time.time()),
        }
        save_sessions()
        sync_tokens()
        start_session(sid)
    url = f"{BASE_URL}/s/{sid}" if BASE_URL else f"/s/{sid}"
    return {"id": sid, "url": url}


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str, x_admin_key: Optional[str] = Header(default=None)):
    if not ADMIN_KEY or not secrets.compare_digest(x_admin_key or "", ADMIN_KEY):
        raise HTTPException(status_code=401, detail="Unauthorized")
    with lock:
        if sid not in sessions:
            raise HTTPException(status_code=404, detail="Not found")
        stop_session(sid)
        sessions.pop(sid, None)
        profile = PROFILES_DIR / sid
        shutil.rmtree(profile, ignore_errors=True)
        save_sessions()
        sync_tokens()
    return {"ok": True}


@app.get("/s/{sid}", response_class=HTMLResponse)
def session_page(sid: str):
    s = sessions.get(sid)
    if not s:
        raise HTTPException(status_code=404, detail="Session not found")
    token = s["token"]
    return HTMLResponse(f"""<!doctype html>
<html>
<head>
<meta charset='utf-8'>
<meta name='viewport' content='width=device-width,initial-scale=1,viewport-fit=cover'>
<title>WhatsApp</title>
<style>
html,body,#screen{{width:100%;height:100%;margin:0;background:#111;overflow:hidden}}
#loading{{position:fixed;inset:0;display:grid;place-items:center;color:#eee;font:16px system-ui;background:#111;z-index:2}}
</style>
</head>
<body>
<div id='loading'>Connecting…</div><div id='screen'></div>
<script type='module'>
import RFB from '/novnc/core/rfb.js';
const token = {json.dumps(token)};
const screen = document.getElementById('screen');
const loading = document.getElementById('loading');
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = `${{scheme}}://${{location.host}}/websockify?token=${{encodeURIComponent(token)}}`;
const rfb = new RFB(screen, ws);
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.clipViewport = false;
rfb.showDotCursor = true;
rfb.focusOnClick = true;
rfb.addEventListener('connect', () => loading.style.display='none');
rfb.addEventListener('disconnect', () => {{ loading.textContent='Disconnected — reload to reconnect'; loading.style.display='grid'; }});
window.addEventListener('beforeunload', () => {{ try {{ rfb.disconnect(); }} catch {{}} }});
</script>
</body>
</html>""")


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse("""<!doctype html><html><head><meta charset='utf-8'><title>WhatsApp Browser</title></head>
<body style='font-family:system-ui;max-width:700px;margin:60px auto;padding:20px'>
<h1>WhatsApp Browser</h1><p>This service is private. Use your assigned session URL.</p></body></html>""")
