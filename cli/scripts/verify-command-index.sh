#!/usr/bin/env bash
# Fail if docs/command-index.{md,json} or docs/command-reference.html are stale
# versus the CLI's own command tree: a command was added, renamed or re-described
# without `npm run gen:index` being re-run and committed. The shared generator's
# --check mode regenerates in memory and names each stale file.
#
# Requires bun + node_modules (the generator loads every command module). Run
# from cli/.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bun scripts/gen-command-index.ts --check
