#!/usr/bin/env bash
set -euo pipefail

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

select_run() {
  local sha="$1"
  jq -er --arg sha "$sha" \
    '([.workflow_runs[] | select(.head_sha == $sha)] | sort_by(.run_number) | last) // empty | {id, status, html_url}'
}

case "${1:-}" in
  select)
    [[ -n "${2:-}" ]] || die "select needs the exact release commit SHA"
    select_run "$2" || die "no branch-push Release run exists for commit $2"
    ;;
  rerun)
    REPO="${2:-}"; BRANCH="${3:-}"; SHA="${4:-}"
    [[ -n "$REPO" && -n "$BRANCH" && -n "$SHA" ]] \
      || die "usage: release-rerun.sh rerun <owner/repo> <release-branch> <exact-sha>"
    runs="$(gh api -X GET "repos/$REPO/actions/workflows/release.yml/runs" \
      -f branch="$BRANCH" -f event=push -f per_page=50)" \
      || die "could not list Release workflow runs over REST"
    selected="$(select_run "$SHA" <<<"$runs")" \
      || die "no branch-push Release run exists for commit $SHA"
    run_id="$(jq -r .id <<<"$selected")"
    status="$(jq -r .status <<<"$selected")"
    url="$(jq -r .html_url <<<"$selected")"
    if [[ "$status" == "requested" || "$status" == "pending" || "$status" == "queued" \
      || "$status" == "in_progress" || "$status" == "waiting" ]]; then
      printf 'Release run is already %s: %s\n' "$status" "$url"
      exit 0
    fi
    gh api -X POST "repos/$REPO/actions/runs/$run_id/rerun" >/dev/null \
      || die "could not rerun Release workflow run $run_id"
    printf 'Re-ran Release workflow for exact commit %s: %s\n' "$SHA" "$url"
    ;;
  *) die "usage: release-rerun.sh <select|rerun> ..." ;;
esac
