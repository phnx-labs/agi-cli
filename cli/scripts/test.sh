#!/usr/bin/env bash
#
# The canonical way to run the agents-cli suite. Every other script that needs
# tests calls THIS one -- build.sh and release-attestation-produce.sh included.
#
# WHY THIS EXISTS (RUSH-3178). The suite is ~13k tests and pins a machine for
# ~10 minutes. It must never land on an interactive box. Before this script the
# only offloaded path was the `test:remote` package.json alias, and offloading
# was opt-in AT EACH CALL SITE because scripts/sandbox.sh took a hand-composed
# command string rather than a verb. Every call site opted out: build.sh:95 and
# release-attestation-produce.sh:151 both ran `bun run test` on whatever box
# invoked them, and agents ran vitest directly for the same reason. Making the
# offload the DEFAULT, inside one entry point, is what makes that impossible
# rather than merely discouraged.
#
# The default is now `auto` (RUSH-3211), not crabbox. Crabbox needs its binary
# plus provider credentials, so a default that required them failed on any box
# without them -- and a default that fails is a default nobody uses. `auto` draws
# from the fleet workers the operator has already marked, through the CLI's own
# picker, so the no-argument invocation works everywhere.
#
# Usage:
#   scripts/test.sh                      # auto-pick the least-loaded worker (default)
#   scripts/test.sh --device auto        # the same thing, said explicitly
#   scripts/test.sh --device <box>       # run on a named fleet box over ssh
#   scripts/test.sh --shard 6            # fan out across 6 auto-picked workers (fastest)
#   scripts/test.sh --devices m1,m2,m3   # fan out across named workers
#   scripts/test.sh --crabbox            # offload to a disposable crabbox instead
#   scripts/test.sh --here               # run on THIS machine (explicit, loud)
#   scripts/test.sh --repo-root <dir>    # test that tree instead of this one
#   scripts/test.sh -- --retry=2         # everything after `--` goes to vitest
#
# NO SILENT FALLBACK. When no worker is eligible this script FAILS and names the
# exact `--device` command to re-run, rather than quietly running the suite
# locally. A fallback here would recreate the very bug it exists to stop: the
# operator believes work was offloaded while their laptop melts.
set -euo pipefail

cd "$(dirname "$0")/.."
CLI_DIR="$(pwd)"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()  { printf '\033[1m%s\033[0m\n'  "$*"; }
die()   { red "error: $*"; exit 1; }

# `auto` is the default (RUSH-3211): call sites that name no box get a real worker without knowing
# which are free. crabbox stays available as an explicit choice; defaulting to it failed on any
# box without the binary and provider creds.
MODE="auto"
# Which flag chose MODE; empty means still the default. The first target-selecting flag wins and a
# second, different one is a conflict, not a silent overwrite (`--shard 6 --device box` once
# dropped one by argument order).
MODE_FLAG=""
DEVICE=""
SHARDS=0
SHARD_LIST=""
REPO_ROOT=""
VITEST_ARGS=()

# Every flag that picks where the suite runs goes through this, so two can never quietly disagree:
# a different mode dies naming both flags. A shard count below 2 is never wanted: 0 ran nothing
# yet printed "All 0 shards passed." with exit 0, and 1 is `--device auto`.
shard_count_ok() {
  local n="$1" flag="${2:---shard}"
  [[ "$n" =~ ^[0-9]+$ ]] || die "--shard needs a worker count, e.g. --shard 6"
  (( n >= 2 )) || die "$flag needs at least 2 workers (got $n). For a single worker use: scripts/test.sh --device auto"
}

set_mode() {
  local want="$1" flag="$2"
  if [[ -n "$MODE_FLAG" && "$MODE" != "$want" ]]; then
    die "$flag conflicts with $MODE_FLAG -- each picks a different place to run the suite. Pass one."
  fi
  MODE="$want"; MODE_FLAG="$flag"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device) [[ -n "${2:-}" ]] || die "--device needs a machine name"; DEVICE="$2"; set_mode device --device; shift 2 ;;
    --device=*) DEVICE="${1#*=}"; set_mode device --device; shift ;;
    --crabbox) set_mode crabbox --crabbox; shift ;;
    # Fan out across N workers. This is the lever that hits the release-time
    # target: the suite is throughput-bound (3079s CPU / 11.5x on one box), so
    # dividing the CPU across machines is what shortens it.
    --shard) shard_count_ok "${2:-}"; SHARDS="$2"; set_mode shard --shard; shift 2 ;;
    # Name the workers explicitly instead of auto-picking: it lets an operator pin the fan-out to
    # known-idle boxes and removes the `devices pick --json` (>= 1.22.49) dependency.
    --devices) [[ -n "${2:-}" ]] || die "--devices needs a comma-separated list, e.g. --devices m1,m2,m3"; SHARD_LIST="$2"; set_mode shard --devices; shift 2 ;;
    --devices=*) SHARD_LIST="${1#*=}"; set_mode shard --devices; shift ;;
    --shard=*) SHARDS="${1#*=}"; shard_count_ok "$SHARDS"; set_mode shard --shard; shift ;;
    --here|--local) set_mode here --here; shift ;;
    --repo-root) [[ -n "${2:-}" ]] || die "--repo-root needs a directory"; REPO_ROOT="$2"; shift 2 ;;
    --repo-root=*) REPO_ROOT="${1#*=}"; shift ;;
    --) shift; VITEST_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unexpected argument: $1 (did you mean '-- $1' to pass it to vitest?)" ;;
  esac
