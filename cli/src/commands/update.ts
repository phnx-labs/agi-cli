import type { Command } from 'commander';
import chalk from 'chalk';
import { AGENTS, formatAgentError, resolveAgentName } from '../lib/agents.js';
import { setHelpSections } from '../lib/help.js';
import {
  describeInstallation,
  listInstallations,
  planAutoUpdates,
  resolveInstallation,
  runAutoUpdatePass,
  selectUpdateStrategy,
  supportsPinnedUpdate,
  updateInstallation,
  type AutoUpdatePlanEntry,
  type Installation,
  type UpdateOutcome,
} from '../lib/installations/index.js';
import { resolveManagedInstallation } from '../lib/installations/index.js';
import { findUnifiedAccount } from '../lib/account-registry.js';
import { readMeta } from '../lib/state.js';
import type { AgentId } from '../lib/types.js';

interface UpdateOptions {
  to?: string;
  json?: boolean;
  check?: boolean;
  auto?: boolean;
}

/**
 * Split `<agent>[@<selector>]`. The selector names an INSTALLATION — its frozen
 * label, or the release it currently carries — never a release to install; that
 * is `--to`. Keeping them separate is what lets `agents update claude@2.0.65
 * --to 2.0.71` read unambiguously.
 */
/**
 * `<agent>[@<installed-version>][#<account>]`. The `#<account>` form is the
 * same selector `agents run claude#work` takes: accounts run on the harness's
 * one managed installation (PHNX-3940), so it names WHICH login the user means
 * and resolves to that installation. Refusing it as "Unknown agent
 * 'claude#work'" sent operators hunting for a per-account install that does
 * not exist.
 */
export function parseTarget(raw: string): { agent: AgentId; selector?: string; account?: string } {
  const hash = raw.indexOf('#');
  const spec = hash === -1 ? raw : raw.slice(0, hash);
  const account = hash === -1 ? undefined : raw.slice(hash + 1).trim();
  if (hash !== -1 && !account) {
    throw new Error(`Select an account after # in '${raw}', e.g. claude#work — or just <agent>.`);
  }
  if (account?.includes('@')) {
    throw new Error(`Put the installation before the account: <agent>@<installed-version>#<account>, not '${raw}'.`);
  }
  const at = spec.indexOf('@');
  const name = at === -1 ? spec : spec.slice(0, at);
  const selector = at === -1 ? undefined : spec.slice(at + 1).trim();
  if (at !== -1 && !selector) {
    throw new Error(`Missing installation in '${raw}'. Use <agent>@<installed-version>, or just <agent>.`);
  }
  const agent = resolveAgentName(name);
  if (!agent) throw new Error(formatAgentError(name));
  if (account) {
    const known = findUnifiedAccount(account, readMeta(), undefined, agent);
    if (!known) {
      throw new Error(`Unknown ${AGENTS[agent].name} account '${account}'. See: agents accounts list ${agent}`);
    }
  }
  return { agent, selector, account };
}

/**
 * One line naming the installations a bare `agents update <agent>` did NOT
 * touch — isolated (`--isolated`) copies and legacy pre-v2 per-version homes —
 * or `null` when the managed install is the only one. Bare `<agent>` moves only
 * the single managed install, so leaving these silent would let a user believe
 * every copy is current (PHNX-3940). Pure over the installation store so the
 * naming logic is unit-testable without running a real update.
 */
export function describeSkippedInstallations(agent: AgentId, managedId: string): string | null {
  const skipped = listInstallations(agent).filter((i) => i.id !== managedId);
  if (skipped.length === 0) return null;
  const names = skipped.map((i) => `${agent}@${describeInstallation(i)}`).join(', ');
  return `Left ${skipped.length} other ${AGENTS[agent].name} installation${skipped.length === 1 ? '' : 's'} unchanged `
    + `(${names}). Update one with: agents update ${agent}@<label>.`;
}

function serialize(installation: Installation) {
  return {
    id: installation.id,
    agent: installation.agent,
    label: installation.label,
    releaseVersion: installation.releaseVersion,
    createdAt: installation.createdAt,
    updatedAt: installation.updatedAt,
  };
}

function printOutcome(outcome: UpdateOutcome, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({
      installation: serialize(outcome.installation),
      strategy: outcome.strategy,
      fromRelease: outcome.fromRelease,
      toRelease: outcome.toRelease,
      unchanged: outcome.unchanged,
      deferred: outcome.deferred,
      alsoUpdated: outcome.alsoUpdated.map(serialize),
    }, null, 2));
    return;
  }
  const name = `${outcome.installation.agent}@${outcome.installation.label}`;
  if (outcome.deferred) {
    console.log(chalk.yellow(`${name}: ${outcome.deferred} Still on release ${outcome.installation.releaseVersion}.`));
    return;
  }
  if (outcome.unchanged) {
    console.log(chalk.gray(`${name} is already on release ${outcome.toRelease}.`));
    return;
  }
  console.log(chalk.green(`Updated ${name}: release ${outcome.fromRelease} -> ${outcome.toRelease}`));
  console.log(chalk.gray(`Its name is unchanged, so every default, project pin, and routine that names ${name} still resolves to it.`));
  for (const other of outcome.alsoUpdated) {
    console.log(chalk.gray(`  ${other.agent}@${other.label} shares the same binary and now also reports release ${other.releaseVersion}.`));
  }
}

