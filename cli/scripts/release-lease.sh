#!/usr/bin/env bash
#
# release-lease.sh -- mutual exclusion for release.sh, held on `origin`.
#
# Why a git ref and not flock: agents release from whichever box they happen to
# be on (zion, mac-mini, yosemite-*, a Hetzner crabbox). A filesystem lock is
# invisible across machines, so two agents on two boxes both enter release.sh
# and race the same release branch, tag, and publish. Every box already
# authenticates to origin, so origin is the one place they can agree on.
#
# The mutex is an expected-old-value `git push --force-with-lease`. The lease ref
# points at an ORPHAN commit (no parents), but custom refs are not protected by
# receive.denyNonFastForwards: a plain push can overwrite one. An empty expected
# value atomically creates an absent ref; a concrete expected sha atomically
# replaces the stale ref inspected by a reclaimer.
#
# Usage:
#   release-lease.sh claim <version> [--ttl-min N]   # 0 = acquired, 1 = held by someone else
#   release-lease.sh renew                            # refresh our lease's timestamp
#   release-lease.sh verify                           # 0 = we still hold it, 1 = we do NOT
#   release-lease.sh release                          # drop the lease we hold
#   release-lease.sh clear [--ttl-min N]              # drop a lease with no live holder
#   release-lease.sh status                           # print the current holder, if any
#
# Env:
#   RELEASE_LEASE_REF          override the ref (tests point this at a scratch ref)
#   RELEASE_LEASE_TTL          minutes before an unrenewed lease is reclaimable (30)
#   RELEASE_LEASE_HOLDER_PID   pid of the release process this lease belongs to
#
# A lease older than the TTL is reclaimable: a release that dies without running
# its trap (SIGKILL, a severed ssh, a rebooted box) must not wedge the pipeline
# forever. Reclaiming is itself a compare-and-swap (--force-with-lease pinned to
# the exact stale sha), so two agents reclaiming at once still yield one winner,
# and the stale holder is always logged rather than silently overwritten.
#
# The TTL alone is a slow answer to an externally killed run: for up to 30
# minutes `status` reads `held` while nothing is releasing, and the operator has
# no way to tell that apart from a healthy long release. So the lease also
# records WHICH process holds it -- `host`, `pid`, and that pid's start time --
# and `claim`/`clear`/`status` probe it:
#
#   alive    the recorded pid is running on THIS box, same start time
#   dead     we are on the holder's box and that process is gone
#   unknown  the holder is another box, or the lease predates these fields
#
# A `dead` holder is reclaimable immediately -- no TTL wait -- because nothing
# can still be releasing. `unknown` falls back to the TTL, so a holder we cannot
# probe is treated exactly as before. `alive` is NEVER taken, at any age: a live
# holder is the collision this script exists to prevent, so the answer there is
# to stop that process, not to steal its lease. The pid start time is what makes
# `dead` safe to act on -- after a reboot a recycled pid would otherwise read as
# alive, and a recycled pid belonging to something else would read as a live
# release forever.
#
# The TTL must NOT be read as "how long a release takes" -- it is "how long since
# the holder last proved it was alive". A real release routinely outlives any
# sane TTL: the CI matrix alone has run 57 minutes, and release 1.20.77 took 186
# minutes wall clock. So a live release RENEWS (release.sh runs a renewer in the
# background for the whole run), and every irreversible step -- merge, tag,
# publish -- calls `verify` first and refuses to proceed if the lease is no
# longer ours. Without both, a long-but-healthy release would have its lease
# reclaimed mid-flight and two releasers would run at once, which is the exact
# failure this script exists to prevent.

set -euo pipefail

LEASE_REF="${RELEASE_LEASE_REF:-refs/release-lock/held}"
DEFAULT_TTL_MIN="${RELEASE_LEASE_TTL:-30}"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 2; }

# This box's name, the way the fleet knows it. Recorded as the lease's `host` and
# compared against it, so the liveness probe only ever reads the process table of
# the machine that actually holds the lease.
local_host() {
  if [[ "$(uname)" == "Darwin" ]]; then
    scutil --get LocalHostName 2>/dev/null || hostname -s
  else
    hostname -s 2>/dev/null || hostname
  fi
}

# The process whose death means this release is dead; release.sh exports its pid so a lease
# survives short-lived `renew` shells. Unset means liveness stays `unknown`, never instantly
# reclaimable. The pid decides liveness only; ownership stays the lease token.
holder_pid() { printf '%s' "${RELEASE_LEASE_HOLDER_PID:-}"; }

