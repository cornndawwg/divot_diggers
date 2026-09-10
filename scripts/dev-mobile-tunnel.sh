#!/usr/bin/env bash
# Serve the phone app through a Cloudflare tunnel, for a phone that is not on this network.
#
#   pnpm dev:mobile:tunnel
#
# Expo's own --tunnel rides on an ngrok account it shares with every one of its users, and
# fails outright when that is full (ERR_NGROK_108) with an error naming neither the cause nor
# a fix. This uses Cloudflare's quick tunnels instead: no account, no token, nothing to
# configure, and a fresh https address each run.
#
# Ctrl+C stops both the tunnel and Metro.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8081}"
CF="$HOME/.local/bin/cloudflared"
LOG="$(mktemp -t ddga-tunnel-XXXXXX.log)"

if [ ! -x "$CF" ]; then
  echo "cloudflared is not installed at $CF"
  echo "Install it with:"
  echo "  mkdir -p ~/.local/bin && curl -sL -o ~/.local/bin/cloudflared \\"
  echo "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \\"
  echo "    && chmod +x ~/.local/bin/cloudflared"
  exit 1
fi

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is already in use — stop whatever is on it, or run: PORT=8090 pnpm dev:mobile:tunnel"
  exit 1
fi

cleanup() {
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

echo "Opening a Cloudflare tunnel to port ${PORT}…"
"$CF" tunnel --url "http://localhost:${PORT}" --no-autoupdate > "$LOG" 2>&1 &
CF_PID=$!

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$CF_PID" 2>/dev/null || { echo "The tunnel exited. Last output:"; tail -5 "$LOG"; exit 1; }
  sleep 1
done

if [ -z "$URL" ]; then
  echo "No tunnel address after 40 seconds. Last output:"; tail -5 "$LOG"; exit 1
fi

echo "Tunnel:  $URL"
echo "Starting Metro. Scan the QR code with Expo Go."
echo

# Expo builds the manifest and bundle URLs from this, so the phone is told to fetch them
# through the tunnel rather than from an address only this network can reach.
EXPO_PACKAGER_PROXY_URL="$URL" \
  pnpm --filter @ddga/mobile exec expo start --port "$PORT" --host localhost
