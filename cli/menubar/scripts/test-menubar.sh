#!/bin/bash
#
# Runs every HEADLESS "AGI Menu" (menubar helper) self-test and fails on any FAIL.
#
# The helper's self-tests (SingleInstanceSelfTest, ChildProcessSelfTest,
# GuardsSelfTest, IssueSelfTest, ActiveSessionSelfTest, RoutineSelfTest,
# DoctorSelfTest, DeviceSelfTest) are
# env-gated modes of the binary that exit
# BEFORE the GUI/AppKit path (Guards.enforceForInteractiveLaunch in main.swift),
# so they run headless — no display, no signing, no bundle. Until this script
# nothing invoked them: PR CI is Linux (can't build Swift) and prepack only
# checks the shipped bundle's signature. A whole class of helper bugs (the flock
# fd-inheritance deadlock, the unbounded-child runaway) could regress unseen.
#
# NOT run here: MENUBAR_DUMP / MENUBAR_PROMPT_PREVIEW — those DO reach AppKit and
# need a GUI session, so they would hang/fail on a headless runner.
#
# Usage:
#   test-menubar.sh [BINARY]   # BINARY defaults to a fresh `swift build` debug binary
#
# build.sh calls this against the just-built binary, so no helper artifact is
# produced whose self-tests regressed. Runnable standalone (no args) for local
# dev or a macOS CI job. macOS-only (SwiftPM / Swift toolchain).

set -euo pipefail

cd "$(dirname "$0")/.."

BIN="${1:-}"
if [ -z "$BIN" ]; then
  swift build >/dev/null
  BIN=".build/debug/AGI Menu"
fi
if [ ! -x "$BIN" ]; then
  echo "test-menubar: binary not found or not executable: $BIN" >&2
  exit 1
fi

# Absolute fixture paths for the data-layer self-tests (PHNX-4002), so they
# resolve regardless of the invoking CWD. $PWD is the menubar dir (cd above).
export MENUBAR_FEED_FIXTURE="$PWD/Tests/fixtures/feed-sample.ndjson"
export MENUBAR_ARTIFACT_ROOT="$PWD/Tests/fixtures/artifacts-tree"
# The OCR self-test recognizes the committed fixture PNGs; point it at them.
export MENUBAR_OCR_FIXTURES="$PWD/Tests/fixtures"

fail=0
for mode in MENUBAR_GUARD_TEST MENUBAR_ISSUE_TEST MENUBAR_PROJECTS_TEST MENUBAR_SINGLE_TEST MENUBAR_CHILD_TEST MENUBAR_ACTIVE_TEST MENUBAR_ROUTINE_TEST MENUBAR_DOCTOR_TEST MENUBAR_DEVICE_TEST MENUBAR_FEED_TEST MENUBAR_ARTIFACT_TEST MENUBAR_OCR_TEST MENUBAR_NOTIFY_TEST; do
  echo "=== $mode ==="
  if ! env "$mode=1" "$BIN"; then
    echo "  $mode FAILED" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "menubar self-tests FAILED" >&2
  exit 1
fi
echo "menubar self-tests: all passed"
