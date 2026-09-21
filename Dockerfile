# Caddy is pulled in only for its static binary (reverse proxy + basic auth).
FROM caddy:2 AS caddybin

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dbus-x11 \
      firefox-esr \
      fonts-liberation \
      fonts-noto-color-emoji \
      novnc \
      openbox \
      procps \
      python3 \
      supervisor \
      websockify \
      x11-utils \
      x11vnc \
      xauth \
      xvfb \
 && rm -rf /var/lib/apt/lists/*

COPY --from=caddybin /usr/bin/caddy /usr/bin/caddy

COPY entrypoint.sh   /usr/local/bin/entrypoint.sh
COPY run-firefox.sh  /usr/local/bin/run-firefox.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/run-firefox.sh

ENV SESSIONS=3 \
    PORT=8080 \
    DATA_DIR=/data \
    SCREEN=1440x900x24 \
    KIOSK=1 \
    START_URL=https://web.whatsapp.com \
    BRAND="WhatsApp Hub"

EXPOSE 8080

CMD ["/usr/local/bin/entrypoint.sh"]
