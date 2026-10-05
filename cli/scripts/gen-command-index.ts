// Generate the `agents` command reference with @phnx-labs/cli-docs: docs/command-index.md,
// command-index.json and command-reference.html. Generated, never hand-edited: `npm run gen:index`
// writes, `npm run verify:index` fails CI when stale.

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

if ((import.meta as { main?: boolean }).main) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs');
  runReferenceScript(await buildFullCommandTree(), { ...AGENTS_REFERENCE, outDir });
}
