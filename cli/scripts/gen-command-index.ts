// Generate the `agents` command reference with the shared @phnx-labs/cli-docs
// generator, the one every Phoenix CLI uses:
//
//   docs/command-index.md        a grouped, human-scannable index
//   docs/command-index.json      the canonical, structured API surface
//   docs/command-reference.html  sidebar command tree + search
//
// GENERATED artifacts: never hand-edit them. `npm run gen:index` writes them;
// `npm run verify:index` (this script with --check) fails CI when they are stale.
// release.sh regenerates them so the committed index matches the shipped surface.
//
// The source of truth is the CLI's lazy loader table: `buildFullCommandTree`
// registers every module in `COMMAND_LOADERS` onto a throwaway program. Excluded by
// design: the inline deprecated aliases and tombstones src/index.ts registers as
// closures over entry-point state.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runReferenceScript, type ReferenceOptions } from '@phnx-labs/cli-docs';
import { getHelpSections } from '../src/lib/help.js';
import { buildFullCommandTree } from '../src/cli/command-registry.js';

export const AGENTS_REFERENCE: ReferenceOptions = {
  bin: 'agents',
  description: 'Install, configure, run, and dispatch AI coding agents (Claude, Codex, Cursor, OpenCode, Grok, Droid and more) from one CLI: version homes, synced resources, sessions, teams, browser and desktop tools, secrets, and the device fleet.',
  helpSections: getHelpSections,
  excluded: 'commands Commander marks hidden, plus the deprecated aliases and tombstones registered inline in src/index.ts (`perms`, `exec`, `jobs`, `cron`, `check`, `resources`, `hq`, `_internal`).',
  regenerate: 'npm run gen:index',
};

// Only when executed directly; vitest imports AGENTS_REFERENCE without side effects.
if ((import.meta as { main?: boolean }).main) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  runReferenceScript(await buildFullCommandTree(), { ...AGENTS_REFERENCE, outDir });
}
