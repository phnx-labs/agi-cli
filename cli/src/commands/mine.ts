/** `agents mine` helpers: `agents setup mine init <name>` mints a personally-named pass-through
 * binary that IS agents-cli, applying the brand's disabled commands and resource profile. Config
 * lives in `meta.brands`; each brand owns a preset `mine-<name>` (lib/brand.ts). */
import type { Command } from 'commander';
import chalk from 'chalk';

import {
  validateBrandName,
  listBrands,
  getBrandConfig,
  upsertBrand,
  removeBrand,
  brandPresetName,
} from '../lib/brand.js';
import { createBrandShim, removeBrandShim, isShimsInPath } from '../lib/installations/shims.js';
import { updateMeta } from '../lib/state.js';
import { KNOWN_TOP_LEVEL_COMMANDS } from '../lib/startup/command-registry.js';
import type { BrandConfig, ResourceProfilePreset } from '../lib/types.js';

type ToggleKind = 'plugins' | 'skills' | 'commands' | 'mcp' | 'hooks' | 'subagents';

function knownCommandNames(): Set<string> {
  const names = new Set<string>(KNOWN_TOP_LEVEL_COMMANDS);
  for (const n of ['perms', 'exec', 'jobs', 'cron', 'upgrade']) names.add(n);
  return names;
}

/** Add/remove a `!name` exclusion on a preset's pattern list for one kind, keeping `*`; delete the
 * key once only `*` remains so a clean brand has an empty preset. */
function applyResourceToggle(
  preset: ResourceProfilePreset,
  kind: ToggleKind,
  name: string,
  enable: boolean,
): void {
  const bag = preset as unknown as Record<string, string[] | undefined>;
  const arr = [...(bag[kind] ?? [])];
  if (arr.length === 0) arr.push('*');
  const excl = `!${name}`;
  const idx = arr.indexOf(excl);
  if (enable) {
    if (idx !== -1) arr.splice(idx, 1);
  } else if (idx === -1) {
    arr.push(excl);
  }
  const onlyStar = arr.length === 1 && arr[0] === '*';
  if (onlyStar) delete bag[kind];
  else bag[kind] = arr;
}

function ensurePresetExists(name: string): void {
  const presetName = brandPresetName(name);
  updateMeta((meta) => {
    const profiles = meta.profiles ?? {};
    const presets = { ...(profiles.presets ?? {}) };
    if (!presets[presetName]) {
      presets[presetName] = { description: `Resource set for the "${name}" brand` };
    }
    return { ...meta, profiles: { ...profiles, presets } };
  });
}

function editPreset(name: string, fn: (preset: ResourceProfilePreset) => void): void {
  const presetName = brandPresetName(name);
  updateMeta((meta) => {
    const profiles = meta.profiles ?? {};
    const presets = { ...(profiles.presets ?? {}) };
    const preset: ResourceProfilePreset = { ...(presets[presetName] ?? {}) };
    fn(preset);
    presets[presetName] = preset;
    return { ...meta, profiles: { ...profiles, presets } };
  });
}

/** Create or re-mint a brand, shared by `setup mine init` and the wizard: writes the shim, the
 * brand config, and an empty resource preset. */
export function initBrand(
  name: string,
  opts: { disabledCommands?: string[]; force?: boolean } = {},
): { pathWarning: boolean } {
  const err = validateBrandName(name);
  if (err) {
    console.error(chalk.red(err));
    process.exit(1);
  }
  if (getBrandConfig(name) && !opts.force) {
    console.error(chalk.red(`Brand "${name}" already exists. Use --force to re-mint, or 'agents setup mine toggle ${name}'.`));
    process.exit(1);
  }

  ensurePresetExists(name);

  const disabled = (opts.disabledCommands ?? []).filter((c) => c.length > 0);
  const known = knownCommandNames();
  for (const c of disabled) {
    if (!known.has(c)) console.error(chalk.yellow(`  note: "${c}" is not a known command — kept anyway.`));
  }

  const cfg: BrandConfig = {
    name,
    enabled: true,
    profile: brandPresetName(name),
    ...(disabled.length > 0 ? { disabledCommands: disabled } : {}),
  };
  upsertBrand(cfg);
  createBrandShim(name);

  const pathWarning = !isShimsInPath();
  return { pathWarning };
}

function printMinted(name: string, pathWarning: boolean): void {
  console.log(`${chalk.green('Minted')} ${chalk.bold(name)} — your own agents CLI.`);
  console.log(chalk.dim(`  try:  ${name} --help    ${name} run claude "hello"`));
  if (pathWarning) {
    console.log(
      chalk.yellow(`  note: the shims dir isn't on your PATH yet — run 'agents setup' or open a new shell.`),
    );
  }
}

