#!/usr/bin/env bash
set -euo pipefail

SESSIONS="${SESSIONS:-3}"
PORT="${PORT:-8080}"
DATA_DIR="${DATA_DIR:-/data}"
SCREEN="${SCREEN:-1440x900x24}"
KIOSK="${KIOSK:-1}"
START_URL="${START_URL:-https://web.whatsapp.com}"
BRAND="${BRAND:-WhatsApp Hub}"
NAMES="${NAMES:-}"
USERNAME="${USERNAME:-wa}"

CADDYFILE=/etc/caddy/Caddyfile
SUPCONF=/etc/supervisor/supervisord.conf
PORTAL=/srv/portal

mkdir -p /etc/caddy /etc/supervisor /srv "$PORTAL" /run/dbus "$DATA_DIR"

# ---------------------------------------------------------------- password ---
# One PASSWORD unlocks every session unless you set PASS_1 / PASS_2 / ... .
# If PASSWORD is unset, generate one ONCE and keep it on the volume so it
# survives redeploys.
PWFILE="${DATA_DIR}/.access-password"
if [ -z "${PASSWORD:-}" ]; then
  if [ -s "$PWFILE" ]; then
    PASSWORD="$(cat "$PWFILE")"
  else
    PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)"
    printf '%s' "$PASSWORD" > "$PWFILE"
    chmod 600 "$PWFILE"
  fi
fi

# bcrypt is slow, so hash each distinct password only once
declare -A HASHES
hash_for() {
  local p="$1"
  if [ -z "${HASHES[$p]:-}" ]; then
    HASHES[$p]="$(caddy hash-password --plaintext "$p")"
  fi
  printf '%s' "${HASHES[$p]}"
}

# ------------------------------------------------------------- supervisord ---
cat > "$SUPCONF" <<EOF
[supervisord]
nodaemon=true
loglevel=info
logfile=/dev/null
logfile_maxbytes=0
pidfile=/run/supervisord.pid

[program:caddy]
command=/usr/bin/caddy run --config ${CADDYFILE} --adapter caddyfile
priority=5
autorestart=true
startretries=10
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF

# --------------------------------------------------------------- Caddyfile ---
{
  echo ":${PORT} {"
  echo "  encode zstd gzip"
  echo "  handle /healthz {"
  echo "    respond \"ok\" 200"
  echo "  }"
} > "$CADDYFILE"

: > /tmp/cards.html
: > /tmp/portal-auth.txt

echo ""
echo "=================== ${BRAND} ==================="

