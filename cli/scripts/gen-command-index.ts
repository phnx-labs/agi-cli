
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runReferenceScript, type ReferenceOptions } from '@phnx-labs/cli-docs';
import { getHelpSections } from '../src/lib/help.js';
import { buildFullCommandTree } from '../src/cli/command-registry.js';

export const AGENTS_REFERENCE: ReferenceOptions = {
  bin: 'agents',
  description: 'Install, configure, run, and dispatch AI coding agents (Claude, Codex, Cursor, OpenCode, Grok, Droid and more) from one CLI: version homes, synced resources, sessions, teams, browser and desktop tools, secrets, and the device fleet.',
  helpSections: getHelpSections,
  excluded: 'commands Commander marks hidden, plus the deprecated aliases and tombstones registered inline in src/index.ts (`perms`, `exec`, `jobs`, `cron`, `check`, `resources`, `hq`, `_internal`).',
  regenerate: 'scripts/generate-reference.sh',
};

if ((import.meta as { main?: boolean }).main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      check: { type: 'boolean' },
      'out-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: scripts/generate-reference.sh [--check] [--out-dir <directory>]

Generate the HTML command tree, JSON index, and Markdown reference from the CLI.
Run bun install in cli/ first. No build, browser, or running daemon is needed.

  scripts/generate-reference.sh                      Regenerate cli/docs
  scripts/generate-reference.sh --check              Fail on stale or missing files; write nothing
  scripts/generate-reference.sh --out-dir ./preview  Generate a separate preview

--out-dir is relative to your working directory. The default is always cli/docs.`);
  } else {
    const outDir = values['out-dir'] === undefined
      ? join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
      : resolve(values['out-dir']);
    runReferenceScript(await buildFullCommandTree(), { ...AGENTS_REFERENCE, outDir }, values.check ? ['--check'] : []);
  }
}
