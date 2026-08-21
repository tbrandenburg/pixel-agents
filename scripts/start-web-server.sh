#!/usr/bin/env bash
#
# start-web-server.sh -- Start the Pixel Agents standalone server (Fastify
# webserver + WebSocket + webview SPA) so it can be driven purely over
# curl/REST, without VS Code.
#
# Agents are NOT predefined anywhere: Pixel Agents has no roster/config of
# "available agents". Every agent is created dynamically, the moment a hook
# event for a session_id it hasn't seen before arrives (see
# server/manual-hook-events.http and scripts/web-agent.sh for the REST
# lifecycle: SessionStart -> PreToolUse/Stop/... -> SessionEnd). Point real
# Claude Code hooks at this server, or POST synthetic events yourself, and
# the corresponding character just appears.
#
# Usage:
#   ./scripts/start-web-server.sh [--port 3100] [--layout path/to/layout.json]
#
# --layout copies the given OfficeLayout JSON to ~/.pixel-agents/layout.json
# before starting the server, since that's the only file the server reads
# the office layout from on startup (no --layout CLI flag exists upstream).
# Without --layout, the server keeps using whatever layout is already there
# (or falls back to its bundled default-layout.json on first run).
#
# Requires a build first: npm install && npm run build (produces dist/cli.js).

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
cli_js="${repo_root}/dist/cli.js"
pixel_home="${HOME}/.pixel-agents"

port=""
layout_file=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port|-p)
      port="${2:?--port requires a value}"
      shift 2
      ;;
    --layout|-l)
      layout_file="${2:?--layout requires a path}"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--port <number>] [--layout <path/to/layout.json>]"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$cli_js" ]; then
  echo "error: $cli_js not found -- run 'npm install && npm run build' first." >&2
  exit 1
fi

if [ -n "$layout_file" ]; then
  if [ ! -f "$layout_file" ]; then
    echo "error: layout file '$layout_file' not found." >&2
    exit 1
  fi
  mkdir -p "$pixel_home"
  cp "$layout_file" "${pixel_home}/layout.json"
  echo "Installed layout from '$layout_file' -> ${pixel_home}/layout.json"
fi

cli_args=()
if [ -n "$port" ]; then
  cli_args+=(--port "$port")
fi

echo "Starting Pixel Agents standalone server..."
node "$cli_js" "${cli_args[@]}" &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for ~/.pixel-agents/server.json to appear, then print connection info.
server_json="${pixel_home}/server.json"
for _ in $(seq 1 50); do
  if [ -f "$server_json" ]; then
    break
  fi
  sleep 0.1
done

if [ -f "$server_json" ]; then
  echo "Server ready. Connection details (${server_json}):"
  cat "$server_json"
  echo
  echo "Health check:   curl \$(node -e \"console.log('http://127.0.0.1:'+require('${server_json}').port+'/api/health')\")"
  echo "Send hook event: ./scripts/web-agent.sh '{\"session_id\":\"demo-1\",\"hook_event_name\":\"sessionStart\",\"cwd\":\"'\"\$PWD\"'\"}'"
else
  echo "warning: ${server_json} did not appear within 5s -- check server output above." >&2
fi

wait "$server_pid"
