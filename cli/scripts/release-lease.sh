#!/usr/bin/env bash

# The origin ref is a distributed CAS mutex: never age-reclaim a provably-live holder, and re-verify ownership before irreversible work.
set -euo pipefail

LEASE_REF="${RELEASE_LEASE_REF:-refs/release-lock/held}"
DEFAULT_TTL_MIN="${RELEASE_LEASE_TTL:-30}"

DIE_STATUS=2
_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

local_host() {
  if [[ "$(uname)" == "Darwin" ]]; then
    scutil --get LocalHostName 2>/dev/null || hostname -s
  else
    hostname -s 2>/dev/null || hostname
  fi
}

holder_pid() { printf '%s' "${RELEASE_LEASE_HOLDER_PID:-}"; }

holder_desc() {
  printf '%s%s%s' "$(local_host)" \
    "${RELEASE_LEASE_HOLDER_PID:+/pid-$RELEASE_LEASE_HOLDER_PID}" \
    "${AGENTS_SESSION_ID:+/session-$AGENTS_SESSION_ID}"
}

token_path()   { printf '%s/release-lease.token' "$(git rev-parse --git-common-dir)"; }
# Renew may push before token write; full SHA history recognizes this run during that window.
history_path() { printf '%s/release-lease.history' "$(git rev-parse --git-common-dir)"; }
read_token()   { cat "$(token_path)" 2>/dev/null || true; }
write_token()  { printf '%s\n' "$1" >> "$(history_path)"; printf '%s\n' "$1" > "$(token_path)"; }
clear_token()  { rm -f "$(token_path)" "$(history_path)"; }
reset_token()  { clear_token; }
owned_token() {
  [[ -n "${1:-}" ]] || return 1
  grep -qxF "$1" "$(history_path)" 2>/dev/null
}

remote_lease_sha() {
  git ls-remote origin "$LEASE_REF" 2>/dev/null | awk '{print $1; exit}'
}

fetch_lease() {
  git fetch --quiet --force origin "$LEASE_REF:refs/lease-cache/held" 2>/dev/null || return 1
}

lease_field() {
  git log -1 --format=%B "$1" 2>/dev/null | awk -F': ' -v k="$2" '$1==k {print $2; exit}'
}

lease_age_min() {
  local when now
  when="$(git log -1 --format=%ct "$1" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [[ "$when" -gt 0 ]] || { echo 999999; return; }
  echo $(( (now - when) / 60 ))
}

pid_alive() {
  ps -p "$1" -o pid= >/dev/null 2>&1 || return 1
  local state
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d '[:space:]')"
  [[ "$state" != Z* ]]
}

pid_start_stamp() {
  ps -p "$1" -o lstart= 2>/dev/null | tr -s '[:space:]' '_' | sed 's/^_//; s/_$//'
}

holder_liveness() {
  local host pid started running
  host="$(lease_field "$1" host)"
  pid="$(lease_field "$1" pid)"
  [[ -n "$host" && "$pid" =~ ^[0-9]+$ ]] || { printf 'unknown'; return; }
  [[ "$host" == "$(local_host)" ]] || { printf 'unknown'; return; }
  pid_alive "$pid" || { printf 'dead'; return; }
  started="$(lease_field "$1" started)"
  running="$(pid_start_stamp "$pid")"
  if [[ -n "$started" && -n "$running" && "$started" != "$running" ]]; then
    printf 'dead'
    return
  fi
  printf 'alive'
}

reclaim_reason() {
  case "$(holder_liveness "$1")" in
    alive) printf '' ;;
    dead)  printf 'dead' ;;
    *)     [[ "$(lease_age_min "$1")" -ge "$2" ]] && printf 'stale' || printf '' ;;
  esac
}

describe_lease() {
  local v h a l
  v="$(lease_field "$1" version)"; h="$(lease_field "$1" holder)"; a="$(lease_age_min "$1")"
  case "$(holder_liveness "$1")" in
    alive) l=yes ;;
    dead)  l=no ;;
    *)     l=unknown ;;
  esac
  printf 'version=%s holder=%s age=%smin holder-alive=%s' "${v:-?}" "${h:-?}" "$a" "$l"
}

make_lease_commit() {
  local tree msg pid claim_id
  tree="$(git hash-object -t tree /dev/null)"
# Random claim-id prevents byte-identical same-second commits from hiding a lost CAS.
  claim_id="$(local_host)-$$-$RANDOM"
  msg="release lease

version: $1
claim-id: $claim_id
holder: $(holder_desc)
host: $(local_host)"
  pid="$(holder_pid)"
  if [[ -n "$pid" ]]; then
    msg="$msg
pid: $pid"
    local started
    started="$(pid_start_stamp "$pid")"
    if [[ -n "$started" ]]; then
      msg="$msg
started: $started"
    fi
  fi
  msg="$msg
claimed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git commit-tree "$tree" -m "$msg"
}

