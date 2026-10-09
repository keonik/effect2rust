#!/usr/bin/env bash
# Load-test several servers under identical conditions (needs `oha`: cargo install oha).
# Each server runs in its own process group, so "a & b & wait" measures a multi-process setup.
#
#   contract/bench.sh --get /todos/500 [--post /todos --body '{"title":"x"}'] [--seed SQL] \
#     [--cwd DIR] [--port 3000] [--duration 15s] [--connections 50] \
#     "effect=bun src/main.ts" "rust=./out/target/release/main_server"
set -u
GET="" POST="" BODY="" SEED="" CWD=$PWD PORT=3000 DUR=15s CONN=50
servers=()
while [ $# -gt 0 ]; do
  case $1 in
    --get) GET=$2; shift 2 ;;
    --post) POST=$2; shift 2 ;;
    --body) BODY=$2; shift 2 ;;
    --seed) SEED=$2; shift 2 ;;
    --cwd) CWD=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --duration) DUR=$2; shift 2 ;;
    --connections) CONN=$2; shift 2 ;;
    *) servers+=("$1"); shift ;;
  esac
done
[ -z "$GET$POST" ] || [ ${#servers[@]} -eq 0 ] && { echo "usage: bench.sh --get PATH [--post PATH --body JSON] [--seed SQL] name=cmd..." >&2; exit 2; }
command -v oha >/dev/null || { echo "needs oha: cargo install oha" >&2; exit 2; }

URL="http://localhost:$PORT"
# Make sure nothing from a previous run still holds the port (slow shutdowns, crashed harness runs).
free_port() {
  for _ in $(seq 50); do lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill -9; sleep 0.5
}
stop() { kill -TERM -- -"$1" 2>/dev/null; wait "$1" 2>/dev/null; free_port; }
wait_up() { for _ in $(seq 1000); do curl -s -o /dev/null "$URL" && return 0; sleep 0.01; done; return 1; }
rss_sum() { ps -o rss= -g "$1" | awk '{s+=$1} END {print int(s/1024)}'; }
hwm_sum() { for p in $(ps -o pid= -g "$1"); do awk '/VmHWM/{print $2}' /proc/$p/status 2>/dev/null; done | awk '{s+=$1} END {print int(s/1024)}'; }
summ() { bun -e 'const r=JSON.parse(await Bun.stdin.text()); const s=r.summary, l=r.latencyPercentiles; console.log(`${Math.round(s.requestsPerSec).toLocaleString().padStart(7)} req/s  p99 ${(l.p99*1000).toFixed(1).padStart(5)}ms`)'; }

for spec in "${servers[@]}"; do
  name=${spec%%=*}; cmd=${spec#*=}
  [ -n "$SEED" ] && psql -q "$DATABASE_URL" -c "$SEED"
  t0=$(date +%s%N)
  free_port
  setsid bash -c "cd '$CWD' && $cmd" > /dev/null 2>&1 & pid=$!
  if ! wait_up; then echo "$(printf '%-24s' "$name") server didn't start: $cmd" >&2; kill -TERM -- -$pid 2>/dev/null; continue; fi
  startup=$(( ($(date +%s%N) - t0) / 1000000 ))
  sleep 0.5; idle=$(rss_sum $pid)
  oha -z 3s -c "$CONN" --no-tui "$URL${GET:-$POST}" > /dev/null   # warm-up / JIT tier-up
  line="$(printf '%-24s' "$name")"
  [ -n "$GET" ] && line+=" GET $(oha -z "$DUR" -c "$CONN" --no-tui --output-format json "$URL$GET" | summ) |"
  [ -n "$POST" ] && line+=" POST $(oha -z "$DUR" -c "$CONN" --no-tui --output-format json -m POST -H 'content-type: application/json' -d "$BODY" "$URL$POST" | summ) |"
  procs=$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | wc -l)
  echo "$line mem $(printf '%4s' "$idle")→$(printf '%4s' "$(hwm_sum $pid)") MB | start $(printf '%4s' $startup) ms | $procs proc"
  stop $pid
done