function printInstallations(agent: AgentId, json: boolean): void {
  const installations = listInstallations(agent);
  if (json) {
    console.log(JSON.stringify(installations.map(serialize), null, 2));
    return;
  }
  if (!installations.length) {
    console.log(chalk.gray(`No managed ${agent} installations. Install one with: agents add ${agent}`));
    return;
  }
  console.log(chalk.bold(`${agent} installations\n`));
  for (const installation of installations) {
    console.log(`  ${chalk.cyan(installation.label)}  release ${installation.releaseVersion}  ${chalk.gray(installation.id)}`);
  }
}

/**
 * Surface a failure as one red line, not a stack trace. Everything this command
 * can fail on — an unknown agent, an ambiguous selector, an unpinnable harness,
 * a release that would not launch — is a message the user acts on, and a
 * commander async action rejection otherwise reaches the user as a raw Node dump.
 */
function fail(err: unknown): void {
  console.error(chalk.red((err as Error).message));
  process.exitCode = 1;
}

function serializePlanEntry(entry: AutoUpdatePlanEntry) {
  const wouldUpdate = entry.eligible && !entry.deferred
    && !!entry.targetRelease && entry.targetRelease !== entry.currentRelease;
  return {
    agent: entry.agent,
    label: entry.installation.label,
    currentRelease: entry.currentRelease,
    targetRelease: entry.targetRelease,
    policy: entry.policy,
    eligible: entry.eligible,
    deferred: entry.deferred,
    wouldUpdate,
    reason: entry.reason,
  };
}

/** `--check`'s dry-run output: eligibility/current/target/policy/deferral, machine-readable with `--json`. */
function printPlan(plan: AutoUpdatePlanEntry[], json: boolean): void {
  const rows = plan.map(serializePlanEntry);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(chalk.gray('No managed installations to check.'));
    return;
  }
  console.log(chalk.bold('Automatic-update plan\n'));
  for (const row of rows) {
    const name = `${row.agent}@${row.label}`;
    const status = row.wouldUpdate
      ? chalk.green(`would update ${row.currentRelease} -> ${row.targetRelease}`)
      : row.deferred
        ? chalk.yellow(`deferred — ${row.reason}`)
        : !row.eligible
          ? chalk.gray(`not eligible — ${row.reason}`)
          : chalk.gray('already current');
    console.log(`  ${chalk.cyan(name.padEnd(28))} policy=${row.policy.padEnd(7)} ${status}`);
  }
}

/**
 * `--to` also decides the installation's update policy going forward: a
 * concrete release is a manual pin (excluded from the automatic pass until
 * explicitly unpinned), `latest` (the default) unpins it. Returns `null` when
 * `--to` was not passed at all, meaning: don't touch the stored policy.
 */
function policyForTo(to: string | undefined): 'latest' | 'pinned' | null {
  if (to === undefined) return null;
  return to === 'latest' ? 'latest' : 'pinned';
}