cmd_claim() {
  local version="${1:-}" ttl="$DEFAULT_TTL_MIN"
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ttl-min) ttl="${2:?--ttl-min needs a value}"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done
  [[ -n "$version" ]] || die "claim needs a version"

  local sha
  sha="$(make_lease_commit "$version")"
  reset_token

  if git push --quiet --force-with-lease="$LEASE_REF:" origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    green "release lease acquired for $version ($(holder_desc))"
    return 0
  fi

  local held age
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    if git push --quiet --force-with-lease="$LEASE_REF:" origin "$sha:$LEASE_REF" 2>/dev/null; then
      write_token "$sha"
      green "release lease acquired for $version ($(holder_desc))"
      return 0
    fi
    red "release lease is contended; another releaser claimed it first"
    return 1
  fi

  fetch_lease || true
  age="$(lease_age_min "$held")"
  local reason
  reason="$(reclaim_reason "$held" "$ttl")"
  if [[ -z "$reason" ]]; then
    red "release already in flight -- not starting a competing one"
    gray "  lease: $(describe_lease "$held")"
    if [[ "$(holder_liveness "$held")" == "alive" ]]; then
      gray "  its holder process is still running on this box; stop that release before claiming"
    else
      gray "  it expires (becomes reclaimable) after ${ttl}min; watch that release instead of racing it"
    fi
    return 1
  fi

  if [[ "$reason" == "dead" ]]; then
    yellow "reclaiming a release lease whose holder is gone (${age}min old, no live process)"
  else
    yellow "reclaiming a stale release lease (${age}min old, TTL ${ttl}min)"
  fi
  yellow "  previous holder: $(describe_lease "$held")"
  if ! git push --quiet --force-with-lease="$LEASE_REF:$held" origin "$sha:$LEASE_REF" 2>/dev/null; then
    red "another releaser reclaimed the stale lease first"
    return 1
  fi
  write_token "$sha"
  green "release lease reclaimed for $version ($(holder_desc))"
  return 0
}

cmd_renew() {
  local mine held sha
  mine="$(read_token)"
  [[ -n "$mine" ]] || { red "no release lease claimed from this checkout"; return 1; }

  held="$(remote_lease_sha)"
  if ! owned_token "$held"; then
    red "release lease is no longer ours -- another releaser holds it"
    [[ -n "$held" ]] && { fetch_lease || true; gray "  now held by: $(describe_lease "$held")"; }
    return 1
  fi

  fetch_lease || true
  sha="$(make_lease_commit "$(lease_field "$held" version)")"
  if git push --quiet --force-with-lease="$LEASE_REF:$held" origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    gray "release lease renewed"
    return 0
  fi
  red "could not renew the release lease (it was reclaimed mid-renew)"
  return 1
}

cmd_verify() {
  local mine held
  mine="$(read_token)"
  [[ -n "$mine" ]] || { red "release lease: no token in this checkout"; return 1; }
  held="$(remote_lease_sha)" || { red "release lease: could not read origin"; return 1; }
  [[ -n "$held" ]] || { red "release lease: the lease is gone from origin"; return 1; }
  if ! owned_token "$held"; then
    fetch_lease || true
    red "release lease: no longer ours -- held by $(describe_lease "$held")"
    return 1
  fi
  gray "release lease still ours"
  return 0
}

cmd_release() {
  local mine held
  mine="$(read_token)"
  if [[ -z "$mine" ]]; then
    gray "no release lease to drop"
    return 0
  fi

  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    clear_token
    gray "release lease already gone"
    return 0
  fi
  if ! owned_token "$held"; then
    fetch_lease || true
    yellow "release lease is no longer ours -- leaving it alone"
    gray "  now held by: $(describe_lease "$held")"
    clear_token
    return 0
  fi

  git push --quiet --force-with-lease="$LEASE_REF:$held" origin ":$LEASE_REF" 2>/dev/null \
    || { yellow "could not drop the release lease (already gone or reclaimed)"; clear_token; return 0; }
  clear_token
  gray "release lease dropped"
}

cmd_clear() {
  local ttl="$DEFAULT_TTL_MIN"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ttl-min) ttl="${2:?--ttl-min needs a value}"; shift 2 ;;
      *) die "unknown flag: $1" ;;
    esac
  done

  local held reason
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    gray "no release lease to clear"
    return 0
  fi
  fetch_lease || true
  reason="$(reclaim_reason "$held" "$ttl")"
  if [[ -z "$reason" ]]; then
    red "refusing to clear a lease that may still be held"
    gray "  lease: $(describe_lease "$held")"
    if [[ "$(holder_liveness "$held")" == "alive" ]]; then
      gray "  its holder process is still running on this box; stop that release first"
    else
      gray "  it becomes clearable after ${ttl}min without a renewal"
    fi
    return 1
  fi

  if ! git push --quiet --force-with-lease="$LEASE_REF:$held" origin ":$LEASE_REF" 2>/dev/null; then
    red "could not clear the release lease -- it changed under us; re-read status and retry"
    return 1
  fi
  green "cleared a release lease with no live holder ($reason)"
  gray "  was: $(describe_lease "$held")"
  if owned_token "$held"; then clear_token; fi
  return 0
}

cmd_status() {
  local held
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    echo "unheld"
    return 0
  fi
  fetch_lease || true
  echo "held $(describe_lease "$held")"
  if [[ "$(holder_liveness "$held")" == "dead" ]]; then
    gray "  the holder process is gone -- drop it with: $(basename "$0") clear"
  fi
}

case "${1:-}" in
  claim)   shift; cmd_claim "$@" ;;
  renew)   shift; cmd_renew "$@" ;;
  verify)  shift; cmd_verify "$@" ;;
  release) shift; cmd_release "$@" ;;
  clear)   shift; cmd_clear "$@" ;;
  status)  shift; cmd_status "$@" ;;
  -h|--help|"") sed -n '2,/^[^#]/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown subcommand: $1" ;;
esac
