#!/usr/bin/env bash
#
# run-devops-day-demo.sh -- starts a standalone Pixel Agents server and then
# plays the 10-minute "day in the life of a DevOps team" simulation against
# it (scripts/simulate-devops-day.mjs), so you can watch it unfold live in
# a browser.
#
# Usage:
#   ./scripts/run-devops-day-demo.sh [--speed N] [--port N] [--no-pause]
#
#   --speed N    Forwarded to the simulation (default 1 = real 10 minutes).
#   --port N     Port for the standalone server (default 3100).
#   --no-pause   Skip the "press Enter when ready" prompt -- start the
#                simulation immediately after the server is healthy.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=3100
NO_PAUSE=0
SIM_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      PORT="$2"
      shift 2
      ;;
    --no-pause)
      NO_PAUSE=1
      shift
      ;;
    *)
      SIM_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ ! -f dist/cli.js ]; then
  echo "dist/cli.js not found -- building Pixel Agents first (npm run build)..."
  npm run build
fi

echo "Starting Pixel Agents standalone server on port ${PORT}..."
node dist/cli.js --port "${PORT}" &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Stopping Pixel Agents server (pid ${SERVER_PID})..."
  kill "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo -n "Waiting for the server to come up"
ready=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

if [ "${ready}" -ne 1 ]; then
  echo "error: server did not become healthy within 30s" >&2
  exit 1
fi

URL="http://127.0.0.1:${PORT}"
echo ""
echo "Pixel Agents is running at ${URL}"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "${URL}" >/dev/null 2>&1 &
fi

echo ""
echo "Before the simulation starts:"
echo "  1. Open ${URL} in your browser (if it didn't open automatically)."
echo "  2. Click Settings and enable 'Watch All Sessions' -- the simulated"
echo "     agents use fake project directories the server has never seen,"
echo "     so this setting is required for them to be adopted and rendered."
echo ""

if [ "${NO_PAUSE}" -eq 0 ]; then
  read -r -p "Press Enter once you're ready to start the 10-minute simulation... " _
fi

echo ""
echo "Starting the DevOps day simulation..."
node scripts/simulate-devops-day.mjs --port "${PORT}" "${SIM_ARGS[@]}"

echo ""
echo "Demo complete. Ctrl+C or close this shell to stop the server, or wait -- it stops automatically now."