async function updateOne(
  agent: AgentId,
  installation: Installation,
  options: UpdateOptions,
): Promise<UpdateOutcome> {
  const strategy = selectUpdateStrategy(agent);
  if (!options.json && !strategy.transactional) {
    console.log(chalk.yellow(
      `${agent} installs one vendor-managed binary, so this update cannot be staged or rolled back; `
      + `a failure leaves whatever its installer wrote.`
    ));
  }
  if (!options.json) {
    console.log(chalk.gray(`Updating ${agent}@${describeInstallation(installation)} via the ${strategy.id} strategy...`));
  }
  const outcome = await updateInstallation(installation, {
    to: options.to,
    updatePolicy: policyForTo(options.to) ?? undefined,
    onProgress: options.json ? undefined : (message) => console.log(chalk.gray(`  ${message}`)),
  });
  return outcome;
}

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command('update [target]')
    .description('Move a frozen agent installation to a new release, keeping its name and every reference to it')
    .option('--to <release>', 'Release to move to: latest (default, and unpins), oldest, or an exact version (pins)')
    .option('--json', 'Machine-readable result')
    .option('--check', 'Dry run: report eligibility/current/target/policy/deferral without changing anything')
    .option('--auto', 'Run the same automatic-update pass the daemon runs, across every managed harness (ignores <target>)')
    .action(async (target: string | undefined, options: UpdateOptions) => {
      try {
        if (options.auto || (options.check && !target)) {
          if (options.check) {
            printPlan(await planAutoUpdates(), !!options.json);
            return;
          }
          const result = await runAutoUpdatePass({
            onProgress: options.json ? undefined : (message) => console.log(chalk.gray(`  ${message}`)),
          });
          if (options.json) {
            console.log(JSON.stringify({
              plan: result.plan.map(serializePlanEntry),
              outcomes: result.outcomes.map((o) => ({
                agent: o.entry.agent,
                label: o.entry.installation.label,
                outcome: o.outcome && {
                  fromRelease: o.outcome.fromRelease,
                  toRelease: o.outcome.toRelease,
                  unchanged: o.outcome.unchanged,
                  deferred: o.outcome.deferred,
                },
                error: o.error,
              })),
            }, null, 2));
          } else if (result.outcomes.length === 0) {
            console.log(chalk.gray('Nothing eligible to update this pass.'));
          } else {
            for (const o of result.outcomes) {
              const name = `${o.entry.agent}@${o.entry.installation.label}`;
              if (o.error) console.error(chalk.red(`${name}: ${o.error}`));
              else if (o.outcome) printOutcome(o.outcome, false);
            }
          }
          if (result.outcomes.some((o) => o.error)) process.exitCode = 1;
          return;
        }

        if (!target) {
          throw new Error('Which agent? Use: agents update <agent>[@<installed-version>], or agents update --auto.');
        }
        const { agent, selector, account } = parseTarget(target);
        if (account && !options.json) {
          console.log(chalk.gray(`  account '${account}' runs on the managed ${AGENTS[agent].name} installation; updating that.`));
        }

        if (options.check) {
          const plan = (await planAutoUpdates({ agents: [agent] })).filter(
            (entry) => !selector || entry.installation.label === selector || entry.installation.releaseVersion === selector,
          );
          if (selector && plan.length === 0) {
            throw new Error(`No ${AGENTS[agent].name} installation matches '${selector}'.`);
          }
          printPlan(plan, !!options.json);
          return;
        }

        if (options.to && options.to !== 'latest' && !supportsPinnedUpdate(agent)) {
          // Fail loud at the boundary rather than installing the current release
          // and reporting it as the pin that was asked for.
          throw new Error(
            `${agent} is a single self-updating binary with no pinnable releases — drop --to, or pass --to latest.`
          );
        }

        if (selector) {
          const installation = await resolveInstallation(agent, selector);
          const outcome = await updateOne(agent, installation, options);
          printOutcome(outcome, !!options.json);
          return;
        }

        // Bare `<agent>`, no `@label`: update the harness's ONE managed
        // installation (PHNX-3940). The `@<label>` selector above remains for
        // legacy multi-install layouts and isolated copies; the automatic pass
        // (`--auto`, the daemon) still sweeps every installation by policy.
        const managed = resolveManagedInstallation(agent);
        if (!managed) {
          throw new Error(`No managed ${AGENTS[agent].name} installation. Install one with: agents add ${agent}`);
        }
        const outcome = await updateOne(agent, managed, options);
        printOutcome(outcome, !!options.json);
        if (!options.json) {
          const skippedLine = describeSkippedInstallations(agent, managed.id);
          if (skippedLine) console.log(chalk.gray(skippedLine));
        }
      } catch (err) {
        fail(err);
      }
    });

  update
    .command('list <agent>')
    .description('Show every frozen installation of an agent and the release each carries')
    .option('--json', 'Machine-readable listing')
    // `--json` is declared on both `update` and `update list`, and commander
    // binds a flag the parent also declares to the PARENT's option store — so
    // reading this subcommand's own opts alone silently drops it. Merge them.
    .action((rawAgent: string, _options: { json?: boolean }, command: Command) => {
      try {
        const agent = resolveAgentName(rawAgent);
        if (!agent) throw new Error(formatAgentError(rawAgent));
        printInstallations(agent, !!command.optsWithGlobals().json);
      } catch (err) {
        fail(err);
      }
    });

  setHelpSections(update, {
    examples: `agents update claude
agents update claude --to 2.1.220
agents update claude --to latest
agents update list claude
agents update --check
agents update claude --check --json
agents update --auto`,
    notes:
      'One managed installation per harness: a bare `<agent>` updates that installation, keeping its name and every '
      + 'reference to it. That is why a default, a project pin, a routine version, or a profile that names claude@main '
      + 'keeps working after you update it. '
      + '`--to <release>` pins the installation to a concrete release (excluded from the automatic pass), `--to latest` '
      + 'unpins it. The legacy `agents update <agent>@<label>` selector still addresses a specific installation by its '
      + 'name or the release it currently carries, for pre-v2 layouts with several installations. '
      + 'The new release is fetched and launched before it replaces the working one, so a bad release leaves your agent running. '
      + 'Pinned and manual/vendor-managed installations are also skipped '
      + 'by the automatic background pass (agents config set updates.auto / updates.<agent>.auto). `--check` reports what '
      + '`--auto` would do without changing anything; `--auto` (no target) runs the exact pass the daemon runs, across every '
      + 'harness.',
  });
}
