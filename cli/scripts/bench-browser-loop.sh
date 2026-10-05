#!/usr/bin/env bash
# A/B benchmark for RUSH-2149, per-action Node CLI boot in the `agents browser` loop: bare node
# boot, CLI-only boot, status/screenshot/click round-trips and the screenshot+click loop, so
# before/after runs compare. Not a CI benchmark; run by hand on a warm daemon.

set -uo pipefail

N="${1:-5}"
TASK="${AGENTS_BROWSER_TASK:-}"
if [ -z "$TASK" ]; then
  echo "AGENTS_BROWSER_TASK must be set to an open browser task (agents browser start --profile <p>)" >&2
  exit 2
fi

AGENTS_BIN="$(command -v agents)"
if [ -z "$AGENTS_BIN" ]; then
  echo "agents not found on PATH" >&2
  exit 2
fi

# median of N wall-clock ms for a shell command
median_ms() {
  local label="$1"; shift
  local times=()
  for i in $(seq 1 "$N"); do
    local t0 t1
    t0=$(date +%s%N)
    "$@" >/dev/null 2>&1
    t1=$(date +%s%N)
    times+=( $(( (t1 - t0) / 1000000 )) )
  done
  local sorted
  sorted=($(printf '%s\n' "${times[@]}" | sort -n))
  local mid=$(( N / 2 ))
  local med="${sorted[$mid]}"
  printf '%-55s median=%4sms  all=[%s]\n' "$label" "$med" "$(IFS=,; echo "${times[*]}")"
  echo "$med"
}

echo "Host: $(hostname)   agents $($AGENTS_BIN --version 2>/dev/null)   n=$N   task=$TASK"
echo

echo "-- layer breakdown (median of $N, ms) --"
median_ms "bare node -e ''"                 node -e ""
median_ms "agents --version"                "$AGENTS_BIN" --version
median_ms "agents browser status"           "$AGENTS_BIN" browser status --task "$TASK"
median_ms "agents browser screenshot"       "$AGENTS_BIN" browser screenshot --task "$TASK"
median_ms "agents browser click --at 10,10" "$AGENTS_BIN" browser click --at 10,10 --task "$TASK"

echo
echo "-- screenshot + click loop (median of $N iterations) --"
loop_times=()
for i in $(seq 1 "$N"); do
  t0=$(date +%s%N)
  "$AGENTS_BIN" browser screenshot --task "$TASK" >/dev/null 2>&1
  "$AGENTS_BIN" browser click --at 10,10 --task "$TASK" >/dev/null 2>&1
  t1=$(date +%s%N)
  loop_times+=( $(( (t1 - t0) / 1000000 )) )
done
sorted=($(printf '%s\n' "${loop_times[@]}" | sort -n))
mid=$(( N / 2 ))
printf '%-55s median=%4sms  all=[%s]\n' "screenshot+click loop (2 CLI calls)" "${sorted[$mid]}" "$(IFS=,; echo "${loop_times[*]}")"
