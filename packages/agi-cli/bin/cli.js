#!/usr/bin/env node
// agi-cli is the front-brand alias of @phnx-labs/agents-cli (`agents`, `ag`, `agi` all exec the
// same tool). The canonical entry is spawned as the main module, not imported, so any
// `argv[1]`-based main-module guard fires correctly.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve the canonical package's `.` export (ESM-only, so import.meta.resolve —
// not require.resolve, whose subpath/require condition the exports map blocks).
const entry = fileURLToPath(import.meta.resolve("@phnx-labs/agents-cli"));

const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
