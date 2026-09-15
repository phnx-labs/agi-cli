/**
 * Named router management commands.
 *
 * Registers the `agents route` command tree for creating, viewing, and
 * removing named routers -- reusable, task-typed allowlists of harnesses x
 * models/tiers x linked accounts that a future routing decision resolves
 * strictly within (see `.agents/artifacts/2026-08-10/agent-router-spec.md`,
 * requirements E1/E2). This ticket ships persistence + management only;
 * invoking a router to route a task is a separate ticket.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { withAliases } from '../lib/verbs.js';
import {
  listRouters,
  readRouter,
  writeRouter,
  deleteRouter,
  renameRouter,
  routerExists,
  routerSource,
  routersDir,
  validateRouter,
  type Router,
} from '../lib/routers.js';
import { MODEL_TIERS, isTierToken } from '../lib/model-tiers.js';
import { die } from '../lib/format.js';
import { setHelpSections } from '../lib/help.js';
import { findAccount } from '../lib/account-registry.js';
import * as path from 'path';

/**
 * Read a router that must be safely editable/removable from here: `writeRouter`
 * and `deleteRouter` only ever touch the user layer, so editing a router that
 * currently resolves from a project/system layer would silently write to a
 * user-layer file that stays permanently shadowed (the edit "succeeds" but is
 * never read back — the router keeps resolving to its project/system copy).
 * Fails loud instead, naming the layer and pointing at the fix.
 */
function requireEditableRouter(name: string): Router {
  const source = routerSource(name);
  if (source === null) die(`Router '${name}' not found.`);
  if (source !== 'user') {
    die(
      `Router '${name}' resolves from the '${source}' layer, not 'user' -- ` +
      `agents route can only edit or remove a user-layer router. Edit its file directly, ` +
      `or create a user-layer router under a different name.`,
    );
  }
  return readRouter(name);
}

/** Highest-tier-reached summary for a router's declared model/tier allowlist. */
function routerTierSummary(router: Router): string {
  const seen = new Set<string>();
  for (const allowlist of Object.values(router.harnesses)) {
    for (const token of allowlist.models) {
      if (isTierToken(token)) seen.add(token);
    }
  }
  if (seen.size === 0) return '-';
  const ordered = MODEL_TIERS.filter((t) => seen.has(t));
  return ordered.length === 1 ? `tier=${ordered[0]}` : `tier<=${ordered[ordered.length - 1]}`;
}

function accountCount(router: Router): number {
  const accounts = new Set<string>();
  for (const allowlist of Object.values(router.harnesses)) {
    for (const account of allowlist.accounts ?? []) accounts.add(`${account}`);
  }
  return accounts.size;
}

function renderRouterRow(router: Router): string {
  const harnessCount = Object.keys(router.harnesses).length;
  return `  ${chalk.cyan(router.name.padEnd(16))} ${harnessCount} harnesses . ${accountCount(router)} accounts . ${routerTierSummary(router)}`;
}

function printRouterDetail(router: Router): void {
  const header = router.task ? `router: ${router.name}     task type: ${router.task}` : `router: ${router.name}`;
  console.log(chalk.bold(header));
  const harnessNames = Object.keys(router.harnesses);
  if (harnessNames.length === 0) {
    console.log(chalk.gray('  (no harnesses allowed yet -- add one with `agents route allow <name> <harness> <model|tier>...`)'));
  }
  for (const name of harnessNames) {
    const allowlist = router.harnesses[name];
    console.log(
      `  ${chalk.cyan(name.padEnd(10))} models: [${allowlist.models.join(', ')}]     accounts: [${(allowlist.accounts ?? []).join(', ')}]`,
    );
  }
  if (router.weights) {
    const w = router.weights;
    const parts: string[] = [];
    if (w.cost != null) parts.push(`cost ${w.cost}`);
    if (w.success != null) parts.push(`success ${w.success}`);
    if (w.headroom != null) parts.push(`headroom ${w.headroom}`);
    console.log(`  ${chalk.gray('weights:')}  ${parts.join(' . ')}      hijack: ${router.hijack ? 'on' : 'off'}`);
  } else {
    console.log(`  ${chalk.gray('hijack:')} ${router.hijack ? 'on' : 'off'}`);
  }
}

