#!/usr/bin/env bash
set -euo pipefail

AGENT="${AGENT:-claude}"
MODEL="${MODEL:-haiku}"
PROMPT="${PROMPT:-Reply with exactly: OK}"

echo "# headless offload smoke | host=$(hostname) agent=${AGENT} model=${MODEL}"
start=$(date +%s.%N)

out="$(agents run "${AGENT}" "${PROMPT}" --model "${MODEL}" --mode plan --quiet 2>/dev/null | tail -1)"

end=$(date +%s.%N)
elapsed=$(awk "BEGIN{printf \"%.2f\", ${end}-${start}}")

echo "reply : ${out}"
echo "wall  : ${elapsed}s"
[ -n "${out}" ] && echo "PASS — headless dispatch works on $(hostname)" || { echo "FAIL — empty reply"; exit 1; }
