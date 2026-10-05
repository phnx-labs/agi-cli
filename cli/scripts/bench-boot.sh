#!/usr/bin/env bash

set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT="claude"
RUNS=6
BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bench-boot: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

cd "$CLI_DIR"

if [ "$BUILD" = "1" ]; then
  echo "[bench-boot] building dist/ …" >&2
  bun run build >/dev/null
fi

ENTRY="$CLI_DIR/dist/index.js"
if [ ! -f "$ENTRY" ]; then
  echo "[bench-boot] $ENTRY not found — run without --no-build, or 'bun run build' first." >&2
  exit 1
fi

run_once() {
  AGENTS_PROFILE_BOOT=1 node "$ENTRY" run "$AGENT" --headless --quiet -- --version 2>&1 >/dev/null || true
}

total_of() { grep -oE 'total [0-9.]+ms' | grep -oE '[0-9.]+' | head -1; }
stage_of() { grep -E "^  $1 " | grep -oE '\+ *[0-9.]+ms' | grep -oE '[0-9.]+' | head -1; }

echo "[bench-boot] agent=$AGENT runs=$RUNS entry=$ENTRY" >&2
echo >&2

declare -a TOTALS RESOLVES
LAST_TIMELINE=""
for i in $(seq 1 "$RUNS"); do
  out="$(run_once)"
  LAST_TIMELINE="$out"
  t="$(printf '%s\n' "$out" | total_of || true)"
  r="$(printf '%s\n' "$out" | stage_of 'resolve-version:done' || true)"
  TOTALS[$i]="${t:-NA}"
  RESOLVES[$i]="${r:-NA}"
  label="warm"; [ "$i" = "1" ] && label="cold"
  printf '  run %-2s (%-4s)  total=%-8s  resolve-version=%s ms\n' "$i" "$label" "${t:-NA}ms" "${r:-NA}"
done

echo
echo "── last full pre-exec timeline ──"
printf '%s\n' "$LAST_TIMELINE" | grep -E 'boot-profile|\+ *[0-9.]+ms' || true

if [ "$RUNS" -ge 2 ]; then
  warm_resolves="$(printf '%s\n' "${RESOLVES[@]:1}" | grep -vx NA | sort -n || true)"
  warm_totals="$(printf '%s\n' "${TOTALS[@]:1}" | grep -vx NA | sort -n || true)"
  median() { awk '{a[NR]=$1} END{ if(NR==0){print "NA"} else {print a[int((NR+1)/2)]} }'; }
  echo
  echo "── summary ──"
  echo "  cold resolve-version : ${RESOLVES[1]} ms   (populates the file-store metadata cache)"
  echo "  warm resolve-version : $(printf '%s\n' "$warm_resolves" | median) ms (median)"
  echo "  warm total pre-exec  : $(printf '%s\n' "$warm_totals" | median) ms (median)"
fi
