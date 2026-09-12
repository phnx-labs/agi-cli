#!/usr/bin/env bash
#
# Interim producer for exact-tree release attestations (RUSH-2749).
#
# RUSH-2666 landed the CONSUMER (release.sh requires a passing attestation for
# a candidate tree, never rebuilds) without a PRODUCER: nothing writes
# ATTEST.json + the pretested tarball into the attestation store. Every
# release.sh run wedges at "missing exact attestation key" as a result. The
# durable fix is a CI lane on the near-instant-CI plan
# (.agents/artifacts/2026-08-15/plan-ci-release-near-instant.md); this script
# is the documented interim path an operator runs by hand until that lane
# lands, and it doubles as the reusable step that lane will eventually call.
#
# What it does, against an isolated worktree at the EXACT commit given:
#   1. Runs the full suite (bun run test). Fail closed -- no attestation is
#      written for a red suite.
#   2. With --with-helpers, on a macOS box with `agents` + the apple.com secrets
#      bundle, signs and notarizes the CLI binary headlessly (the same step
#      release.sh's privileged phase ran before RUSH-2666 relocated build/sign to
#      attestation time). Off that box the step is simply skipped, and since
#      RUSH-3100 that costs nothing: the tarball carries no helper bundle, so
#      there is nothing for `npm pack` to gate on and no unsigned bundle can ship
#      from anywhere. No helper is built here at all: the menu-bar helper's source
#      lives in phnx-labs/agi-menu (PHNX-4036) and is recorded in the helper
#      manifest from its PUBLISHED release (step 5). The keychain helper moved
#      with the standalone `secrets` engine (PHNX-3989), and the computer helpers
#      moved with the standalone `computer` engine (PHNX-4075) -- neither is a
#      helper of this CLI any more. (The CLI binary left the tarball in
#      RUSH-3026; the sign step below still builds it on a Mac for the
#      per-release GitHub-asset path.)
#   3. Packs the tarball (`npm pack`) and binds its sha256 into the record.
#   4. Writes the attestation via release-attestation.sh write, then copies
#      the tarball alongside it so release-attestation.sh tarball/promote can
#      find it (`require`/`tarball` resolve the .tgz relative to the JSON's
#      own directory).
#
# Usage:
#   scripts/release-attestation-produce.sh <commit-ish> [--dir DIR]
#                                           [--repo-root DIR] [--keep]
#                                           [--with-helpers]
#                                           [--inherit-suite-from BASE.json]
#                                           [--test-shard <n> | --test-devices a,b,c
#                                            | --test-device <box> | --test-here
#                                            | --test-crabbox]
#
# --inherit-suite-from BASE.json mints the attestation from an already-green BASE
# (the default-branch tree) WITHOUT re-running the suite -- the redundant second
# full-suite run per release (PHNX-3237). Sound only for a release commit, whose
# tree differs from BASE by version + changelog + generated command-index and
# nothing else; `release-attestation.sh derive` fails closed on any other changed
# path. build + pack still run, so the recorded tarball is the real release tree's.
# Incompatible with any --test-* flag (there is no suite to route).
#
# Where the suite runs. DEFAULT SHARDS across the fleet -- the suite is
# throughput-bound, so dividing it across N workers runs it in ~1/N the time
# (~269s on one box -> ~31s on 9). The count is resolved from the eligible
# workers `agents devices pick` reports, capped, and falls back to a single
# auto-picked box when fewer than 2 are eligible. --test-shard <n> forces a
# count; --test-devices a,b,c names the shard workers; --test-device <box> pins
# ONE box (no sharding); --test-here pins THIS machine (loud); --test-crabbox
# uses a disposable crabbox. All forward to scripts/test.sh, which owns the
# routing. Every shard still runs vitest at --maxWorkers=2 --retry=2, so the
# per-box flake mitigation is unchanged.
#
# --with-helpers (default OFF) additionally produces the helper input-digest
# manifest: menubar from its published menubar/v<floor> release
# (scripts/stage-menubar-helper.sh --fetch-only, sha256-verified; the source is
# not in this repo). Off by default for the same reason
# release.sh's flag is: the check aborts on any helper input change, including
# ones the tarball does not ship.
#
# --dir defaults to $RELEASE_ATTESTATION_DIR or <repo-root>/.release-attestations
# -- the same resolution release.sh uses, so producing and requiring agree
# without any extra flags once RELEASE_ATTESTATION_DIR is set consistently.
# --keep leaves the worktree in place for inspection instead of removing it.
set -euo pipefail

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
gray()   { printf '\033[2m%s\033[0m\n'  "$*"; }
bold()   { printf '\033[1m%s\033[0m\n'  "$*"; }

