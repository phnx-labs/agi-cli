import type { Command } from 'commander';
import { setHelpSections } from '../lib/help.js';
import { getSessionRoots } from '../lib/session/discover.js';
import { registerBackfillCommand } from './sessions-backfill.js';
import { registerOptimizeCommand } from './sessions-optimize.js';

export function registerDaemonIndexCommand(daemonCmd: Command): void {
  const index = daemonCmd
    .command('index')
    .description('Maintain the session index the daemon keeps: transcript roots, FTS compaction, historical backfills. Runs in the foreground; never starts or restarts the daemon.');
  setHelpSections(index, {
    examples: `
      # Directories the indexer scans, per agent (JSON)
      agents daemon index roots

      # Compact the full-text search index
      agents daemon index optimize

      # One-shot historical catch-up
      agents daemon index backfill tools --fleet
      agents daemon index backfill resources --since 30d
      agents daemon index backfill titles --limit 20
    `,
    notes: `
      - The daemon's session-index service keeps new and changed sessions current on its own; these verbs are explicit maintenance on top of it.
      - Each verb is the same engine as its \`agents sessions\` spelling (\`--roots\`, \`optimize\`, \`backfill\`).
    `,
  });

  const roots = index
    .command('roots')
    .description('Print the on-disk directories scanned for session transcripts, per agent, as JSON (for external watchers)');
  roots.action(() => {
    process.stdout.write(JSON.stringify(getSessionRoots(), null, 2) + '\n');
  });
  setHelpSections(roots, {
    examples: `
      # Every existing transcript directory, including routine run archives
      agents daemon index roots
    `,
    notes: `
      - Output is always a JSON array of { agent, dirs }; an agent with no existing directory is omitted.
    `,
  });

  registerOptimizeCommand(index, 'agents daemon index optimize');
  registerBackfillCommand(index, 'agents daemon index backfill');
}
