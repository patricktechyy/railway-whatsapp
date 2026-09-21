#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
PORT="${PORT:-8080}"
mkdir -p "$DATA_DIR" /run/user/1000
# websockify TokenFile requires the token file to exist before it starts.
touch "$DATA_DIR/websockify_tokens"
chown -R browser:browser "$DATA_DIR" /run/user/1000 || true

# Keep the X server and browser processes under the dedicated browser user.
# websockify exposes noVNC + token-based VNC routing; nginx puts everything behind Railway's one public port.
python3 -m websockify \
  --web /opt/noVNC \
  --token-plugin TokenFile \
  --token-source "$DATA_DIR/websockify_tokens" \
  6080 &
WEBSOCKIFY_PID=$!

sleep 0.5
if ! kill -0 "$WEBSOCKIFY_PID" 2>/dev/null; then
  echo "websockify failed to start" >&2
  exit 1
fi

uvicorn app.main:app --host 127.0.0.1 --port 8000 &
APP_PID=$!

cat > /etc/nginx/conf.d/default.conf <<EOF
server {
    listen 0.0.0.0:${PORT};
    server_name _;
    client_max_body_size 20m;

    location /websockify {
        proxy_pass http://127.0.0.1:6080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location /novnc/ {
        alias /opt/noVNC/;
        try_files \$uri \$uri/ =404;
    }

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF

nginx -g 'daemon off;' &
NGINX_PID=$!

cleanup() {
  kill "$NGINX_PID" "$APP_PID" "$WEBSOCKIFY_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$NGINX_PID" "$APP_PID" "$WEBSOCKIFY_PID"