die() { red "error: $*"; exit 1; }

cd "$(dirname "$0")/.."
DEFAULT_REPO_ROOT="$(git rev-parse --show-toplevel)"

COMMIT_ISH=""
REPO_ROOT="$DEFAULT_REPO_ROOT"
STORE=""
KEEP=false
# Where the suite runs. Empty here means "no explicit target given" -- resolved
# below to a default SHARD across the fleet (resolve_default_shards), falling
# back to test.sh's single auto-picked worker only when <2 workers are eligible.
TEST_TARGET=()
# Default OFF, matching release.sh's flag of the same name. The helper manifest
# re-derives every helper's INPUT DIGEST and fails when one moved without a
# rebuild — correct when a release is publishing helpers, and pure obstruction
# when it is not. Proven on 2026-08-25: a one-line COMMENT fix in the then-in-repo
# computer-mac build script (an `apps/cli/` -> `cli/` path in prose) changed the
# digest and blocked an otherwise-perfect 1.22.49 attestation, for a helper the
# tarball no longer ships. That helper has since left the repo entirely
# (PHNX-4075); the hazard the flag guards against has not.
WITH_HELPERS=false
INHERIT_BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) STORE="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$2"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --test-device) [[ -n "${2:-}" ]] || die "--test-device needs a machine name"; TEST_TARGET=(--device "$2"); shift 2 ;;
    --test-here) TEST_TARGET=(--here); shift ;;
    # Parity with test.sh's third mode. Without it the producer could reach only
    # two of the three lanes, and a release on a box with no fleet worker in
    # reach had no way to ask for the disposable crabbox it can still use.
    --test-crabbox) TEST_TARGET=(--crabbox); shift ;;
    # Explicit sharding overrides (mirror test.sh). Absent these AND any other
    # --test-* flag, the producer shards by default (see resolve_default_shards
    # below) instead of pinning one box, so the ~13k-test suite finishes in ~1/N
    # the time. --test-shard <n> fans across n auto-picked workers; --test-devices
    # a,b,c names them.
    --test-shard) [[ -n "${2:-}" ]] || die "--test-shard needs a worker count, e.g. --test-shard 6"; TEST_TARGET=(--shard "$2"); shift 2 ;;
    --test-devices) [[ -n "${2:-}" ]] || die "--test-devices needs a comma-separated list, e.g. --test-devices m1,m2,m3"; TEST_TARGET=(--devices "$2"); shift 2 ;;
    # Inherit the suite result from an already-green BASE attestation instead of
    # re-running the ~13k-test suite (PHNX-3237). Sound ONLY for a release commit,
    # whose tree differs from BASE by version + changelog + generated command-index
    # and nothing else -- release-attestation.sh derive fails closed on any other
    # changed path, so a code change can never inherit a stale pass. build + pack
    # still run, so the recorded tarball is the real release tree's.
    --inherit-suite-from) [[ -n "${2:-}" ]] || die "--inherit-suite-from needs a base attestation JSON path"; INHERIT_BASE="$2"; shift 2 ;;
    --with-helpers) WITH_HELPERS=true; shift ;;
    -h|--help)
      # Print the WHOLE docblock, not a hardcoded line range. `sed -n '3,32p'`
      # silently truncated: --with-helpers was documented at ~line 40 and never
      # appeared in --help at all. A magic number drifts every time the header
      # grows, and it fails silently — the help just gets quieter. Stop at the
      # first non-comment line instead, so the range maintains itself.
      awk 'NR>2 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
      exit 0
      ;;
    --*) die "unknown flag: $1" ;;
    *)
      [[ -z "$COMMIT_ISH" ]] || die "unexpected argument: $1"
      COMMIT_ISH="$1"
      shift
      ;;
  esac