/** Register the brand manage verbs (`init`/`list`/`toggle`/`remove`) under a parent Command, used
 * by `agents setup mine`. */
export function registerMineManageCommands(cmd: Command): void {
  cmd
    .command('init <name>')
    .description('Mint your own branded CLI that runs every agents verb under <name>')
    .option('--disable <commands...>', 'Built-in commands to hide from this brand (e.g. teams cloud)')
    .option('--force', 'Re-mint even if the brand already exists')
    .action((name: string, options: { disable?: string[]; force?: boolean }) => {
      const { pathWarning } = initBrand(name, {
        disabledCommands: options.disable,
        force: options.force,
      });
      printMinted(name, pathWarning);
    });

  cmd
    .command('list')
    .alias('ls')
    .description('Show your brands and what each has turned off')
    .action(() => {
      const brands = listBrands();
      const entries = Object.entries(brands);
      if (entries.length === 0) {
        console.log(chalk.gray("No brands yet. Try: agents setup mine   (or: agents setup mine init jack)"));
        return;
      }
      const width = entries.reduce((m, [n]) => Math.max(m, n.length), 0);
      for (const [name, cfg] of entries) {
        const off = cfg.disabledCommands?.length ? `disabled: ${cfg.disabledCommands.join(', ')}` : 'all commands on';
        const state = cfg.enabled === false ? chalk.yellow('(disabled) ') : '';
        console.log(`  ${chalk.bold(name.padEnd(width))}  ${state}${chalk.dim(off)}`);
      }
    });

  cmd
    .command('toggle <name>')
    .description('Enable/disable features for a brand')
    .option('--disable <commands...>', 'Hide these built-in commands')
    .option('--enable <commands...>', 'Un-hide these built-in commands')
    .option('--disable-plugin <names...>', 'Disable these plugins for the brand')
    .option('--enable-plugin <names...>', 'Re-enable these plugins')
    .option('--disable-skill <names...>', 'Disable these skills for the brand')
    .option('--enable-skill <names...>', 'Re-enable these skills')
    .action((name: string, options: {
      disable?: string[]; enable?: string[];
      disablePlugin?: string[]; enablePlugin?: string[];
      disableSkill?: string[]; enableSkill?: string[];
    }) => {
      const cfg = getBrandConfig(name);
      if (!cfg) {
        console.error(chalk.red(`No brand named "${name}". Create it with 'agents setup mine init ${name}'.`));
        process.exit(1);
      }

      const disabledSet = new Set(cfg.disabledCommands ?? []);
      const known = knownCommandNames();
      for (const c of options.disable ?? []) {
        if (!known.has(c)) console.error(chalk.yellow(`  note: "${c}" is not a known command — kept anyway.`));
        disabledSet.add(c);
      }
      for (const c of options.enable ?? []) disabledSet.delete(c);
      const nextDisabled = [...disabledSet];
      const nextCfg: BrandConfig = { ...cfg };
      if (nextDisabled.length > 0) nextCfg.disabledCommands = nextDisabled;
      else delete nextCfg.disabledCommands;
      upsertBrand(nextCfg);

      const resourceOps: Array<[ToggleKind, string, boolean]> = [];
      for (const p of options.disablePlugin ?? []) resourceOps.push(['plugins', p, false]);
      for (const p of options.enablePlugin ?? []) resourceOps.push(['plugins', p, true]);
      for (const s of options.disableSkill ?? []) resourceOps.push(['skills', s, false]);
      for (const s of options.enableSkill ?? []) resourceOps.push(['skills', s, true]);
      if (resourceOps.length > 0) {
        ensurePresetExists(name);
        editPreset(name, (preset) => {
          for (const [kind, n, enable] of resourceOps) applyResourceToggle(preset, kind, n, enable);
        });
      }

      console.log(`${chalk.green('Updated')} ${chalk.bold(name)}.`);
      const finalCfg = getBrandConfig(name)!;
      const off = finalCfg.disabledCommands?.length ? finalCfg.disabledCommands.join(', ') : '(none)';
      console.log(chalk.dim(`  disabled commands: ${off}`));
    });

  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a brand (its shim + config)')
    .option('--purge', "Also delete the brand's resource profile preset")
    .action((name: string, options: { purge?: boolean }) => {
      const existed = getBrandConfig(name) !== undefined;
      const shimRemoved = removeBrandShim(name);
      if (!existed && !shimRemoved) {
        console.error(chalk.red(`No brand named "${name}".`));
        process.exit(1);
      }
      removeBrand(name, options.purge === true);
      console.log(`${chalk.yellow('Removed')} brand ${chalk.bold(name)}`);
    });
}
