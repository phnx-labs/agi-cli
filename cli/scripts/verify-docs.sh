#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ERRORS=0

log() { printf '%s\n' "$*"; }
fail() {
  printf '✗ %s\n' "$*" >&2
  ERRORS=$((ERRORS + 1))
}

for doc in README architecture concepts resources execution sessions fleet orchestration automation interfaces secrets observability distribution specifications; do
  if [[ -f "docs/$doc.md" ]]; then
    log "✓ docs/$doc.md exists"
  else
    fail "docs/$doc.md is missing"
  fi
done

if grep -qF "docs/README.md" AGENTS.md; then
  log "✓ AGENTS.md links to the architecture index"
else
  fail "AGENTS.md should link to docs/README.md"
fi

for heading in "Coverage inventory" "Sessions" "Secrets" "Agent execution" "Scheduling & execution singularity" "Routine execution & readiness" "Watchdog"; do
  if grep -qF "## $heading" docs/specifications.md; then
    log "✓ specifications.md retains $heading"
  else
    fail "specifications.md is missing required section: $heading"
  fi
done
for marker in 'SES-' 'SEC-' 'EXEC-' 'Given/When/Then' '[Intended]' '[Drift]'; do
  if grep -qF "$marker" docs/specifications.md; then
    log "✓ specifications.md retains $marker evidence"
  else
    fail "specifications.md is missing required evidence marker: $marker"
  fi
done

for doc in architecture concepts resources execution sessions fleet orchestration automation secrets; do
  if grep -qF '```mermaid' "docs/$doc.md"; then
    log "✓ docs/$doc.md contains a component figure"
  else
    fail "docs/$doc.md should contain a Mermaid component or data-flow figure"
  fi
done

for anchor in coverage-inventory sessions secrets agent-execution scheduling--execution-singularity routine-execution--readiness watchdog; do
  case "$anchor" in
    coverage-inventory) heading='Coverage inventory' ;;
    sessions) heading='Sessions' ;;
    secrets) heading='Secrets' ;;
    agent-execution) heading='Agent execution' ;;
    scheduling--execution-singularity) heading='Scheduling & execution singularity' ;;
    routine-execution--readiness) heading='Routine execution & readiness' ;;
    watchdog) heading='Watchdog' ;;
  esac
  if ! grep -qF "## $heading" docs/specifications.md; then
    fail "broken specifications anchor referenced by repo entry points: #$anchor"
  fi
done

FORBIDDEN_HEADING_RE='^#{2,3} (Setup|Command [Rr]eference|Recipes|File [Mm]ap|Source [Mm]ap|Key Functions|Roadmap)$'
while IFS= read -r file; do
  [[ "$file" == "docs/command-index.md" ]] && continue
  grep -qF '<!-- guide -->' "$file" && continue
  if grep -Eq "$FORBIDDEN_HEADING_RE" "$file"; then
    fail "$file contains a user/reference heading reserved outside architecture docs"
  fi
done < <(find docs -name '*.md')

while IFS= read -r file; do
  while IFS= read -r match; do
    url="${match#*\(}"
    url="${url%\)}"
    url="${url%%#*}"
    [[ -z "$url" ]] && continue
    [[ "$url" == /* ]] && continue
    [[ "$url" == *://* ]] && continue
    [[ "$url" == mailto:* ]] && continue

    file_dir="$(cd "$(dirname "$file")" && pwd)"
    if (cd "$file_dir" && [[ -f "$url" || -d "$url" ]]); then
      continue
    fi
    resolved="$(cd "$file_dir" && pwd)/$url"
    fail "broken link in $file -> $url (resolved: $resolved)"
  done < <(grep -oE '\[[^]]+\]\([^)]+\)' "$file")
done < <(find docs -name '*.md')

if [[ $ERRORS -eq 0 ]]; then
  log "✓ Docs verification passed"
  exit 0
else
  log "✗ Docs verification failed with $ERRORS error(s)"
  exit 1
fi