done

# `--device auto` is the same sentinel `agents run --device auto` uses; accept it
# here rather than dialing a literal, nonexistent host named "auto".
if [[ "$MODE" == "device" && "$DEVICE" == "auto" ]]; then MODE="auto"; DEVICE=""; fi

# Resolve an explicit --devices list before any prerequisite check so a bad invocation fails on
# its own merits; validating later made `--devices onebox` without rsync report the missing rsync
# instead.
SHARD_DEVICES=()
if [[ "$MODE" == "shard" && -n "$SHARD_LIST" ]]; then
  _IFS_SAVE="$IFS"; IFS=','
  for _d in $SHARD_LIST; do [[ -n "$_d" ]] && SHARD_DEVICES+=("$_d"); done
  IFS="$_IFS_SAVE"
  (( ${#SHARD_DEVICES[@]} )) || die "--devices parsed to nothing: '$SHARD_LIST'"
  # An explicit list sets the count when --shard did not, through the same >= 2 floor; otherwise
  # `--devices onebox` slipped past it and ran a one-shard fan-out.
  (( SHARDS )) || { SHARDS=${#SHARD_DEVICES[@]}; shard_count_ok "$SHARDS" --devices; }
fi

# --repo-root lets the attestation producer test the isolated worktree it built
# at an exact commit, so the bytes tested are the bytes attested.
if [[ -n "$REPO_ROOT" ]]; then
  [[ -d "$REPO_ROOT/cli" ]] || die "--repo-root '$REPO_ROOT' has no cli"
  CLI_DIR="$(cd "$REPO_ROOT/cli" && pwd)"
fi
TREE_ROOT="$(cd "$CLI_DIR/.." && pwd)"

# Render vitest args for a command string a shell will re-parse, with per-arg `%q`, never "$*":
# splicing turned `--testNamePattern="a b"` into two words and ran 10,620 tests instead of a
# handful. Same bug as sandbox.sh.
vitest_suffix() {
  ((${#VITEST_ARGS[@]})) || return 0
  local a
  printf ' --'
  for a in "${VITEST_ARGS[@]}"; do printf ' %s' "$(printf '%q' "$a")"; done
}

# Resolve a device name to an address ssh/rsync can reach. Raw `ssh <name>` resolves to an
# unroutable LAN entry for the yosemite pool and hangs until ConnectTimeout, so read the
# registry's tailscale dnsName. Also refuses the interactive host by name.
device_addr() {
  command -v agents >/dev/null 2>&1 \
    || die "the 'agents' CLI is not on PATH, so device '$1' cannot be resolved"
  agents devices list --json --no-stats 2>/dev/null | python3 -c '
import json, sys
want = sys.argv[1]
for r in json.load(sys.stdin):
    if r.get("name") == want:
        if r.get("interactive"):
            sys.exit(2)
        a = r.get("address") or {}
        addr = a.get("dnsName") or a.get("ip")
        if not addr:
            sys.exit(3)
        user = r.get("user")
        print(f"{user}@{addr}" if user else addr)
        sys.exit(0)
sys.exit(1)
' "$1"
}

# Resolve MODE=auto to a concrete worker, then fall through to the device path. Eligibility is not
# reimplemented: `agents devices pick` is the CLI's own picker, with the same pool, probe and
# ranking as `agents run --device auto`. It fails loud when no worker is eligible.
if [[ "$MODE" == "auto" ]]; then
  command -v agents >/dev/null 2>&1 \
    || die "the 'agents' CLI is not on PATH, so a worker cannot be auto-picked.
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  # stdout is the name alone; the candidate/load detail goes to stderr, so let it
  # through to the operator instead of swallowing it.
  if ! DEVICE="$(agents devices pick)"; then
    # Distinguish "the fleet has nothing free" from "your CLI is too old to ask": both exit
    # non-zero, and conflating them sends the operator hunting a capacity problem. This is a
    # diagnostic, not a fallback; the run aborts either way.
    if ! agents devices --help 2>/dev/null | grep -qE '^[[:space:]]*pick([[:space:]]|$)'; then
      die "the installed 'agents' CLI has no 'devices pick' -- it predates the auto-picker.
  Upgrade it, or name a box until you do:  scripts/test.sh --device yosemite-m1"
    fi
    die "no worker device is available (see the message above).
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  fi
  [[ -n "$DEVICE" ]] || die "'agents devices pick' returned no device"
  # A worker that picked itself runs in place: shipping the tree over ssh to localhost is
  # overhead, and the --here warning is wrong for a box marked `worker`. On the interactive host
  # this is unreachable since `personal` keeps it out of the pool.
  if [[ "$(hostname -s 2>/dev/null || hostname)" == "$DEVICE" ]]; then
    gray "Auto-picked THIS machine ($DEVICE) -- it is a pool worker, so running in place."
    MODE="here-worker"
  else
    MODE="device"
  fi
fi

# Ship this tree to $1 and run the suite there; $2.. are extra vitest args (sharding appends
# `--shard=i/N`). Factored out so the shard fan-out reuses it N times and cannot drift from the
# single-device path.
ship_and_run() (
  local device="$1"; shift
  local addr remote_dir extra
  extra="$*"

  addr="$(device_addr "$device")" || case $? in
    2) die "'$device' is the INTERACTIVE host -- the suite is never scheduled there." ;;
    3) die "device '$device' has no reachable address in the registry" ;;
    *) die "device '$device' is not in the registry -- see 'agents devices list'" ;;
  esac
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$addr" true 2>/dev/null \
    || die "cannot reach '$device' ($addr) over ssh"

  remote_dir="$(ssh "$addr" 'mkdir -p "$HOME/.cache/agents-cli/test-runs" && mktemp -d "$HOME/.cache/agents-cli/test-runs/run.XXXXXXXX"')" \
    || die "could not allocate a test workspace on '$device'"
  [[ "$remote_dir" == /*/test-runs/run.* && "$remote_dir" != *$'\n'* ]] \
    || die "unexpected test workspace from '$device'"
  local remote_path
  printf -v remote_path '%q' "$remote_dir"
  trap 'ssh -o BatchMode=yes -o ConnectTimeout=15 "$addr" "rm -rf -- $remote_path && test ! -e $remote_path" || gray "Retained test workspace: $device:$remote_dir" >&2' EXIT
  gray "  workspace: $device:$remote_dir"
  rsync -az \
    --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
    --exclude '.agents/worktrees' --exclude '.release-attestations' \
    "$TREE_ROOT/" "$addr:$remote_path/"
  ssh "$addr" "bash $remote_path/cli/scripts/bound-repo-root.sh $remote_path" \
    || die "could not give the shipped tree a git repo on '$device'"
  ssh "$addr" "cd $remote_path/cli \
    && bun install --silent \
    && bun run build >/dev/null \
    && bun run test$(vitest_suffix)${extra:+ $extra}"
)

case "$MODE" in
  here|here-worker)
    # `here` is deliberately loud: running the full suite on the machine someone is using is a
    # real cost, so it never happens implicitly. `here-worker` is the auto-pick landing on a pool
    # worker, the intended outcome, so no warning.
    if [[ "$MODE" == "here" ]]; then
      red "WARNING: running the full suite on THIS machine ($(hostname -s))."
      red "         ~13k tests, several minutes of pinned CPU. Ctrl-C now to offload instead."
    fi
    cd "$CLI_DIR"
    # shellcheck disable=SC2046
    # Local exec: pass the array straight through. No command string is built,
    # so there is nothing for a second shell to re-split.
    if ((${#VITEST_ARGS[@]})); then
      exec bun run test -- "${VITEST_ARGS[@]}"
    fi
    exec bun run test
    ;;

  device)
    command -v rsync >/dev/null || die "rsync not found (needed to ship the tree to $DEVICE)"
    command -v ssh   >/dev/null || die "ssh not found"
    bold "Offloading the suite to $DEVICE"
    gray "  tree:   $TREE_ROOT"
    ship_and_run "$DEVICE"
    ;;


  shard)
    # Fan the suite across N workers with vitest's `--shard=i/N`. The suite is throughput-bound,
    # so wall == CPU/workers: 3 boxes ~93s, 6 ~47s, 9 ~31s against 269s on one. A file must still
    # not exceed the per-shard budget or it becomes the floor.
    command -v rsync >/dev/null || die "rsync not found"
    command -v ssh   >/dev/null || die "ssh not found"
    # SHARD_DEVICES is already populated when --devices was passed (resolved and
    # floor-checked right after argument parsing). Only the auto-pick path has
    # work left to do here.
    if (( ${#SHARD_DEVICES[@]} )); then :; else
    command -v agents >/dev/null 2>&1 || die "the 'agents' CLI is not on PATH, so workers cannot be picked"
    # `devices pick --json` supplies the fan-out's candidate list with loads, from the same auto
    # pool a single run uses. It landed in 1.22.49; an older CLI gives a confusing commander
    # "unknown option", so name the requirement and the fix.
    if ! agents devices pick --json >/dev/null 2>&1; then
      die "the installed 'agents' ($(agents --version 2>/dev/null || echo unknown)) has no 'devices pick --json'.
  Sharding needs >= 1.22.49. Upgrade it, then re-run:  scripts/test.sh --shard $SHARDS
  Until then:                                          scripts/test.sh --device <box>"
    fi

    # Take the N least-loaded eligible workers from the same auto pool a single --device auto run
    # uses, so role marks govern the fan-out. Not `mapfile`: macOS ships bash 3.2, and this must
    # run on the interactive Mac that dispatches the fan-out.
    SHARD_DEVICES=()
    while IFS= read -r _dev; do
      [[ -n "$_dev" ]] && SHARD_DEVICES+=("$_dev")
    done < <(
      agents devices pick --json 2>/dev/null \
        | python3 -c '
import json, sys
plan = json.load(sys.stdin)
cands = [c for c in plan.get("candidates", []) if c.get("headroom") != "loaded"]
cands.sort(key=lambda c: c.get("loadPercent") if c.get("loadPercent") is not None else 999)
for c in cands: print(c["device"])
'
    )
    (( ${#SHARD_DEVICES[@]} )) || die "could not enumerate workers ('agents devices pick --json')"
    fi

    if (( SHARDS > ${#SHARD_DEVICES[@]} )); then
      gray "Only ${#SHARD_DEVICES[@]} eligible workers; sharding across those instead of $SHARDS."
      SHARDS=${#SHARD_DEVICES[@]}
    fi

    bold "Sharding the suite across $SHARDS workers"
    declare -a SHARD_PIDS=() SHARD_LOGS=() SHARD_NAMES=()
    for ((i = 1; i <= SHARDS; i++)); do
      dev="${SHARD_DEVICES[$((i - 1))]}"
      log="$(mktemp "${TMPDIR:-/tmp}/agents-shard-$i.XXXXXX")"
      gray "  shard $i/$SHARDS -> $dev"
      ship_and_run "$dev" "--shard=$i/$SHARDS" > "$log" 2>&1 &
      SHARD_PIDS+=("$!"); SHARD_LOGS+=("$log"); SHARD_NAMES+=("$dev")
    done

    # Wait for ALL shards before reporting, so one early failure does not hide
    # the others -- the operator needs every failing shard, not the first.
    failed=0
    for ((i = 0; i < ${#SHARD_PIDS[@]}; i++)); do
      if wait "${SHARD_PIDS[$i]}"; then
        green "  shard $((i + 1))/$SHARDS passed on ${SHARD_NAMES[$i]}"
      else
        red   "  shard $((i + 1))/$SHARDS FAILED on ${SHARD_NAMES[$i]} (log: ${SHARD_LOGS[$i]})"
        failed=1
      fi
    done
    (( failed == 0 )) || die "$SHARDS-way shard run had failures; the logs above are the source of truth"
    green "All $SHARDS shards passed."
    ;;

  crabbox)
    [[ -x scripts/sandbox.sh ]] || die "scripts/sandbox.sh missing -- cannot offload"
    if ! command -v crabbox >/dev/null 2>&1; then
      die "--crabbox was requested but crabbox is not installed on this machine.
  Drop the flag to auto-pick a fleet worker: scripts/test.sh
  Or name one:                              scripts/test.sh --device yosemite-m1"
    fi
    # Fail loud, never silently local, naming the explicit alternatives. VITEST_ARGS must ride
    # through: the producer passes `-- --retry=2 --maxWorkers=2` and offload is its default, so
    # dropping them removes the mitigation against false failures (RUSH-3015).
    if ! scripts/sandbox.sh test ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}; then
      die "the crabbox run failed; the command output above is the source of truth.
  To auto-pick a fleet worker instead: scripts/test.sh
  To pin THIS machine:                 scripts/test.sh --here"
    fi
    ;;
esac
