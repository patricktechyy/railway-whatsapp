FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    HOME=/home/browser \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl wget git \
    firefox-esr \
    xvfb openbox x11vnc dbus-x11 \
    nginx python3 python3-pip python3-venv \
    procps psmisc util-linux \
    fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 -s /bin/bash browser \
    && mkdir -p /data /run/user/1000 \
    && chown -R browser:browser /data /run/user/1000

# Pinning isn't required for the architecture; noVNC is static client code.
RUN git clone --depth 1 https://github.com/novnc/noVNC.git /opt/noVNC
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    fastapi==0.141.1 \
    uvicorn[standard] \
    websockify

WORKDIR /app
COPY app /app/app
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS http://127.0.0.1:${PORT:-8080}/health || exit 1
CMD ["/app/start.sh"]
