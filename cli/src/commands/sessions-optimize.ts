import type { Command } from 'commander';
import chalk from 'chalk';

import { optimizeSessionSearchIndex } from '../lib/session/db.js';
import { setHelpSections } from '../lib/help.js';

interface OptimizeOpts {
  json?: boolean;
}

export function registerSessionsOptimizeCommand(sessionsCmd: Command): void {
  registerOptimizeCommand(sessionsCmd, 'agents sessions optimize');
}

export function registerOptimizeCommand(parent: Command, invocation: string): void {
  const cmd = parent
    .command('optimize')
    .description('Compact the session search index (FTS5), reclaiming bloat from repeated re-indexing')
    .option('--json', 'Emit machine-readable JSON')
    .action((_opts, c: Command) => {
      const opts = c.optsWithGlobals() as OptimizeOpts;
      const results = optimizeSessionSearchIndex();
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for (const r of results) {
        const merged = Math.max(0, r.segmentsBefore - r.segmentsAfter);
        console.log(
          `  ${chalk.cyan(r.table)}: ${r.segmentsBefore} -> ${r.segmentsAfter} segments ` +
          `(${chalk.green(merged)} merged)`,
        );
      }
      console.log(
        chalk.gray('  Reclaimed space stays as reusable pages inside the file; VACUUM (daemon stopped) returns it to disk.'),
      );
    });

  setHelpSections(cmd, {
    examples: `
      # Compact the session/tool search index once it has grown fragmented
      ${invocation}

      # Machine-readable segment counts
      ${invocation} --json

      # Wire it to a weekly routine so the index never re-bloats
      agents routines add sessions-optimize --schedule "0 4 * * 0" --agent claude \\
        --prompt "Run: ${invocation}"
    `,
    notes: `
      - FTS5 appends a segment on every insert and tombstones every delete; the scanner delete+inserts a session's docs on each rescan and never self-merges, so \`tool_call_text_data\` / \`session_text_data\` bloat with unmerged segments — GBs of index for tens of MB of content, and queries slow down.
      - This runs FTS5 \`'optimize'\`: it merges every segment into one and purges tombstones. Non-destructive — no searchable content is lost.
      - Reclaimed space becomes reusable free pages inside the DB file. To return it to the OS, use the operator lifecycle command \`agents daemon stop\`, run \`VACUUM\` against \`~/.agents/.history/sessions/sessions.db\`, then \`agents daemon start\`. \`agents routines stop\` disables only the scheduler service.
    `,
  });
}
