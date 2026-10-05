#!/usr/bin/env bash
set -euo pipefail

_scripts_dir="${BASH_SOURCE[0]%/*}"; [[ "$_scripts_dir" != "${BASH_SOURCE[0]}" ]] || _scripts_dir=.
source "$_scripts_dir/lib/common.sh"

cd "$(dirname "$0")/.."
CLI_DIR="$(pwd)"

MODE="auto"
MODE_FLAG=""
DEVICE=""
SHARDS=0
SHARD_LIST=""
REPO_ROOT=""
VITEST_ARGS=()

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
    --shard) shard_count_ok "${2:-}"; SHARDS="$2"; set_mode shard --shard; shift 2 ;;
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

if [[ "$MODE" == "device" && "$DEVICE" == "auto" ]]; then MODE="auto"; DEVICE=""; fi

SHARD_DEVICES=()
if [[ "$MODE" == "shard" && -n "$SHARD_LIST" ]]; then
  _IFS_SAVE="$IFS"; IFS=','
  for _d in $SHARD_LIST; do [[ -n "$_d" ]] && SHARD_DEVICES+=("$_d"); done
  IFS="$_IFS_SAVE"
  (( ${#SHARD_DEVICES[@]} )) || die "--devices parsed to nothing: '$SHARD_LIST'"
  (( SHARDS )) || { SHARDS=${#SHARD_DEVICES[@]}; shard_count_ok "$SHARDS" --devices; }
fi

if [[ -n "$REPO_ROOT" ]]; then
  [[ -d "$REPO_ROOT/cli" ]] || die "--repo-root '$REPO_ROOT' has no cli"
  CLI_DIR="$(cd "$REPO_ROOT/cli" && pwd)"
fi
TREE_ROOT="$(cd "$CLI_DIR/.." && pwd)"

vitest_suffix() {
  ((${#VITEST_ARGS[@]})) || return 0
  local a
  printf ' --'
  for a in "${VITEST_ARGS[@]}"; do printf ' %s' "$(printf '%q' "$a")"; done
}

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

if [[ "$MODE" == "auto" ]]; then
  command -v agents >/dev/null 2>&1 \
    || die "the 'agents' CLI is not on PATH, so a worker cannot be auto-picked.
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  if ! DEVICE="$(agents devices pick)"; then
    if ! agents devices --help 2>/dev/null | grep -qE '^[[:space:]]*pick([[:space:]]|$)'; then
      die "the installed 'agents' CLI has no 'devices pick' -- it predates the auto-picker.
  Upgrade it, or name a box until you do:  scripts/test.sh --device yosemite-m1"
    fi
    die "no worker device is available (see the message above).
  Name one explicitly:  scripts/test.sh --device yosemite-m1
  Or pin THIS machine:  scripts/test.sh --here"
  fi
  [[ -n "$DEVICE" ]] || die "'agents devices pick' returned no device"
  if [[ "$(hostname -s 2>/dev/null || hostname)" == "$DEVICE" ]]; then
    gray "Auto-picked THIS machine ($DEVICE) -- it is a pool worker, so running in place."
    MODE="here-worker"
  else
    MODE="device"
  fi
fi

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
    if [[ "$MODE" == "here" ]]; then
      red "WARNING: running the full suite on THIS machine ($(hostname -s))."
      red "         ~13k tests, several minutes of pinned CPU. Ctrl-C now to offload instead."
    fi
    cd "$CLI_DIR"
    # shellcheck disable=SC2046
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
    command -v rsync >/dev/null || die "rsync not found"
    command -v ssh   >/dev/null || die "ssh not found"
    if (( ${#SHARD_DEVICES[@]} )); then :; else
    command -v agents >/dev/null 2>&1 || die "the 'agents' CLI is not on PATH, so workers cannot be picked"
    if ! agents devices pick --json >/dev/null 2>&1; then
      die "the installed 'agents' ($(agents --version 2>/dev/null || echo unknown)) has no 'devices pick --json'.
  Sharding needs >= 1.22.49. Upgrade it, then re-run:  scripts/test.sh --shard $SHARDS
  Until then:                                          scripts/test.sh --device <box>"
    fi

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
    if ! scripts/sandbox.sh test ${VITEST_ARGS[@]+"${VITEST_ARGS[@]}"}; then
      die "the crabbox run failed; the command output above is the source of truth.
  To auto-pick a fleet worker instead: scripts/test.sh
  To pin THIS machine:                 scripts/test.sh --here"
    fi
    ;;
esac
