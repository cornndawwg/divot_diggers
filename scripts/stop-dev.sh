#!/usr/bin/env bash
#
# Stops anything listening on the console and API ports.
#
#   pnpm dev:stop
#
set -uo pipefail
FOUND=0
for PORT in 3000 8787; do
  for PID in $(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | sort -u); do
    CMD=$(ps -o cmd= -p "$PID" 2>/dev/null | head -c 60)
    echo "  stopping pid ${PID} on ${PORT}: ${CMD}"
    kill "$PID" 2>/dev/null
    FOUND=1
  done
done
[[ $FOUND -eq 0 ]] && { echo "  nothing was running on 3000 or 8787"; exit 0; }

sleep 2
for PORT in 3000 8787; do
  for PID in $(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | sort -u); do
    kill -9 "$PID" 2>/dev/null
  done
done
sleep 1
if ss -ltnp 2>/dev/null | grep -qE ':(3000|8787) '; then
  echo "  something is still holding a port:"
  ss -ltnp 2>/dev/null | grep -E ':(3000|8787) '
  exit 1
fi
echo "  both ports are free"