# Describes the holder for a human reading a stuck lease. Diagnostic text only, never matched to
# decide anything.
holder_desc() {
  printf '%s%s%s' "$(local_host)" \
    "${RELEASE_LEASE_HOLDER_PID:+/pid-$RELEASE_LEASE_HOLDER_PID}" \
    "${AGENTS_SESSION_ID:+/session-$AGENTS_SESSION_ID}"
}

# Ownership token: the sha of the lease commit we pushed. Whoever can name the commit the remote
# ref points at owns it, so `release` is safe from a different process than `claim`.
token_path()   { printf '%s/release-lease.token' "$(git rev-parse --git-common-dir)"; }
# Every sha this run has pushed for the current lease. `renew` rotates the commit non-atomically
# with the token file, so a concurrent `release` could orphan our own lease. Checking membership
# in this history closes that window.
history_path() { printf '%s/release-lease.history' "$(git rev-parse --git-common-dir)"; }
read_token()   { cat "$(token_path)" 2>/dev/null || true; }
write_token()  { printf '%s\n' "$1" >> "$(history_path)"; printf '%s\n' "$1" > "$(token_path)"; }
clear_token()  { rm -f "$(token_path)" "$(history_path)"; }
# A fresh claim starts a fresh history -- shas from a previous, already-released
# lease must never make us think we own someone else's current one.
reset_token()  { clear_token; }
owned_token() { # $1 = a sha seen on origin
  [[ -n "${1:-}" ]] || return 1
  grep -qxF "$1" "$(history_path)" 2>/dev/null
}

# Read the remote lease, if any. Echoes the sha; empty when unheld.
remote_lease_sha() {
  git ls-remote origin "$LEASE_REF" 2>/dev/null | awk '{print $1; exit}'
}

# Fetch the lease commit so we can read its message + timestamp locally.
fetch_lease() {
  git fetch --quiet --force origin "$LEASE_REF:refs/lease-cache/held" 2>/dev/null || return 1
}

lease_field() { # $1 = sha, $2 = field name
  git log -1 --format=%B "$1" 2>/dev/null | awk -F': ' -v k="$2" '$1==k {print $2; exit}'
}

lease_age_min() { # $1 = sha
  local when now
  when="$(git log -1 --format=%ct "$1" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  [[ "$when" -gt 0 ]] || { echo 999999; return; }
  echo $(( (now - when) / 60 ))
}

# Holder liveness uses `ps -p` rather than `kill -0`, which fails with EPERM for a live process
# owned by another user. A zombie (SIGKILLed, unreaped) counts as dead; an unreadable state
# degrades to alive, keeping uncertainty on the never-steal side.
pid_alive() { # $1 = pid
  ps -p "$1" -o pid= >/dev/null 2>&1 || return 1
  local state
  state="$(ps -p "$1" -o stat= 2>/dev/null | tr -d '[:space:]')"
  [[ "$state" != Z* ]]
}

# The pid's start time, squeezed to a single space-free token so it survives the
# "key: value" commit-message parser (`lease_field` splits on ": ", which the
# colons inside a clock time never produce). Empty when ps cannot answer.
pid_start_stamp() { # $1 = pid
  ps -p "$1" -o lstart= 2>/dev/null | tr -s '[:space:]' '_' | sed 's/^_//; s/_$//'
}

# alive | dead | unknown — see the header block for what each one licenses.
holder_liveness() { # $1 = sha
  local host pid started running
  host="$(lease_field "$1" host)"
  pid="$(lease_field "$1" pid)"
  # A lease with no recorded process (an older release.sh, or a hand-run claim)
  # is unprobeable, not dead.
  [[ -n "$host" && "$pid" =~ ^[0-9]+$ ]] || { printf 'unknown'; return; }
  # Only the holder's own box can see the holder's process table.
  [[ "$host" == "$(local_host)" ]] || { printf 'unknown'; return; }
  pid_alive "$pid" || { printf 'dead'; return; }
  # The pid exists — but a reboot or ordinary pid recycling can hand that number
  # to an unrelated process, which would read as a live release forever.
  started="$(lease_field "$1" started)"
  running="$(pid_start_stamp "$pid")"
  if [[ -n "$started" && -n "$running" && "$started" != "$running" ]]; then
    printf 'dead'
    return
  fi
  printf 'alive'
}

# Why a held lease may be taken over: "dead" (its holder is provably gone),
# "stale" (unrenewed past the TTL), or "" (leave it alone). One predicate for
# both `claim` and `clear`, so neither can grow its own weaker rule.
reclaim_reason() { # $1 = sha, $2 = ttl-min
  case "$(holder_liveness "$1")" in
    alive) printf '' ;;
    dead)  printf 'dead' ;;
    *)     [[ "$(lease_age_min "$1")" -ge "$2" ]] && printf 'stale' || printf '' ;;
  esac
}

