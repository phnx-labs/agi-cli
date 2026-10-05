/**
 * `agents setup tools` — install or upgrade the standalone CLIs this release is
 * tested against (sessions, browser, secrets, computer, term) to their pinned
 * floors in `lib/standalone-tools.ts`. Idempotent: a tool at or above its floor
 * is left alone, so it is safe to run on every device of the fleet.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../lib/help.js';
import { ensureToolPins, STANDALONE_TOOLS, type StandaloneTool, type ToolPinRow } from '../lib/standalone-tools.js';

function parseTools(values: string[] | undefined): StandaloneTool[] | undefined {
  if (!values?.length) return undefined;
  const tools = values.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  for (const tool of tools) {
    if (!STANDALONE_TOOLS.includes(tool as StandaloneTool)) {
      throw new Error(`Unknown tool "${tool}". Choose from: ${STANDALONE_TOOLS.join(', ')}.`);
    }
  }
  return tools as StandaloneTool[];
}

function renderRow(row: ToolPinRow): string {
  const have = row.installed ?? 'not installed';
  const label = row.tool.padEnd(9);
  if (row.state === 'ok') return `  ${chalk.green('[x]')} ${label} ${have} ${chalk.gray(`(>= ${row.floor})`)}`;
  if (row.state === 'installed' || row.state === 'upgraded') {
    return `  ${chalk.green('[x]')} ${label} ${have} ${chalk.gray(`(${row.state}, >= ${row.floor})`)}`;
  }
  if (row.state === 'failed') return `  ${chalk.red('[!]')} ${label} ${have} ${chalk.red(row.error ?? 'install failed')}`;
  return `  ${chalk.yellow('[ ]')} ${label} ${have} ${chalk.yellow(`needs ${row.pkg}@${row.floor}`)}`;
}

export function registerSetupToolsCommand(setupCmd: Command): void {
  const cmd = setupCmd
    .command('tools')
    .description('Install or upgrade the standalone sessions, browser, secrets, computer, and term CLIs to the versions this release pins')
    .option('--tool <name...>', `Only these tools: ${STANDALONE_TOOLS.join(', ')} (repeatable or comma-separated)`)
    .option('--dry-run', 'Report what is below its pin without installing anything')
    .option('--json', 'Print one row per tool as JSON (installer output goes to stderr)')
    .action(async (opts: { tool?: string[]; dryRun?: boolean; json?: boolean }) => {
      let tools: StandaloneTool[] | undefined;
      try {
        tools = parseTools(opts.tool);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exitCode = 2;
        return;
      }
      const rows = await ensureToolPins({ tools, dryRun: opts.dryRun, logToStderr: opts.json });
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else for (const row of rows) console.log(renderRow(row));
      if (rows.some((row) => row.state !== 'ok' && row.state !== 'installed' && row.state !== 'upgraded')) process.exitCode = 1;
    });

  setHelpSections(cmd, {
    examples: `
      # See which tools are below the pinned release, without installing
      agents setup tools --dry-run

      # Bring every tool up to its pin (npm install -g <pkg>@<pin>)
      agents setup tools

      # Just one tool, machine-readable
      agents setup tools --tool sessions --json

      # Every reachable device, one at a time
      agents ssh yosemite-s1 'agents setup tools'
    `,
    notes: `
      - A tool already at or above its pin is never downgraded or reinstalled.
      - Exit 1 when any tool is still below its pin (dry run, failed install, or an
        older copy earlier on PATH shadowing the new one).
    `,
  });
}
