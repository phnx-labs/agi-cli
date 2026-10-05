#!/usr/bin/env bash
# E2E regression for #112/#137: installing agents-cli over existing Claude Code/Codex config must
# not lose settings. Builds, packs, and replays npm install, setup, import and launch sync in a
# clean node:24 container (needs docker). Usage: bash tests/e2e/fresh-install-settings.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_DIR=$(pwd)
# Keep the pack dir inside the repo: colima/Docker Desktop only share /Users
# by default, so a /var/folders mktemp dir would mount as an empty directory.
WORK_DIR=$(mktemp -d "$REPO_DIR/.e2e-pack-XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

docker info >/dev/null 2>&1 || { echo "SKIP: docker daemon not available"; exit 0; }

echo "==> build + pack"
bun run build >/dev/null
# --ignore-scripts: skip the prepack keychain-helper verification; the signed
# macOS app only exists in release builds and is unused on Linux. The packed
# tarball still contains scripts/postinstall.js, which runs in the container.
npm pack --silent --ignore-scripts --pack-destination "$WORK_DIR" >/dev/null
TGZ=$(ls "$WORK_DIR"/*.tgz)
echo "    $(basename "$TGZ")"

echo "==> docker run (node:24-bookworm)"
docker run --rm \
  -v "$TGZ:/e2e/agents-cli.tgz:ro" \
  -v "$REPO_DIR/tests/e2e/container-fresh-install.sh:/e2e/run.sh:ro" \
  node:24-bookworm \
  bash /e2e/run.sh