describe_lease() { # $1 = sha
  local v h a l
  v="$(lease_field "$1" version)"; h="$(lease_field "$1" holder)"; a="$(lease_age_min "$1")"
  case "$(holder_liveness "$1")" in
    alive) l=yes ;;
    dead)  l=no ;;
    *)     l=unknown ;;
  esac
  printf 'version=%s holder=%s age=%smin holder-alive=%s' "${v:-?}" "${h:-?}" "$a" "$l"
}

# Build the orphan lease commit. No parents is what makes every claim a
# non-fast-forward against any existing lease, which is the whole mechanism.
make_lease_commit() { # $1 = version
  local tree msg pid claim_id
  tree="$(git hash-object -t tree /dev/null)"
  # Make competing claims distinct even when the fleet shares one Git identity: byte-identical
  # commits make the loser's push report "up to date", so both callers believe they acquired.
  claim_id="$(local_host)-$$-$RANDOM"
  msg="release lease

version: $1
claim-id: $claim_id
holder: $(holder_desc)
host: $(local_host)"
  # `pid` and `started` make a dead holder detectable and are written only when the release
  # process was declared; a half-recorded holder degrades to `unknown`. `renew` rebuilds this
  # message, so both stay current.
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
  reset_token   # a new claim starts a new ownership history

  # First attempt: atomically create an absent ref. A plain push is NOT a lock:
  # Git permits non-fast-forward updates outside refs/heads by default.
  if git push --quiet --force-with-lease="$LEASE_REF:" origin "$sha:$LEASE_REF" 2>/dev/null; then
    write_token "$sha"
    green "release lease acquired for $version ($(holder_desc))"
    return 0
  fi

  # Held. Decide between "someone is actively releasing" and "a dead run left
  # this behind" -- never guess, read the lease.
  local held age
  held="$(remote_lease_sha)"
  if [[ -z "$held" ]]; then
    # The ref vanished between our push and this read (the holder finished).
    # One retry, then report contention rather than spinning.
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
  # Replace the inspected stale sha with ours in ONE compare-and-swap. Delete
  # then create leaves an unlocked window where an unrelated claimant can win.
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
    # Reclaimed or dropped while we were working. Fail loudly: the caller must
    # stop before its next irreversible step, not carry on believing it is alone.
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

# Fail closed: any error (no token, no ref, unreachable origin) means we do not demonstrably hold
# the lease. A verify that fails open is worse than none.
cmd_verify() {
  local mine held
  mine="$(read_token)"
  [[ -n "$mine" ]] || { red "release lease: no token in this checkout"; return 1; }
  held="$(remote_lease_sha)" || { red "release lease: could not read origin"; return 1; }
  [[ -n "$held" ]] || { red "release lease: the lease is gone from origin"; return 1; }
  # Any sha this run pushed counts as ours -- a renew that landed between the
  # token write and this check is still us, not a reclaim.
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
  # Match against every sha this run pushed, not just the latest token. A renew
  # that pushed but had not yet written its token would otherwise look like a
  # reclaim by someone else, and we would orphan our own lease until its TTL.
  if ! owned_token "$held"; then
    # Genuinely reclaimed (our run outlived the TTL). Dropping it now would hand
    # the pipeline to a third agent while the real holder is publishing.
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

# Drop a lease nobody holds without starting a release: an external kill leaves it on origin and
# `release` only drops a lease this checkout claimed. Same predicate as `claim`, so it can never
# take a lease from a live holder.
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

  # CAS against the exact sha we inspected: two operators clearing at once, or a
  # holder that came back and renewed between the read and the push, must not
  # lose to a blind delete.
  if ! git push --quiet --force-with-lease="$LEASE_REF:$held" origin ":$LEASE_REF" 2>/dev/null; then
    red "could not clear the release lease -- it changed under us; re-read status and retry"
    return 1
  fi
  green "cleared a release lease with no live holder ($reason)"
  gray "  was: $(describe_lease "$held")"
  # If it happened to be ours, forget the token too, so a later `release` in this
  # checkout does not think it still owns something.
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
  # Say what to DO about a holder that is provably gone. Without this the
  # operator reads `held` and waits out a TTL for a release that already died.
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
  # The whole header block, however long it grows -- a hardcoded line range
  # silently truncated the help mid-sentence every time the block was extended.
  -h|--help|"") sed -n '2,/^[^#]/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown subcommand: $1" ;;
esac
