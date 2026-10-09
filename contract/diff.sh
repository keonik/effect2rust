#!/usr/bin/env bash
# Run the same contract cases against several servers; the first is the reference.
# Each server is started, tested on a freshly reset database, then stopped.
#
#   contract/diff.sh --cases cases.json [--reset "SQL"] [--cwd DIR] [--port 3000] \
#     "effect=bun src/main.ts" "rust=./out/target/release/main_server"
#
# Needs DATABASE_URL (for --reset), bun, curl, psql.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CASES="" RESET="" CWD=$PWD PORT=3000 OUTDIR=${TMPDIR:-/tmp}/effect2rust-contract
servers=()
while [ $# -gt 0 ]; do
  case $1 in
    --cases) CASES=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --reset) RESET=$2; shift 2 ;;
    --cwd) CWD=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    *) servers+=("$1"); shift ;;
  esac
done
[ -z "$CASES" ] || [ ${#servers[@]} -lt 2 ] && { echo "usage: diff.sh --cases cases.json [--reset SQL] [--cwd DIR] [--port N] name=cmd name=cmd..." >&2; exit 2; }
mkdir -p "$OUTDIR"

# Make sure nothing from a previous run still holds the port (slow shutdowns, crashed harness runs).
free_port() {
  for _ in $(seq 50); do lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done
  lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs -r kill -9; sleep 0.5
}
stop() { kill -TERM -- -"$1" 2>/dev/null; wait "$1" 2>/dev/null; free_port; }
wait_up() { for _ in $(seq 500); do curl -s -o /dev/null "localhost:$PORT" && return 0; sleep 0.02; done; echo "  server didn't come up; see $OUTDIR/$1.log" >&2; return 1; }

names=()
for spec in "${servers[@]}"; do
  name=${spec%%=*}; cmd=${spec#*=}; names+=("$name")
  free_port
  setsid bash -c "cd '$CWD' && exec $cmd" > "$OUTDIR/$name.log" 2>&1 & pid=$!
  if wait_up "$name"; then
    [ -n "$RESET" ] && psql -q "$DATABASE_URL" -c "$RESET"
    bun "$HERE/contract.ts" record "http://localhost:$PORT" "$OUTDIR/$name.json" --cases "$CASES"
  fi
  stop $pid
done

status=0
for name in "${names[@]:1}"; do
  echo "== $name vs ${names[0]}"
  bun "$HERE/contract.ts" compare "$OUTDIR/${names[0]}.json" "$OUTDIR/$name.json" || status=1
done
exit $status
