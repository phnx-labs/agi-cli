
import type { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs';
import { homeDir } from '../lib/platform/index.js';
import {
  AGENTS,
  resolveAgentName,
  formatAgentError,
  agentLabel,
} from '../lib/agents.js';
import type { AgentId } from '../lib/types.js';
import { listInstalledVersions, getGlobalDefault, resolveVersion, resolveVersionAlias } from '../lib/installations/versions.js';
import { getModelCatalog, locateModelSource } from '../lib/models.js';
import { resolveTierMap, MODEL_TIERS } from '../lib/model-tiers.js';
import { setTierOverride, clearTierOverride, listTierOverrides } from '../lib/model-tier-overrides.js';
import { getModelPricing } from '../lib/pricing/index.js';
import { terminalWidth, truncateToWidth, stringWidth } from '../lib/session/width.js';
import { wrapJoined } from './inspect.js';
import { setHelpSections } from '../lib/help.js';
import {
  formatRunDefaultEntry,
  listRunDefaults,
  parseRunDefaultSelector,
  setRunDefault,
} from '../lib/run-defaults.js';

interface SetDefaultOptions {
  mode?: string;
  model?: string;
}

const MODEL_CAPABLE_AGENTS: AgentId[] = ['claude', 'codex', 'opencode', 'cursor', 'openclaw', 'antigravity', 'kimi', 'grok', 'droid'];

const PATH_ONLY_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>(['cursor']);

function fallbackPathVersion(agent: AgentId): string | null {
  const src = locateModelSource(agent, 'unresolved');
  if (!src) return null;
  let real = src.path;
  try {
    real = fs.realpathSync(src.path);
  } catch {
  }
  const m = real.match(/\/versions\/([^/]+)\//);
  return m ? m[1] : 'installed';
}

export function registerModelsCommand(program: Command): void {
  const models = program
    .command('models [agentSpec]')
    .description('Show the cost-tier map (cheap|default|best|ultra) for installed harnesses; pin overrides with `tier set`.')
    .option('--all', 'Show the full raw model catalog, not just the tier map')
    .option('--cloud', 'Show per-cloud IDs (Claude only; implies --all)')
    .option('--reasoning', 'Show reasoning levels per model (Codex only; implies --all)')
    .option('--json', 'Output catalog + tiers as JSON')
    .action(async (agentSpec: string | undefined, options: PrintOptions & { json?: boolean }) => {
      const targets = await resolveTargets(agentSpec);
      if (targets.length === 0) process.exit(1);

      if (options.json) {
        const out = targets.map(({ agent, version }) => ({
          agent,
          version,
          catalog: getModelCatalog(agent, version),
          tiers: resolveTierMap(agent, version),
        }));
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      const all = options.all || options.cloud || options.reasoning;
      let printed = 0;
      for (const { agent, version, isDefault } of targets) {
        if (printed > 0) console.log();
        printCatalog(agent, version, isDefault, { ...options, all });
        printed++;
      }
      if (!agentSpec && !all) {
        console.log(chalk.gray('\n  `agents models <agent>` for one harness · `--all` for the full model list'));
        console.log(chalk.gray('  `agents models tier set <agent> <tier> <model>` to override a tier'));
        console.log(chalk.gray('  Permission modes (--mode plan|edit|auto|skip): `agents modes <agent>`'));
      }
    });

  const set = models
    .command('set [selector]')
    .description('Set the default model/mode an agent version uses for `agents run`')
    .option('--model <model>', 'Default model or model alias, forwarded via --model')
    .option('--mode <mode>', "Default mode: plan, edit, auto, skip. 'full' accepted as alias for skip.")
    .action((selector: string | undefined, options: SetDefaultOptions) => {
      try {
        const hasFlags = options.model !== undefined || options.mode !== undefined;

        if (!selector) {
          if (hasFlags) {
            throw new Error('Selector is required when passing --model/--mode. Example: agents models set claude@2.1.220 --model opus-5');
          }
          const entries = listRunDefaults();
          if (entries.length === 0) {
            console.log(chalk.gray('No agent defaults configured.'));
            console.log(chalk.gray('Set one with: agents models set claude@2.1.220 --model opus-5'));
            return;
          }
          console.log(chalk.bold('Agent Defaults\n'));
          for (const entry of entries) {
            console.log(`  ${formatRunDefaultEntry(entry)}`);
          }
          return;
        }

        if (!hasFlags) {
          const parsed = parseRunDefaultSelector(selector);
          const entry = listRunDefaults().find((e) => e.selector === parsed.selector);
          if (!entry || (!entry.defaults.mode && !entry.defaults.model)) {
            console.log(chalk.gray(`No default set for ${parsed.selector}.`));
            console.log(chalk.gray(`Set one with: agents models set ${selector} --model <model>`));
            return;
          }
          console.log(`  ${formatRunDefaultEntry(entry)}`);
          return;
        }

        const entry = setRunDefault(selector, {
          ...(options.mode !== undefined ? { mode: options.mode } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
        });
        console.log(chalk.green('Set default:'));
        console.log(`  ${formatRunDefaultEntry(entry)}`);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  setHelpSections(set, {
    examples: `
      agents models set claude@2.1.220 --model opus-5
      agents models set 'claude:*' --mode auto --model opus
      agents models set claude@2.1.220
      agents models set
    `,
    notes: `
      Selectors use <agent>@<version> or <agent>:<version>; * matches all versions.
      Exact selectors override wildcard selectors field by field.
      Writes the same store as 'agents config set run.<agent@version>.*'. Explicit flags on
      'agents run' always win over configured defaults.
    `,
  });

  const tierDeprecation = chalk.yellow(
    'Deprecation: `agents models tier` is replaced by `agents config set run.<agent@version>.tier.<tier>`.',
  );
  const tier = models
    .command('tier')
    .description('Override which model a cost tier resolves to (per harness, or per agent@version).');

  tier
    .command('set <selector> <tier> <model>')
    .description('Pin a tier to a model. selector: <agent> or <agent>@<version> (e.g. kimi, kimi@0.19.2).')
    .action((selector: string, tierName: string, model: string) => {
      try {
        console.warn(tierDeprecation);
        const entry = setTierOverride(selector, tierName, model);
        console.log(chalk.green(`✓ ${entry.selector}  ${chalk.cyan(tierName.toLowerCase())} → ${chalk.bold(model)}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  tier
    .command('clear <selector> [tier]')
    .description('Clear one tier (or all tiers) back to the auto guess.')
    .action((selector: string, tierName: string | undefined) => {
      try {
        console.warn(tierDeprecation);
        const changed = clearTierOverride(selector, tierName);
        console.log(changed ? chalk.green(`✓ cleared ${selector}${tierName ? ` ${tierName}` : ''}`) : chalk.gray('nothing to clear'));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });

  tier
    .command('list')
    .description('List all configured tier overrides.')
    .action(() => {
      console.warn(tierDeprecation);
      const entries = listTierOverrides();
      if (entries.length === 0) {
        console.log(chalk.gray('No tier overrides — every tier uses the auto guess. Set one with `agents models tier set`.'));
        return;
      }
      for (const e of entries) {
        const parts = Object.entries(e.tiers).map(([t, m]) => `${chalk.cyan(t)}=${m}`);
        console.log(`${chalk.bold(e.selector.padEnd(18))} ${parts.join('  ')}`);
      }
    });
}

interface PrintOptions {
  all?: boolean;
  cloud?: boolean;
  reasoning?: boolean;
}

interface Target {
  agent: AgentId;
  version: string;
  isDefault: boolean;
}

async function resolveTargets(agentSpec: string | undefined): Promise<Target[]> {
  if (!agentSpec) {
    const targets: Target[] = [];
    for (const agent of MODEL_CAPABLE_AGENTS) {
      let version: string | null = getGlobalDefault(agent) || (listInstalledVersions(agent)[0] ?? null);
      if (!version && PATH_ONLY_AGENTS.has(agent)) {
        version = fallbackPathVersion(agent);
      }
      if (version) {
        targets.push({ agent, version, isDefault: true });
      } else {
        console.error(chalk.gray(`${agentLabel(agent)}: not installed (run 'agents add ${agent}@latest')`));
      }
    }
    if (targets.length === 0) {
      console.error(chalk.yellow('No installed agent versions found. Run `agents add claude@latest` to install one.'));
    }
    return targets;
  }

  const [agentName, versionSpec] = agentSpec.split('@');
  const agent = resolveAgentName(agentName);
  if (!agent) {
    console.error(chalk.red(formatAgentError(agentName, MODEL_CAPABLE_AGENTS)));
    return [];
  }
  if (!MODEL_CAPABLE_AGENTS.includes(agent)) {
    console.error(chalk.yellow(`Model catalog extraction is only supported for: ${MODEL_CAPABLE_AGENTS.join(', ')}`));
    console.error(chalk.gray(`Other agents pass --model through without validation.`));
    return [];
  }

  if (versionSpec === 'all') {
    return listInstalledVersions(agent).map((v) => ({
      agent,
      version: v,
      isDefault: v === getGlobalDefault(agent),
    }));
  }

  const aliasedVersion = resolveVersionAlias(agent, versionSpec);
  let version: string | null = aliasedVersion || resolveVersion(agent, process.cwd()) || getGlobalDefault(agent);
  if (!version && PATH_ONLY_AGENTS.has(agent)) {
    version = fallbackPathVersion(agent);
  }
  if (!version) {
    console.error(chalk.red(`No version of ${agent} is installed. Try \`agents add ${agent}@latest\`.`));
    return [];
  }
  return [{ agent, version, isDefault: version === getGlobalDefault(agent) }];
}

function printCatalog(agent: AgentId, version: string, isDefault: boolean, options: PrintOptions): void {
  const tag = isDefault ? chalk.gray(' (default)') : '';
  const header = `${agentLabel(agent)} ${chalk.bold(version)}${tag}`;
  console.log(header);

  printTiers(agent, version);

  const src = locateModelSource(agent, version);
  if (!src) {
    if (agent === 'droid') {
      console.log(chalk.gray('  (Droid has no model list command; tiers are a curated, credit-multiplier map.)'));
      return;
    }
    console.log(chalk.yellow(`  Could not locate model source for ${agent}@${version}.`));
        console.log(chalk.gray(`  Expected the agent's CLI bundle or native binary under ~/.agents/.history/versions/${agent}/${version}/.`));
    return;
  }

  const catalog = getModelCatalog(agent, version);
  if (!catalog || catalog.models.length === 0) {
    console.log(chalk.yellow(`  No models extracted from ${src.kind} at ${src.path}.`));
    return;
  }

  if (!options.all) {
    console.log(chalk.gray(`  ${catalog.models.length} models · \`agents models ${agent} --all\` for the full list`));
    return;
  }

  console.log(chalk.gray(formatModelSourceLine(src.kind, shortPath(src.path))));

  if (Object.keys(catalog.aliases).length > 0) {
    const parts = Object.entries(catalog.aliases).map(([alias, id]) => `${chalk.cyan(alias)}=${id}`);
    for (const line of formatModelAliasLines(parts)) console.log(line);
  }

  console.log();

  for (const model of catalog.models) {
    const star = model.isDefault ? chalk.green('*') : ' ';
    console.log(formatModelSummaryLine(star, model.id, model.displayName, model.alias));

    if (model.description) {
      const descPrefix = '      ';
      console.log(chalk.gray(descPrefix + truncateToWidth(model.description, Math.max(1, terminalWidth() - stringWidth(descPrefix)))));
    }

    if (options.cloud && model.perCloud) {
      const c = model.perCloud;
      const fields: string[] = [];
      if (c.bedrock) fields.push(`bedrock=${c.bedrock}`);
      if (c.vertex) fields.push(`vertex=${c.vertex}`);
      if (c.foundry) fields.push(`foundry=${c.foundry}`);
      if (c.anthropicAws && c.anthropicAws !== c.firstParty) fields.push(`anthropicAws=${c.anthropicAws}`);
      if (c.mantle) fields.push(`mantle=${c.mantle}`);
      if (fields.length > 0) {
        for (const f of fields) console.log(chalk.gray(`      ${f}`));
      }
    }

    if (options.reasoning && model.reasoningLevels && model.reasoningLevels.length > 0) {
      const levels = model.reasoningLevels.map((l) =>
        l.effort === model.defaultReasoningLevel ? chalk.cyan(`${l.effort}*`) : l.effort
      );
      console.log(chalk.gray(`      reasoning: `) + levels.join(', '));
    }
  }
}

function priceLabel(id: string): string {
  const p = getModelPricing(id);
  if (!p) return chalk.gray('  --');
  const perM = (p.inputPerToken + p.outputPerToken) * 1e6;
  return chalk.gray(`  ~$${perM.toFixed(0)}/Mtok`);
}

function printTiers(agent: AgentId, version: string): void {
  const map = resolveTierMap(agent, version);
  if (!MODEL_TIERS.some((t) => map[t].model)) return;
  console.log(chalk.gray('  tiers:'));
  for (const t of MODEL_TIERS) {
    const r = map[t];
    if (!r.model) continue;
    const eff = r.effort ? chalk.gray(` @${r.effort}`) : '';
    const clamp = r.clampedFrom ? chalk.gray(' (clamped)') : '';
    const over = r.source === 'override' ? chalk.yellow(' [override]') : '';
    console.log(`    ${chalk.cyan(t.padEnd(8))} ${chalk.bold(r.model)}${eff}${priceLabel(r.model)}${clamp}${over}`);
  }
  console.log();
}

function shortPath(p: string): string {
  return p.replace(homeDir(), '~');
}

export function formatModelSourceLine(kind: string, sourcePath: string, width = terminalWidth()): string {
  const prefix = `  source: ${kind} (`;
  const suffix = ')';
  const room = Math.max(1, width - stringWidth(prefix) - stringWidth(suffix));
  return prefix + truncateToWidth(sourcePath, room) + suffix;
}

export function formatModelAliasLines(parts: string[], width = terminalWidth()): string[] {
  return wrapJoined(chalk.gray('  aliases: '), parts, ', ', width);
}

export function formatModelSummaryLine(
  star: string,
  id: string,
  displayName?: string,
  alias?: string,
  width = terminalWidth(),
): string {
  const display = displayName && displayName !== id ? ` (${displayName})` : '';
  const aliasTag = alias ? ` [${alias}]` : '';
  const prefix = `  ${star} `;
  const plain = `${id}${display}${aliasTag}`;
  if (stringWidth(plain) > Math.max(1, width - stringWidth(prefix))) {
    return prefix + truncateToWidth(plain, Math.max(1, width - stringWidth(prefix)));
  }
  return prefix + chalk.bold(id) + chalk.gray(display) + chalk.cyan(aliasTag);
}