done
[[ -n "$COMMIT_ISH" ]] || die "usage: scripts/release-attestation-produce.sh <commit-ish> [--dir DIR] [--repo-root DIR] [--keep]"

# Inherit mode skips the suite entirely, so it is incompatible with any --test-*
# target and needs a readable base attestation. Fail loud rather than silently
# ignore a flag the caller thought would take effect.
if [[ -n "$INHERIT_BASE" ]]; then
  [[ -f "$INHERIT_BASE" ]] || die "--inherit-suite-from: base attestation not found: $INHERIT_BASE"
  [[ ${#TEST_TARGET[@]} -eq 0 ]] || die "--inherit-suite-from skips the suite; do not also pass a --test-* target"
fi

# Default to sharding the suite across the fleet. The suite is throughput-bound
# (measured ~3079s CPU at ~11.5x parallelism -> ~269s on one box), so the win is
# dividing the CPU across machines: test.sh --shard N runs ~1/N per box. Each
# shard still passes --maxWorkers=2 --retry=2 to vitest (below), so the RUSH-3015
# flake mitigation (integration tests contend on shared version-home state at
# high parallelism) is preserved PER BOX -- sharding adds machines, it does not
# raise per-box concurrency. Count eligible workers with the SAME filter test.sh's
# shard branch applies (headroom != "loaded", scripts/test.sh:~327), so this is the
# exact pool it will fan across -- counting raw candidates could ask for more shards
# than test.sh finds eligible, which it downshifts but with a misleading "only N
# eligible" line on every release. Shard across them (capped). Echo nothing when <2
# are eligible, so the caller falls back to test.sh's single auto-picked box (its
# --shard has no silent fallback, so we must resolve the count here rather than
# demand N boxes and fail a release on a thin fleet). jq/agents missing -> 0 ->
# single box, never an error.
SHARD_CAP=8
resolve_default_shards() {
  local n
  n="$(agents devices pick --json 2>/dev/null | jq -r '[.candidates[] | select(.headroom != "loaded")] | length' 2>/dev/null || echo 0)"
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  if (( n >= 2 )); then
    (( n > SHARD_CAP )) && n=$SHARD_CAP
    printf '%s\n' "$n"
  fi
}
# ${#arr[@]} is safe under `set -u` on bash 3.2 (the macOS trap is "${arr[@]}"
# expansion of an EMPTY array, not the length operator).
if [[ -z "$INHERIT_BASE" && ${#TEST_TARGET[@]} -eq 0 ]]; then
  default_shards="$(resolve_default_shards)"
  if [[ -n "$default_shards" ]]; then
    TEST_TARGET=(--shard "$default_shards")
    gray "Sharding the suite across $default_shards fleet workers (each at --maxWorkers=2)."
  else
    gray "Fewer than 2 eligible workers; running the suite on one auto-picked box."
  fi
fi

git -C "$REPO_ROOT" fetch --quiet origin
SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$COMMIT_ISH^{commit}" 2>/dev/null)" \
  || die "cannot resolve '$COMMIT_ISH' to a commit in $REPO_ROOT (fetch origin first if it's a remote ref)"
TREE="$(git -C "$REPO_ROOT" rev-parse "$SHA^{tree}")"

STORE="${STORE:-${RELEASE_ATTESTATION_DIR:-$REPO_ROOT/.release-attestations}}"
mkdir -p "$STORE"
# Resolve to an absolute path NOW, while cwd is still stable -- the rest of
# this script cd's into the throwaway worktree below, and a relative $STORE
# would then resolve there instead, silently writing (and losing, on cleanup)
# the attestation in the wrong directory.
STORE="$(cd "$STORE" && pwd)"

mkdir -p "$REPO_ROOT/.agents/worktrees"
WT="$(mktemp -d "$REPO_ROOT/.agents/worktrees/attest-produce.XXXXXX")"
cleanup() {
  if $KEEP; then
    gray "kept worktree for inspection: $WT"
  else
    git -C "$REPO_ROOT" worktree remove "$WT" >/dev/null 2>&1 \
      || gray "Retained attestation worktree for inspection: $WT"
  fi
}
trap cleanup EXIT

bold "Producing attestation for ${SHA:0:12} (tree ${TREE:0:12})"
git -C "$REPO_ROOT" worktree add --quiet --detach "$WT" "$SHA" \
  || die "could not create worktree at $WT from $SHA"

missing="$(git -C "$WT" status --short | awk '$1 == "D" || $2 == "D" { print $2 }')"
[[ -z "$missing" ]] || die "worktree $WT is incomplete; missing tracked files: $missing"

# apps/cli -> cli flatten (RUSH-3189 follow-up): the CLI moved up to cli/. A tree
# cut after the flatten carries cli/; older candidates carry apps/cli/. Drive off
# whichever layout THIS worktree's tree actually has.
CLI_DIR="cli"
[[ -d "$WT/cli" ]] || CLI_DIR="apps/cli"
cd "$WT/$CLI_DIR"

bun install --frozen-lockfile || die "bun install failed for ${SHA:0:12}"

[[ -n "$INHERIT_BASE" ]] || bold "Running the full suite..."
# RUSH-3007: cutting 1.22.44, the operator exported CI=true by hand to get
# vitest.config.ts's extended hookTimeout profile (RUSH-2970 trap 5a), which
# also armed tests/setup.ts's leak tripwires against this box's REAL
# ~/.agents — a live daemon + active sessions tripped 129/129 test files on
# hermeticity-guard writes while every individual test (12,559/12,559)
# passed, and the producer correctly refused to attest. AGENTS_ATTEST_PRODUCER
# is this script's own explicit, narrower opt-in: it gets the same vitest
# profile (tests/hermetic-guards.ts:shouldEnableCiTestProfile) WITHOUT arming
# those tripwires (shouldArmHermeticGuards). Unset CI defensively so a caller
# shell that still exports it by habit (the exact operator mistake above)
# cannot re-arm the guards out from under this flag.
unset CI
export AGENTS_ATTEST_PRODUCER=1
# Mirrors isVitestWorkerCrashWithZeroFailures (scripts/ci-scope.ts): vitest can
# exit 1 on an unhandled teardown "Worker exited unexpectedly" after every test
# passed (RUSH-2215; hit by this producer on a fully green tree, RUSH-2758).
# Only that exact shape is tolerated -- any 'failed' in the summary, or a
# missing summary, stays fail-closed.
suite_green_despite_worker_crash() {
  local log="$1" files_line tests_line
  grep -q 'Worker exited unexpectedly' "$log" || return 1
  files_line="$(grep -E '^[[:space:]]*Test Files[[:space:]]' "$log" | tail -1)"
  tests_line="$(grep -E '^[[:space:]]*Tests[[:space:]]' "$log" | tail -1)"
  [[ -n "$files_line" && -n "$tests_line" ]] || return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$files_line" && return 1
  grep -qE '(^|[^[:alnum:]])failed([^[:alnum:]]|$)' <<<"$tests_line" && return 1
  grep -qE '(^|[^[:alnum:]])passed([^[:alnum:]]|$)' <<<"$tests_line"
}
SUITE_LOG="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest-suite.XXXXXX")"
# RUSH-3015 follow-up: even with the producer's maxWorkers cap, 2 integration
# tests (self-heal.integration, drift-sync) flake under parallel load -- they
# contend on shared version-home state -- plus transient `npm 404` when real-CLI
# install tests hammer the registry. That flakes ~every producer run and refuses
# to attest a good tree, blocking releases. Retry re-runs a failed test (a real
# regression still fails all 3 attempts and stays fail-closed), and --maxWorkers=2
# cuts contention below the config's producer default of 4. Passed as CLI flags
# (not vitest.config.ts) on purpose: editing the global-setup config forces
# ci-scope to select those same flaky files into THIS pr's CI, which self-blocks
# the fix; and CLI flags override whatever config the attested commit carries, so
# the mitigation applies to every tree the producer runs, old or new.
# Offloaded via scripts/test.sh (RUSH-3178). This script must run on a macOS
# signing box whenever a native helper input changed, and it used to run the
# whole ~13k-test suite there too -- welding "sign on a Mac" to "pin a Mac for
# ten minutes". test.sh decides WHERE the suite runs; the Mac keeps only
# sign/notarize/pack. Default auto-picks a fleet worker; --test-device <box>
# targets a named box; --test-crabbox uses a disposable crabbox; --test-here
# restores the old in-place behavior explicitly.
# bash 3.2 (what macOS ships, and the producer MUST run on a Mac when a helper
# input changed) treats "${arr[@]}" on an EMPTY array as an unbound variable
# under `set -u`. The ${arr[@]+"${arr[@]}"} guard is the portable form.
if [[ -n "$INHERIT_BASE" ]]; then
  # Inherit mode: the base attestation already proved this tree passes (the diff
  # is version/changelog/command-index only, verified by derive below), so the
  # suite is not re-run. build + pack still run, so the recorded tarball is real.
  green "Inheriting the suite result from $(basename "$INHERIT_BASE") (skipping the full suite)."
  rm -f "$SUITE_LOG"
elif scripts/test.sh ${TEST_TARGET[@]+"${TEST_TARGET[@]}"} -- --retry=2 --maxWorkers=2 2>&1 | tee "$SUITE_LOG"; then
  green "Suite passed."
  rm -f "$SUITE_LOG"
elif suite_green_despite_worker_crash "$SUITE_LOG"; then
  gray "vitest worker exited after zero test failures; treating as pass (RUSH-2215)."
  green "Suite passed (teardown worker-exit tolerated on a green summary)."
  rm -f "$SUITE_LOG"
else
  die "suite failed for ${SHA:0:12} -- refusing to attest a red tree (log: $SUITE_LOG)"
fi

# Sign + notarize the CLI binary headlessly, matching what release.sh's
# privileged phase did before RUSH-2666 moved build/sign to attestation time.
# Skipped off a macOS signing box -- and since RUSH-3100 that skip costs nothing,
# because the tarball no longer carries a helper bundle for `npm pack` to gate
# on. The claim that "prepack gates fail closed in that case" was the old
# contract and is no longer what stops an unsigned helper shipping; nothing
# ships one, from anywhere. This block used to ALSO build + sign the menu-bar
# helper from cli/menubar; that source moved to phnx-labs/agi-menu (PHNX-4036)
# and the helper is now only ever consumed as its published release (recorded
# in the manifest below), so nothing here builds a helper.
# --with-helpers gates this too (PHNX-3699). An ORDINARY CLI release must sign
# nothing: since RUSH-3026 the CLI binary and since RUSH-3100 both helper .apps
# are absent from the tarball, so everything this block produces is unreferenced
# by the artifact being attested. Owner requirement R3 (../AGENTS.md) states it
# as law -- "no signing, no notarization on the ordinary path" -- and running it
# anyway is not merely wasteful: `agents secrets exec apple.com` cannot unlock a
# Touch-ID-gated bundle from a headless agent, so a macOS release DIED here
# ("CLI binary sign/notarize failed") even though the signed output ships
# nowhere. Cutting a HELPER release still signs; that is what --with-helpers is.
if [[ "$WITH_HELPERS" == true && "$(uname)" == "Darwin" ]] && command -v agents >/dev/null 2>&1 \
  && [[ -x scripts/sign-cli-binary.sh ]]; then
  bold "Signing + notarizing the CLI binary..."
  # Unlocks rush-signing.keychain-db and authorizes codesign/notarytool to use
  # the Developer ID key non-interactively; without it a headless `agents
  # secrets exec` hits errSecInternalComponent (the key ACL prompts for UI
  # approval that a headless session can never answer). Same preamble
  # release.sh's own privileged phase sources before any signing call.
  # shellcheck source=scripts/headless-sign-context.sh
  . scripts/headless-sign-context.sh
  agents secrets exec apple.com -- scripts/sign-cli-binary.sh \
    || die "CLI binary sign/notarize failed"
else
  # Nothing to do off a signing box: the tarball carries no helper bundle
  # (RUSH-3100), so `npm pack` neither wants nor gates on one.
  #
  # This branch used to SEED the already-signed .apps from the caller checkout,
  # because `prepack` refused to pack without them and a fresh worktree has an
  # empty bin/ -- that seeding was the workaround for the very coupling RUSH-3100
  # removed. With the gates gone the seed copies signed bundles into a tree that
  # will not ship them, and its own comment ("the prepack gates still decide ...
  # fails the pack exactly as before") became false the moment they were removed.
  # A stale comment guarding nothing is worse than no comment, so both are gone.
  gray "Not a macOS signing box -- nothing to do: the tarball ships no helper bundle."
fi

bold "Building (bun run build)..."
rm -rf dist
bun run build || die "build failed for ${SHA:0:12}"

bold "Packing the pretested tarball (npm pack)..."
TGZ_NAME="$(npm pack --silent 2>&1 | tail -1)"
[[ -f "$TGZ_NAME" ]] || die "npm pack did not produce a tarball (got: $TGZ_NAME)"
if command -v sha256sum >/dev/null 2>&1; then
  TGZ_DIGEST="$(sha256sum "$TGZ_NAME" | awk '{print $1}')"
else
  TGZ_DIGEST="$(shasum -a 256 "$TGZ_NAME" | awk '{print $1}')"
fi
green "Packed $TGZ_NAME (sha256:$TGZ_DIGEST)"

# Trailing X's, NOT `...XXXXXX.json` (PHNX-3631). BSD/macOS mktemp only
# substitutes X's at the END of the template; with a `.json` suffix after them it
# treats the whole string as a LITERAL filename, so the first call creates
# `agents-cli-attest.XXXXXX.json` and every later call on the same box dies with
# "mkstemp failed ... File exists". That made every macOS producer run fail --
# including the one release.sh now performs itself (PHNX-3696) -- while working
# fine on the Linux CI lane. GNU mktemp accepts trailing X's identically, so this
# form is correct on both.
ATTEST_TMP="$(mktemp "${TMPDIR:-/tmp}/agents-cli-attest.json.XXXXXX")"
if [[ -n "$INHERIT_BASE" ]]; then
  # Derive the record from the green base: it verifies the release tree differs
  # from the base tree by version/changelog/command-index only (fail-closed on
  # any other path) and inherits the base's suite/lock/policy/toolchain, recording
  # THIS tree's freshly packed tarball. The base's suite tag rides through, so the
  # record still speaks release.sh's "selected" vocabulary.
  scripts/release-attestation.sh derive \
      --base "$INHERIT_BASE" --tarball "$TGZ_NAME" \
      --repo-root "$WT" --commit "$SHA" \
      > "$ATTEST_TMP" \
      || die "derive failed for ${SHA:0:12} -- the release tree is not a metadata-only descendant of the base; run the full suite instead"
else
  # suite is "selected", not "full" or a producer-invented name: release.sh
  # never passes --suite to `release-attestation.sh require`
  # (bind_tree_lock_policy defaults an unset --suite to "selected"), so a record
  # tagged anything else is invisible to it, key-for-key correct on tree/lock/
  # policy or not. Running the full suite here satisfies "selected" -- it is a
  # superset -- but the record must still speak the consumer's vocabulary.
  scripts/release-attestation.sh identity --repo-root "$WT" --commit "$SHA" \
    | jq --arg name "$TGZ_NAME" --arg digest "sha256:$TGZ_DIGEST" \
        '. + {schemaVersion: 1, suite: "selected", conclusion: "pass", tarball: {filename: $name, digest: $digest}}' \
    > "$ATTEST_TMP"
fi

DEST_JSON="$(scripts/release-attestation.sh write --dir "$STORE" --file "$ATTEST_TMP")" \
  || die "failed to write attestation record"
rm -f "$ATTEST_TMP"
DEST_DIR="$(dirname "$DEST_JSON")"
mv "$TGZ_NAME" "$DEST_DIR/$TGZ_NAME"

green "Wrote $DEST_JSON"
green "Tarball at $DEST_DIR/$TGZ_NAME"

# ----- Helper manifest (RUSH-2766) -----
# release.sh consumes $STORE/release-manifest.json at require_helpers (:231)
# and upload_release_proof (:976), but until now nothing produced it -- same
# consumer-without-producer class as the attestation itself was before this
# script existed (RUSH-2749). The manifest is a SINGLE file per store dir,
# carried forward across producer runs: a helper whose input digest still
# matches the recorded one keeps its already-attested record untouched; one
# that drifted is re-recorded from its PUBLISHED release -- nothing is built
# here. menubar has no source in this repo at all (phnx-labs/agi-menu, PHNX-4036):
# its input is the floor pin in src/lib/helper-versions.ts, and a drift means
# the floor moved, so it is re-recorded from the published menubar/v<floor>
# asset (sha256-verified by scripts/stage-menubar-helper.sh --fetch-only) or
# fails closed when that release is missing or corrupt.
# The newest release that carries a helper manifest, falling back to the newest
# release overall.
#
# `gh release list --limit 1` returns whatever was published last, and not every
# release is a CLI release: helper-only releases have historically been published
# into the same `v<version>` tag namespace. One of those shadows the last real CLI
# release, the seed misses, and EVERY helper then reads as "changed" -- hard-failing
# on a helper this producer never rebuilds. Observed live: v1.22.48
# (helper-only, 09:54Z) shadowed v1.22.47 and blocked a release.
#
# On exhaustion this deliberately echoes the NEWEST tag rather than nothing, so
# the caller's existing per-reason diagnostics still fire unchanged: an empty
# list keeps "no published release to seed from", and a newest-release-without-
# the-asset keeps "<tag> carries no release-manifest.json" naming that tag.
# Skipping is an ADDITION to the existing behaviour, not a replacement for it.
newest_release_with_manifest() {
  local tags tag newest=""
  # Capture the list FIRST so gh's own failure is still reported as a gh failure.
  # Inside `done < <(...)` the exit status is lost, and an auth/network outage
  # would silently read as "no published release to seed from" -- erasing exactly
  # the misconfiguration the caller's diagnostics exist to surface.
  tags="$(gh release list --limit 20 --json tagName --jq '.[].tagName' 2>/dev/null)" || return 1
  while read -r tag; do
    [[ -n "$tag" && "$tag" != "null" ]] || continue
    [[ -n "$newest" ]] || newest="$tag"
    # `--jq index(...)` prints an EMPTY line when the asset is absent, not the
    # string "null" -- so require a digit. Index 0 is a valid match.
    if gh release view "$tag" --json assets \
         --jq '[.assets[].name] | index("release-manifest.json")' 2>/dev/null \
         | grep -qE '^[0-9]+$'; then
      printf '%s\n' "$tag"
      return 0
    fi
  done <<< "$tags"
  printf '%s\n' "$newest"
}

if [[ "$WITH_HELPERS" == true && -x scripts/release-manifest.sh ]]; then
  bold "Updating the helper manifest..."
  MANIFEST_FILE="$STORE/release-manifest.json"
  CLI_VERSION_MANIFEST="$(jq -r .version package.json)"
  if [[ ! -f "$MANIFEST_FILE" ]]; then
    # Seed from the last published release before falling back to an empty
    # manifest. Without this, a fresh store has no recorded inputDigest, the
    # helper loop below reads "input changed", and the recorder re-fetches a
    # published release on every hand-cut release for a byte-identical helper.
    # RUSH-2970 trap 1.
    # Each step is checked on its own rather than chained, so the reason a seed
    # did not happen is the reason reported. A single `&&` chain collapsed three
    # distinct outcomes into one branch: a gh that fails on auth read as "no
    # prior release" — hiding exactly the misconfiguration worth surfacing — and
    # a repo with zero releases printed the literal string `null`, because
    # `jq -r '.[0].tagName'` on an empty array emits "null", not "".
    seed_note=""
    if ! command -v gh >/dev/null 2>&1; then
      seed_note="no gh on PATH"
    elif ! PRIOR_TAG="$(newest_release_with_manifest)"; then
      seed_note="gh could not list releases (auth or network)"
    elif [[ -z "$PRIOR_TAG" || "$PRIOR_TAG" == "null" ]]; then
      seed_note="no published release to seed from"
    elif ! gh release download "$PRIOR_TAG" --pattern release-manifest.json --dir "$STORE" >/dev/null 2>&1 \
      || [[ ! -f "$MANIFEST_FILE" ]]; then
      seed_note="$PRIOR_TAG carries no release-manifest.json"
    fi

    if [[ -z "$seed_note" ]]; then
      gray "Seeded the helper manifest from $PRIOR_TAG (unchanged helpers carry forward)."
    else
      gray "Starting a fresh helper manifest — $seed_note."
      scripts/release-manifest.sh new --cli-version "$CLI_VERSION_MANIFEST" --cli-tree "$TREE" \
        > "$MANIFEST_FILE"
    fi
  fi

  manifest_asset_sha256() {
    local f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$f" | awk '{print $1}'
    else
      shasum -a 256 "$f" | awk '{print $1}'
    fi
  }

  # PHNX-4036: menubar is recorded from its PUBLISHED release, with no
  # source-digest sidecar to compare, because the source is not in this repo.
  # The proof chain is instead: the floor in
  # src/lib/helper-versions.ts names one immutable tag; stage-menubar-helper.sh
  # downloads that tag's asset and refuses a sha256 that differs from the tag's
  # own .sha256; the recorded assetDigest is the sha of those bytes; and the
  # optional `source` field carries the release's menubar-source.txt provenance
  # (repo/commit/tag) when the release has one. A missing or corrupt release
  # fails closed naming the agi-menu publish step.
  record_menubar_from_published() {
    local want_digest="$1" info floor tag zip sha url source
    [[ -x scripts/stage-menubar-helper.sh ]] \
      || die "helper menubar input changed but scripts/stage-menubar-helper.sh is missing from this tree -- cannot record the published helper"
    info="$(scripts/stage-menubar-helper.sh --fetch-only --json --download-dir "$WT/.mb-helper-dl")" \
      || die "helper menubar input changed and the published release could not be fetched/verified (see above) -- publish the helper from phnx-labs/agi-menu ('agents secrets exec apple.com -- scripts/release.sh <x.y.z>' there), point the menubar floor in src/lib/helper-versions.ts at it, then re-run this producer"
    floor="$(jq -r .floor <<<"$info")"
    tag="$(jq -r .tag <<<"$info")"
    zip="$(jq -r .zip <<<"$info")"
    sha="$(jq -r .sha256 <<<"$info")"
    url="$(jq -r .assetUrl <<<"$info")"
    source="$(jq -c .source <<<"$info")"
    [[ -f "$zip" && "$sha" =~ ^[0-9a-f]{64}$ ]] \
      || die "stage-menubar-helper.sh reported no verified asset for $tag: $info"
    local put_args=(--file "$MANIFEST_FILE" --helper menubar
      --helper-version "$floor" --input-digest "$want_digest"
      --asset-digest "sha256:$sha" --asset-path "$zip" --asset-url "$url" --platform darwin)
    [[ "$source" == "null" ]] || put_args+=(--source "$source")
    scripts/release-manifest.sh put "${put_args[@]}" >/dev/null \
      || die "failed to record menubar in the manifest"
    if [[ "$source" == "null" ]]; then
      green "Recorded menubar from published $tag (asset ${sha:0:12}; release carries no menubar-source.txt)"
    else
      green "Recorded menubar from published $tag (asset ${sha:0:12}, source $(jq -r '"\(.repo)@\(.commit)"' <<<"$source"))"
    fi
  }

  for helper in menubar; do
    helper_digest="$(scripts/release-manifest.sh input-digest --repo-root "$WT" --helper "$helper")" \
      || die "could not compute input digest for helper $helper"
    recorded_digest="$(jq -r --arg n "$helper" '.helpers[$n].inputDigest // empty' "$MANIFEST_FILE")"
    if [[ -n "$recorded_digest" && "$recorded_digest" == "$helper_digest" ]]; then
      gray "helper $helper unchanged (${helper_digest#sha256:}) -- carrying forward its attested record"
      continue
    fi
    # The helper is never built here -- it is recorded from its published,
    # verified release, or fails closed inside its function.
    case "$helper" in
      menubar) record_menubar_from_published "$helper_digest" ;;
    esac
  done
  green "Manifest at $MANIFEST_FILE"
else
  if [[ "$WITH_HELPERS" != true ]]; then
    gray "CLI-only attestation: skipping the helper manifest (pass --with-helpers to include it)."
  else
    gray "No scripts/release-manifest.sh in this tree -- skipping helper manifest production."
  fi
fi