export function registerRouteCommands(program: Command): void {
  const routeCmd = program
    .command('route')
    .alias('routes')
    .description('Named routers -- reusable, task-typed allowlists of harnesses x models/tiers x linked accounts.');

  setHelpSections(routeCmd, {
    examples: `
      # Create a router scoped to two harnesses, capped at a tier
      agents route add research --harness grok,kimi --tier cheap,default

      # Narrow one harness's model set
      agents route allow research kimi kimi-k2

      # Link accounts so routing under this router only ever picks them
      agents route link-account research grok personal
      agents route link-account research kimi work

      # Inspect, rename, remove it
      agents route view research
      agents route rename research deep-research
      agents route list --json
    `,
    notes: `
      A router is a generalization of a profile -- a profile is a router
      pinned to one harness and one account. It never resolves a target
      outside its declared harness/model/tier allowlist or linked accounts.

      Routers are a layered resource (project > user > system, like commands,
      skills, and profiles) but 'agents route add'/'allow'/'link-account'
      always write to the user layer (~/.agents/routers/<name>.yml).

      The older verb names still work as aliases: 'create' for 'add',
      'show' for 'view'.
    `,
  });

  routeCmd
    .command('add <name>')
    .alias('create')
    .description('Create a named router with an initial harness + tier allowlist.')
    .option('--harness <list>', 'Comma-separated harness ids to allow, e.g. grok,kimi')
    .option('--tier <list>', 'Comma-separated tier tokens applied to every listed harness, e.g. cheap,default')
    .option('--task <type>', 'Free-text task type this router serves, e.g. research')
    .action((name: string, opts: { harness?: string; tier?: string; task?: string }) => {
      if (routerExists(name)) {
        die(`Router '${name}' already exists. Use 'agents route allow ${name} <harness> <model|tier>...' to edit it.`);
      }
      if (!opts.harness) {
        die("Missing --harness. Example: agents route add research --harness grok,kimi --tier cheap,default");
      }
      const harnesses = opts.harness.split(',').map((h) => h.trim()).filter(Boolean);
      const tiers = (opts.tier ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const router: Router = {
        name,
        task: opts.task,
        harnesses: Object.fromEntries(harnesses.map((h) => [h, { models: [...tiers] }])),
      };
      try {
        validateRouter(router);
      } catch (err) {
        die((err as Error).message);
      }
      writeRouter(router);
      console.log(chalk.green(`+ created router "${name}"`) + chalk.gray(`   (${path.join(routersDir(), `${name}.yml`)})`));
    });

  withAliases(routeCmd
    .command('list'), 'list')
    .description('List every configured router.')
    .option('--json', 'Emit machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      const routers = listRouters();
      if (opts.json) {
        console.log(JSON.stringify(
          routers.map((r) => ({
            name: r.name,
            task: r.task ?? null,
            harnessCount: Object.keys(r.harnesses).length,
            accountCount: accountCount(r),
            tierSummary: routerTierSummary(r),
          })),
          null,
          2,
        ));
        return;
      }
      if (routers.length === 0) {
        console.log(chalk.gray('No routers configured.'));
        console.log(chalk.gray('Try: agents route add research --harness grok,kimi --tier cheap,default'));
        return;
      }
      for (const router of routers) console.log(renderRouterRow(router));
    });

  withAliases(routeCmd
    .command('view <name>'), 'view')
    .description("Show a router's harness/model/account allowlist, weights, and hijack flag.")
    .option('--json', 'Emit machine-readable JSON')
    .action((name: string, opts: { json?: boolean }) => {
      let router: Router;
      try {
        router = readRouter(name);
      } catch (err) {
        die((err as Error).message);
      }
      if (opts.json) {
        console.log(JSON.stringify(router!, null, 2));
        return;
      }
      printRouterDetail(router!);
    });

  routeCmd
    .command('allow <name> <harness> <models...>')
    .description("Set (replace) a harness's eligible model/tier allowlist under a router.")
    .action((name: string, harness: string, models: string[]) => {
      const router = requireEditableRouter(name);
      const existingAccounts = router.harnesses[harness]?.accounts;
      const next: Router = {
        ...router,
        harnesses: {
          ...router.harnesses,
          [harness]: { models, ...(existingAccounts ? { accounts: existingAccounts } : {}) },
        },
      };
      try {
        validateRouter(next);
      } catch (err) {
        die((err as Error).message);
      }
      writeRouter(next);
      console.log(chalk.green(`Router '${name}': ${harness} models -> [${models.join(', ')}]`));
    });

  routeCmd
    .command('link-account <name> <harness> <account>')
    .description('Link a durable credential account to a harness under a router.')
    .action((name: string, harness: string, account: string) => {
      if (!findAccount(account)) die(`Unknown account '${account}'.`);
      const router = requireEditableRouter(name);
      const allowlist = router.harnesses[harness];
      if (!allowlist) {
        die(`Harness '${harness}' is not part of router '${name}'. Add it first: agents route allow ${name} ${harness} <model|tier>...`);
      }
      allowlist!.accounts = allowlist!.accounts ?? [];
      if (!allowlist!.accounts.includes(account)) allowlist!.accounts.push(account);
      writeRouter(router);
      console.log(chalk.green(`Router '${name}': linked ${harness} account '${account}'`));
    });

  routeCmd
    .command('unlink-account <name> <harness> <account>')
    .description('Unlink a durable credential account from a harness under a router.')
    .action((name: string, harness: string, account: string) => {
      if (!findAccount(account)) die(`Unknown account '${account}'.`);
      const router = requireEditableRouter(name);
      const allowlist = router.harnesses[harness];
      if (!allowlist) {
        die(`Harness '${harness}' is not part of router '${name}'.`);
      }
      allowlist!.accounts = (allowlist!.accounts ?? []).filter((a) => a !== account);
      writeRouter(router);
      console.log(chalk.green(`Router '${name}': unlinked ${harness} account '${account}'`));
    });

  withAliases(routeCmd
    .command('rename <old-name> <new-name>'), 'rename')
    .description('Rename a router, preserving every field (allowlists, weights, accounts, hijack). Errors on a name collision.')
    .action((oldName: string, newName: string) => {
      try {
        renameRouter(oldName, newName);
        console.log(chalk.green(`Router '${oldName}' renamed to '${newName}'.`));
      } catch (err) {
        die((err as Error).message);
      }
    });

  withAliases(routeCmd
    .command('remove <name>'), 'remove')
    .description('Remove a router.')
    .action((name: string) => {
      const source = routerSource(name);
      if (source === null) die(`Router '${name}' not found.`);
      if (source !== 'user') {
        die(`Router '${name}' resolves from the '${source}' layer, not 'user' -- agents route remove can only remove a user-layer router.`);
      }
      const existed = deleteRouter(name);
      if (!existed) die(`Router '${name}' not found.`);
      console.log(chalk.green(`Router '${name}' removed.`));
    });
}
