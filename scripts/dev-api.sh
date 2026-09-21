#!/usr/bin/env bash
# Start, stop or restart the API in the background for local smoke testing.
#
#   scripts/dev-api.sh start|stop|restart
#
# Environment variables (DATABASE_URL, SCIENCE_SERVICE_URL, ANTHROPIC_API_KEY …)
# are inherited, so:
#
#   SCIENCE_SERVICE_URL=http://localhost:8000 scripts/dev-api.sh restart
#
# tsx is launched through `node --import` rather than the `npx tsx` wrapper so
# that $! is the process that actually holds the port and `stop` can kill it.
set -uo pipefail
cd "$(dirname "$0")/.."
PORT="${PORT:-4000}"
LOG="${API_LOG:-/tmp/hydrology-api.log}"
PIDFILE=".api.pid"

stop() {
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Anything else still holding the port (an earlier run, a stale shell).
  for pid in $(ps -eo pid,args | awk '/[n]ode .*apps\/api\/src\/server\.ts/ {print $1}'); do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  echo "port $PORT free"
}

start() {
  JWT_SECRET="${JWT_SECRET:-dev}" \
    nohup node --import ./node_modules/tsx/dist/loader.mjs apps/api/src/server.ts > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 45); do
    if curl -fs -m 2 "http://localhost:$PORT/api/health" > /dev/null; then
      echo "API ready on port $PORT (pid $(cat "$PIDFILE"), log $LOG)"
      return 0
    fi
    sleep 1
  done
  echo "API did not become ready; see $LOG" >&2
  tail -20 "$LOG" >&2
  return 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  *) echo "usage: $0 start|stop|restart" >&2; exit 2 ;;
esac
