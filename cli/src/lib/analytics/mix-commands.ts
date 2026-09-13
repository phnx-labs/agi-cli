/**
 * Counter / warehouse mix recipes under `agents insights`.
 *
 * These used to live as the top-level `agents trends` tree. That name was a
 * peer of `agents insights` with overlapping "analytics" meaning, so agents and
 * humans kept picking the wrong verb. The cheap counter path (sessions index +
 * usage.db) still exists — it is now `agents insights mix`. Latency stays on
 * `agents insights perf`; quota on `agents view`.
 *
 * One surface, not five: the board is `agents insights mix`, one section is
 * `agents insights mix <recipe>`, and `--list` names the recipe ids. The former
 * per-recipe shortcut commands (`harness-mix`, `model-mix`, …), the `recipes`
 * lister, and the `trends` alias were removed — `mix` already did all three.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { setHelpSections } from '../help.js';
import {
  buildMixDashboard,
  analyticsWindow,
  runRecipe,
  RECIPE_IDS,
  type RecipeId,
} from './dashboard.js';
import { listRecipes } from './recipes.js';
import { queryUsage, usageDbPath, type UsageKind, USAGE_KINDS } from './usage-db.js';

interface MixOpts {
  days?: string;
  json?: boolean;
  limit?: string;
}

function parseMixDays(raw: string | undefined): number {
  const n = parseInt(raw ?? '7', 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? String(fallback), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function printMixSection(section: {
  id: string;
  title: string;
  rows: Array<Record<string, string | number | null>>;
}): void {
  console.log(chalk.bold(section.title));
  if (section.rows.length === 0) {
    console.log(chalk.gray('  (no data)'));
    console.log();
    return;
  }
  const keys = Object.keys(section.rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...section.rows.map((r) => String(r[k] ?? '').length), 4));
  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length));
  console.log(chalk.gray(keys.map((k, i) => pad(k.toUpperCase(), widths[i])).join('  ')));
  for (const row of section.rows) {
    console.log(keys.map((k, i) => pad(String(row[k] ?? ''), widths[i])).join('  '));
  }
  console.log();
}

function renderMixDashboard(days: number, asJson: boolean, bannerLabel = 'agents insights mix'): void {
  const dash = buildMixDashboard({ days });
  if (asJson) {
    console.log(JSON.stringify(dash, null, 2));
    return;
  }
  console.log(chalk.bold(`${bannerLabel} — last ${dash.window.days} days`));
  console.log(chalk.gray(`compute ${dash.durationMs}ms · usage ${usageDbPath()}`));
  console.log();
  if (dash.sections.length === 0) {
    console.log(chalk.gray('No session or usage data in this window yet.'));
    return;
  }
  for (const section of dash.sections) printMixSection(section);
}

/**
 * Attach counter-mix subcommands to a parent (typically `insights`).
 *
 * Layout:
 *   <parent> mix                 multi-recipe board
 *   <parent> mix <recipe>        one baked recipe (harness-mix, model-mix, …)
 *   <parent> mix --list          list recipe ids
 *   <parent> query               raw usage.db rows
 */
export function registerMixCommands(parent: Command): void {
  const banner = 'agents insights mix';

  const mix = parent
    .command('mix [recipe]')
    .description('Counter recipes — harness/model mix, token ratios, resource frequency (sessions index + usage.db). Bare shows the board; pass a recipe id for one section.')
    .option('--days <n>', 'Days of history to include', '7')
    .option('--list', 'List baked recipe ids and exit')
    .option('--json', 'Emit JSON instead of tables')
    .action(function summary(this: Command, recipe: string | undefined) {
      // optsWithGlobals(): --json collides by name with the `insights` parent, so
      // commander binds it to the parent and this.opts() never sees it. Merging
      // ancestor opts is what the per-recipe path below already does.
      const o = this.optsWithGlobals() as MixOpts & { list?: boolean };
      if (o.list) {
        const list = listRecipes();
        if (o.json) {
          console.log(JSON.stringify(list, null, 2));
          return;
        }
        for (const r of list) {
          console.log(`${r.id.padEnd(22)} ${r.store.padEnd(10)} ${r.title}`);
        }
        return;
      }
      if (recipe) {
        if (!(RECIPE_IDS as readonly string[]).includes(recipe)) {
          console.error(`Unknown recipe '${recipe}'. Known: ${(RECIPE_IDS as readonly string[]).join(', ')} (or 'agents insights mix --list').`);
          process.exitCode = 1;
          return;
        }
        const win = analyticsWindow(parseMixDays(o.days));
        const section = runRecipe(recipe as RecipeId, win);
        if (o.json) {
          console.log(JSON.stringify({ window: win, section }, null, 2));
          return;
        }
        if (section.empty) {
          console.log(chalk.gray(`No data for recipe '${recipe}' in the last ${win.days} days.`));
          return;
        }
        printMixSection(section);
        return;
      }
      renderMixDashboard(parseMixDays(o.days), Boolean(o.json), banner);
    });

  setHelpSections(mix, {
    examples: `
      # Auto recipe board (7d)
      agents insights mix

      # Last 30 days
      agents insights mix --days 30

      # One recipe as JSON
      agents insights mix harness-mix --json

      # List baked recipe ids
      agents insights mix --list

      # Raw usage events
      agents insights query --kind secret --days 7
    `,
    notes: `
      Session recipes read sessions.db; resource recipes read ~/.agents/.history/analytics/usage.db.
      Empty recipes are skipped on the default mix board. Pass one recipe id
      (\`agents insights mix harness-mix\`) for just that section; \`--list\` names them.
      This is the cheap counter path. Behavioural report (transcript content, account split)
      is bare \`agents insights\`. Latency is \`agents insights perf\`; quota is \`agents view\`.
      Skill/slash-command popularity is \`agents sessions stats\`.
    `,
  });

  parent.command('query')
    .description('Raw usage-event query (usage.db)')
    .option('--kind <kind>', `One of: ${USAGE_KINDS.join(', ')}`)
    .option('--name <name>', 'Resource name filter')
    .option('--event <event>', 'Event name filter')
    .option('--days <n>', 'Days of history', '7')
    .option('--limit <n>', 'Max rows', '40')
    .option('--json', 'Emit JSON')
    .action(function query(this: Command) {
      const o = this.optsWithGlobals() as { kind?: string; name?: string; event?: string; days?: string; limit?: string; json?: boolean };
      const win = analyticsWindow(parseMixDays(o.days));
      const kind = o.kind && (USAGE_KINDS as readonly string[]).includes(o.kind)
        ? o.kind as UsageKind
        : undefined;
      if (o.kind && !kind) {
        console.error(`Unknown kind '${o.kind}'. Expected: ${USAGE_KINDS.join(', ')}`);
        process.exitCode = 1;
        return;
      }
      const rows = queryUsage({
        kind,
        name: o.name,
        event: o.event,
        sinceIso: win.sinceIso,
        limit: parseLimit(o.limit, 40),
      });
      if (o.json) {
        console.log(JSON.stringify({ window: win, rows }, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.gray('No usage events.'));
        return;
      }
      printMixSection({
        id: 'query',
        title: 'Usage events',
        rows: rows.map((r) => ({
          ts: r.ts,
          kind: r.kind,
          name: r.name,
          event: r.event,
          agent: r.agent,
        })),
      });
    });

}
