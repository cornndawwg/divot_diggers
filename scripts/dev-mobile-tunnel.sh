#!/usr/bin/env bash
# Serve the phone app at https://dev.cupweek.golf, for a phone that is not on this network.
#
#   pnpm dev:mobile:tunnel
#
# A named Cloudflare tunnel on a domain we own, rather than shared free infrastructure.
# Expo's own --tunnel rides on an ngrok account it shares with every one of its users and
# fails when that is full; Cloudflare's quick tunnels hand out a random name that, on a bad
# day, never gets DNS at all. Both report success and then do not work. This one has a fixed
# address, our DNS, and nobody else's capacity in the way.
#
# Ctrl+C stops both the tunnel and Metro.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8081}"
HOSTNAME_="${DEV_TUNNEL_HOSTNAME:-dev.cupweek.golf}"
TUNNEL="${DEV_TUNNEL_NAME:-ddga-dev}"
CF="$HOME/.local/bin/cloudflared"
LOG="$(mktemp -t ddga-tunnel-XXXXXX.log)"

if [ ! -x "$CF" ]; then
  echo "cloudflared is not installed at $CF. Install it with:"
  echo "  mkdir -p ~/.local/bin && curl -sL -o ~/.local/bin/cloudflared \\"
  echo "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \\"
  echo "    && chmod +x ~/.local/bin/cloudflared"
  exit 1
fi
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  echo "Not logged in to Cloudflare. Run:  cloudflared tunnel login"
  exit 1
fi
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is in use. Stop what is on it, or run: PORT=8090 pnpm dev:mobile:tunnel"
  exit 1
fi

cleanup() {
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT INT TERM

echo "Opening the tunnel to https://${HOSTNAME_} …"
"$CF" tunnel --no-autoupdate --url "http://localhost:${PORT}" run "$TUNNEL" > "$LOG" 2>&1 &
CF_PID=$!

for _ in $(seq 1 40); do
  grep -q "Registered tunnel connection" "$LOG" 2>/dev/null && break
  kill -0 "$CF_PID" 2>/dev/null || { echo "The tunnel exited:"; tail -5 "$LOG"; exit 1; }
  sleep 1
done
if ! grep -q "Registered tunnel connection" "$LOG" 2>/dev/null; then
  echo "The tunnel did not connect in 40 seconds:"; tail -5 "$LOG"; exit 1
fi

echo "Tunnel up.  https://${HOSTNAME_}"
echo "Starting Metro. Scan the QR code with Expo Go."
echo

# Metro builds the manifest and bundle URLs from this, so the phone is told to fetch them
# through the tunnel rather than from an address only this network can reach.
EXPO_PACKAGER_PROXY_URL="https://${HOSTNAME_}" \
  pnpm --filter @ddga/mobile exec expo start --port "$PORT" --host localhost
