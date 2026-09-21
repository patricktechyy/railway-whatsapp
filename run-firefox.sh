#!/usr/bin/env bash
# Usage: run-firefox.sh <display-number> <profile-dir> <start-url>
set -eu

D="${1:?display number required}"
PROF="${2:?profile dir required}"
URL="${3:-https://web.whatsapp.com}"

export DISPLAY=":${D}"
export HOME="${PROF}"
export MOZ_ENABLE_WAYLAND=0

# Supervisor has no dependency ordering, so wait for Xvfb to come up.
for _ in $(seq 1 90); do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 1
done

FLAGS=()
if [ "${KIOSK:-1}" = "1" ]; then
  FLAGS+=(--kiosk)
fi

exec firefox-esr --profile "${PROF}/ff" --no-remote "${FLAGS[@]}" "$URL"
