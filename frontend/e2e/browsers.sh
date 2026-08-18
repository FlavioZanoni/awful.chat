#!/bin/bash
# Restart the headless browsers the e2e driver talks to.
# One Firefox per peer, each with its own profile so identities stay separate.
set -u
cd "$(dirname "$0")"
DIR="${AWFUL_E2E_PROFILES:-/tmp/awful-e2e}"
mkdir -p "$DIR"
for spec in "9307:p1" "9308:p2" "9309:p3"; do
  port="${spec%%:*}"; prof="${spec##*:}"
  pid=$(ss -ltnp 2>/dev/null | grep ":$port " | grep -oP '(?<=pid=)\d+' | head -1)
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
done
sleep 3
for spec in "9307:p1" "9308:p2" "9309:p3"; do
  port="${spec%%:*}"; prof="${spec##*:}"
  mkdir -p "$DIR/$prof"
  setsid /usr/lib/firefox/firefox --headless --profile "$DIR/$prof" \
    --remote-debugging-port="$port" >"$DIR/$prof.log" 2>&1 </dev/null &
done
sleep 10
ss -ltn | grep -E "9307|9308|9309" || { echo "browsers did not start"; exit 1; }
