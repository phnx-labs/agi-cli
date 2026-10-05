import type { Command } from 'commander';
import chalk from 'chalk';

import { loadReminders, remindersFilePath } from '../lib/reminders.js';
import { setHelpSections } from '../lib/help.js';

const EXAMPLES = [
  'agents reminders          # list your operating reminders',
  'agents reminders --json   # machine-readable output',
].join('\n');

const NOTES = [
  "Reminders live in ~/.agents/reminders/reminders.yaml and sync across the fleet via 'agents repo push'.",
  'One shows succinctly in the Claude statusline per session, chosen deterministically from the session id,',
  'so concurrent agents each show a different one and it stays stable within a session.',
].join('\n');

export function registerRemindersCommand(program: Command): void {
  const cmd = program
    .command('reminders')
    .description('Personal operating reminders shown in the Claude statusline')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      const file = remindersFilePath();
      let reminders;
      try {
        reminders = loadReminders();
      } catch (err) {
        console.error(
          chalk.red(`Could not read reminders: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ file, reminders }, null, 2)}\n`);
        return;
      }

      if (reminders.length === 0) {
        console.log(`No reminders yet. Add them to ${chalk.cyan(file)}`);
        console.log(chalk.dim('Each shows succinctly in the Claude statusline — one per session.'));
        return;
      }

      const count = `${reminders.length} reminder${reminders.length === 1 ? '' : 's'}`;
      console.log(chalk.dim(`${count} · ${file}`));
      console.log(
        chalk.dim('One shows in the Claude statusline per session, chosen from the session id.\n'),
      );
      for (const reminder of reminders) {
        console.log(`  ${chalk.cyan('◆')} ${chalk.bold(reminder.short)}`);
        if (reminder.full && reminder.full !== reminder.short) {
          console.log(`    ${chalk.dim(reminder.full)}`);
        }
      }
    });

  setHelpSections(cmd, { examples: EXAMPLES, notes: NOTES });
}
