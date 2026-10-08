#!/usr/bin/env bash
set -euo pipefail

HEAD_SHA="${1:?usage: release-ci-produce.sh <head-sha> <store> (--inherit <attestation>|--impact <attested-commit>)}"
STORE="${2:?usage: release-ci-produce.sh <head-sha> <store> (--inherit <attestation>|--impact <attested-commit>)}"
MODE="${3:?usage: release-ci-produce.sh <head-sha> <store> (--inherit <attestation>|--impact <attested-commit>)}"
VALUE="${4:?usage: release-ci-produce.sh <head-sha> <store> (--inherit <attestation>|--impact <attested-commit>)}"
SCRIPT_DIR="${BASH_SOURCE[0]%/*}"; [[ "$SCRIPT_DIR" != "${BASH_SOURCE[0]}" ]] || SCRIPT_DIR=.

case "$MODE" in
  --inherit)
    exec "$SCRIPT_DIR/release-attestation-produce.sh" "$HEAD_SHA" \
      --inherit-suite-from "$VALUE" --dir "$STORE"
    ;;
  --impact)
    exec "$SCRIPT_DIR/release-attestation-produce.sh" "$HEAD_SHA" \
      --test-impact-from "$VALUE" --dir "$STORE"
    ;;
  *)
    echo "error: expected --inherit or --impact, got $MODE" >&2
    exit 2
    ;;
esac
