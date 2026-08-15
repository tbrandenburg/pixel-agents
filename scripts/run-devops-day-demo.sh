#!/usr/bin/env bash
#
# run-devops-day-demo.sh -- starts a standalone Pixel Agents server and then
# plays the 10-minute "day in the life of a DevOps team" simulation against
# it (scripts/simulate-devops-day.mjs), so you can watch it unfold live in
# a browser.
#
# Temporarily swaps in scripts/devops-demo-layout.json -- a wider, more
# spread-out 9-desk office -- so the demo's parallel status bubbles don't
# visually collide the way they do in the small default office. Your own
# saved layout (~/.pixel-agents/layout.json) is backed up first and
# restored automatically when the script exits, however it exits.
#
# Usage:
#   ./scripts/run-devops-day-demo.sh [--speed N] [--port N] [--no-pause] [--keep-layout]
#
#   --speed N       Forwarded to the simulation (default 1 = real 10 minutes).
#   --port N        Port for the standalone server (default 3100).
#   --no-pause      Skip the "press Enter when ready" prompt -- start the
#                   simulation immediately after the server is healthy.
#   --keep-layout   Don't swap in the demo layout -- use whatever layout the
#                   server already has (you'll likely see overlapping status
#                   bubbles with more than a handful of concurrent agents).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=3100
NO_PAUSE=0
KEEP_LAYOUT=0
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
    --keep-layout)
      KEEP_LAYOUT=1
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

# ── Layout swap (reversible) ─────────────────────────────────────────────
LAYOUT_DIR="${HOME}/.pixel-agents"
LAYOUT_PATH="${LAYOUT_DIR}/layout.json"
LAYOUT_BACKUP="${LAYOUT_DIR}/layout.json.pre-devops-demo-backup"
LAYOUT_SWAPPED=0

restore_layout() {
  if [ "${LAYOUT_SWAPPED}" -eq 1 ]; then
    if [ -f "${LAYOUT_BACKUP}" ]; then
      echo "Restoring your previous layout..."
      mv -f "${LAYOUT_BACKUP}" "${LAYOUT_PATH}"
    else
      echo "Removing the demo layout (you had none before)..."
      rm -f "${LAYOUT_PATH}"
    fi
  fi
}

if [ "${KEEP_LAYOUT}" -eq 0 ]; then
  mkdir -p "${LAYOUT_DIR}"
  if [ -f "${LAYOUT_PATH}" ]; then
    cp "${LAYOUT_PATH}" "${LAYOUT_BACKUP}"
  fi
  cp "${ROOT_DIR}/scripts/devops-demo-layout.json" "${LAYOUT_PATH}"
  LAYOUT_SWAPPED=1
  echo "Swapped in the demo's 9-desk office layout (your own layout is backed up)."
fi

echo "Starting Pixel Agents standalone server on port ${PORT}..."
node dist/cli.js --port "${PORT}" &
SERVER_PID=$!

cleanup() {
  echo ""
  echo "Stopping Pixel Agents server (pid ${SERVER_PID})..."
  kill "${SERVER_PID}" 2>/dev/null || true
  restore_layout
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
echo "  3. Zoom in 2-3 times (top-left + button) for the clearest view of the"
echo "     new engineering floor -- status bubbles are easiest to read at"
echo "     higher zoom since desk spacing grows in screen pixels with it."
echo ""

if [ "${NO_PAUSE}" -eq 0 ]; then
  read -r -p "Press Enter once you're ready to start the 10-minute simulation... " _
fi

echo ""
echo "Starting the DevOps day simulation..."
node scripts/simulate-devops-day.mjs --port "${PORT}" "${SIM_ARGS[@]}"

echo ""
echo "Demo complete. Ctrl+C or close this shell to stop the server, or wait -- it stops automatically now."