for i in $(seq 1 "$SESSIONS"); do
  D=$((100 + i))            # X display  :101, :102, ...
  VNC=$((5900 + i))         # x11vnc     5901, 5902, ...
  WS=$((6080 + i))          # websockify 6081, 6082, ...
  PROF="${DATA_DIR}/profile-${i}"
  WEB="/srv/s${i}"

  mkdir -p "${PROF}/ff" "$WEB"

  # friendly label from NAMES="Ali,Budi,Citra"
  LABEL="$(printf '%s' "$NAMES" | cut -d, -f"$i")"
  [ -z "$LABEL" ] && LABEL="Session ${i}"

  # ---- per-session noVNC webroot (assets symlinked, auto-connecting index)
  for f in /usr/share/novnc/*; do
    ln -sfn "$f" "${WEB}/$(basename "$f")"
  done
  rm -f "${WEB}/index.html"
  cat > "${WEB}/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loading session…</title>
<script>
  // Page is served at /<n>/ ; websockify endpoint is /<n>/websockify
  var base = location.pathname.replace(/^\/+|\/+$/g, "");
  var wsPath = (base ? base + "/" : "") + "websockify";
  location.replace("vnc.html?autoconnect=1&reconnect=1&reconnect_delay=2000"
    + "&resize=scale&path=" + encodeURIComponent(wsPath));
</script>
HTML

  # ---- Firefox prefs (written once; edit on the volume to customise)
  if [ ! -f "${PROF}/ff/user.js" ]; then
    cat > "${PROF}/ff/user.js" <<PREFS
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "${START_URL}");
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("privacy.sanitize.sanitizeOnShutdown", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("dom.webnotifications.enabled", false);
user_pref("dom.ipc.processCount", 1);
PREFS
  fi

  # ---- credentials for this session
  uvar="USER_${i}"; pvar="PASS_${i}"
  U="${!uvar:-$USERNAME}"
  P="${!pvar:-$PASSWORD}"
  H="$(hash_for "$P")"
  echo "  /${i}  ${LABEL}  ->  user: ${U}"
  grep -qxF "    ${U} ${H}" /tmp/portal-auth.txt || echo "    ${U} ${H}" >> /tmp/portal-auth.txt

  # ---- portal card
  cat >> /tmp/cards.html <<CARD
      <a class="card" href="/${i}/">
        <span class="num">${i}</span>
        <span class="meta"><strong>${LABEL}</strong><small>profile-${i}</small></span>
        <span class="go">Open &rarr;</span>
      </a>
CARD

  # ---- supervisor programs
  cat >> "$SUPCONF" <<EOF

[program:xvfb-${i}]
command=/usr/bin/Xvfb :${D} -screen 0 ${SCREEN} -nolisten tcp
priority=10
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:openbox-${i}]
command=bash -c 'until xdpyinfo -display :${D} >/dev/null 2>&1; do sleep 1; done; exec openbox'
environment=DISPLAY=":${D}"
priority=20
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:firefox-${i}]
command=/usr/local/bin/run-firefox.sh ${D} ${PROF} "${START_URL}"
environment=KIOSK="${KIOSK}"
priority=30
autorestart=true
startsecs=15
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:x11vnc-${i}]
command=bash -c 'until xdpyinfo -display :${D} >/dev/null 2>&1; do sleep 1; done; exec x11vnc -display :${D} -rfbport ${VNC} -localhost -forever -shared -nopw -noxdamage -xkb -repeat -quiet'
priority=40
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:websockify-${i}]
command=/usr/bin/websockify --web=${WEB} ${WS} 127.0.0.1:${VNC}
priority=50
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
EOF

  # ---- Caddy route
  cat >> "$CADDYFILE" <<EOF
  redir /${i} /${i}/
  handle_path /${i}/* {
    basic_auth {
      ${U} ${H}
    }
    reverse_proxy 127.0.0.1:${WS}
  }
EOF
done

# ------------------------------------------------------------- portal page ---
cat > "${PORTAL}/index.html" <<'HEAD'
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>__BRAND__</title>
<style>
  :root{
    --bg:#f5f6f7; --fg:#111b21; --muted:#667781; --card:#ffffff;
    --line:#e3e6e8; --accent:#128c7e;
    box-sizing:border-box;
    padding-top:env(safe-area-inset-top,0px);
    padding-bottom:env(safe-area-inset-bottom,0px);
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --bg:#0b141a; --fg:#e9edef; --muted:#8696a0; --card:#202c33;
      --line:#2a3942; --accent:#25d366;
    }
  }
  *{box-sizing:inherit}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px;
  }
  .wrap{width:100%; max-width:460px}
  h1{font-size:22px; margin:0 0 4px}
  p.sub{margin:0 0 20px; color:var(--muted); font-size:14px}
  .card{
    display:flex; align-items:center; gap:14px; text-decoration:none; color:inherit;
    background:var(--card); border:1px solid var(--line); border-radius:12px;
    padding:14px 16px; margin-bottom:10px; transition:border-color .15s, transform .15s;
  }
  .card:hover{border-color:var(--accent); transform:translateY(-1px)}
  .num{
    flex:0 0 38px; height:38px; border-radius:50%; background:var(--accent); color:#fff;
    display:flex; align-items:center; justify-content:center; font-weight:600;
  }
  .meta{display:flex; flex-direction:column; flex:1; min-width:0}
  .meta strong{font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .meta small{color:var(--muted); font-size:12px}
  .go{color:var(--accent); font-size:14px; font-weight:600; white-space:nowrap}
  footer{margin-top:18px; color:var(--muted); font-size:12px}
</style>
<div class="wrap">
  <h1>__BRAND__</h1>
  <p class="sub">Each session is a separate WhatsApp account on its own browser profile.</p>
HEAD

cat /tmp/cards.html >> "${PORTAL}/index.html"

cat >> "${PORTAL}/index.html" <<'FOOT'
  <footer>Scan the QR code once from the matching phone. The login is stored on the
  server volume and survives restarts and redeploys.</footer>
</div>
FOOT

sed -i "s/__BRAND__/${BRAND//\//\\/}/g" "${PORTAL}/index.html"

# portal is behind auth too (any valid session user can open it)
{
  echo "  handle / {"
  echo "    basic_auth {"
  cat /tmp/portal-auth.txt
  echo "    }"
  echo "    root * ${PORTAL}"
  echo "    file_server"
  echo "  }"
  echo "}"
} >> "$CADDYFILE"

echo ""
echo "  password: ${PASSWORD}"
echo "  (set the PASSWORD variable in Railway to choose your own)"
echo "================================================"
echo ""

exec /usr/bin/supervisord -c "$SUPCONF"
