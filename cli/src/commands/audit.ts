/**
 * `agents events audit` — thin alias of `agents events --include runs`.
 *
 * New run-dispatch outcomes land in the unified event stream as `run.dispatched`
 * (see lib/audit/log.ts::recordDispatchedRun). This command does not own a
 * separate store or query path — it only sets the default family filter.
 *
 *   agents events audit              ≡ agents events --include runs
 *   agents events audit list         ≡ same
 *   agents events audit verify       walks the legacy hash-chain file if present
 *                                    (pre-unification history only)
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  verifyAuditChain,
  readAuditLog,
  getAuditLogPath,
} from '../lib/audit/log.js';
import { addEventsReadOptions, runEventsCommand, type EventsOptions } from './events.js';

export function registerAuditCommands(events: Command): void {
  const audit = addEventsReadOptions(
    events
      .command('audit')
      .description('Alias of `agents events --include runs` — dispatched-run outcomes'),
  )
    .addHelpText('after', `
Examples:
  agents events audit                  Same as: agents events --include runs
  agents events audit --since 7d --json
  agents events audit list             Muscle-memory alias of bare audit
  agents events audit verify           Legacy hash-chain file only (if present)
`)
    .action((_options: EventsOptions, command: Command) => {
      const opts = command.optsWithGlobals() as EventsOptions;
      // Bare audit defaults to --include runs unless the user already set families.
      if (!opts.include && !opts.exclude) opts.include = 'runs';
      return runEventsCommand(opts);
    });

  audit
    .command('list')
    .description('Alias of `agents events audit` / `agents events --include runs`')
    .action((_options: EventsOptions, command: Command) => {
      const parent = command.parent;
      const opts = {
        ...(parent?.optsWithGlobals?.() ?? {}),
        ...(command.optsWithGlobals?.() ?? {}),
        include: 'runs',
      } as EventsOptions;
      return runEventsCommand(opts);
    });

  audit
    .command('verify')
    .description('Walk the legacy hash-chain file (pre-unification history only)')
    .option('--json', 'Output the result as JSON')
    .action((options: { json?: boolean }) => {
      const logPath = getAuditLogPath();
      const records = readAuditLog(logPath);
      if (records.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ ok: true, legacy: true, records: 0, note: 'no legacy audit chain; new runs use events --include runs' }));
          process.exit(0);
        }
        console.log(chalk.green('✓ no legacy audit chain present'));
        console.log(chalk.gray('  New run outcomes: agents events --include runs'));
        console.log(chalk.gray(`  (looked for ${logPath})`));
        process.exit(0);
      }
      const result = verifyAuditChain(logPath);
      if (options.json) {
        console.log(JSON.stringify({ ...result, legacy: true, records: records.length }));
        process.exit(result.ok ? 0 : 1);
      }
      if (result.ok) {
        console.log(chalk.green(`✓ legacy audit chain intact — ${records.length} record(s) verified`));
        console.log(chalk.gray(`  ${logPath}`));
        console.log(chalk.gray('  New runs use the events stream: agents events --include runs'));
        process.exit(0);
      }
      console.error(chalk.red(`✗ legacy audit chain BROKEN at record #${result.brokenAt}`));
      console.error(chalk.gray(`  ${logPath}`));
      process.exit(1);
    });
}
