#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_DIR=$(pwd)
WORK_DIR=$(mktemp -d "$REPO_DIR/.e2e-pack-XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

docker info >/dev/null 2>&1 || { echo "SKIP: docker daemon not available"; exit 0; }

echo "==> build + pack"
bun run build >/dev/null
npm pack --silent --ignore-scripts --pack-destination "$WORK_DIR" >/dev/null
TGZ=$(ls "$WORK_DIR"/*.tgz)
echo "    $(basename "$TGZ")"

echo "==> docker run (node:24-bookworm)"
docker run --rm \
  -v "$TGZ:/e2e/agents-cli.tgz:ro" \
  -v "$REPO_DIR/tests/e2e/container-fresh-install.sh:/e2e/run.sh:ro" \
  node:24-bookworm \
  bash /e2e/run.sh
