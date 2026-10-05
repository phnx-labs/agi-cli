#!/usr/bin/env bash
# Fail if docs/command-index.{md,json} or docs/command-reference.html are stale versus the CLI's
# command tree, i.e. `npm run gen:index` was not re-run. The generator's --check mode regenerates
# in memory and names each stale file. Requires bun + node_modules; run from cli/.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun scripts/gen-command-index.ts --check
