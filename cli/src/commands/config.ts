/**
 * Unified configuration command barrel.
 *
 * `agents config` consolidates the fragmented config surface into one namespace:
 *   - run defaults (model, mode, effort)
 *   - tier overrides (folded into the run namespace)
 *   - interactive host
 *   - browser profile
 *   - local projects root
 *   - per-device config keys
 *
 * The underlying YAML schema is unchanged; this command translates the new key
 * grammar into reads/writes of the existing stores.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import type { AgentId } from '../lib/types.js';
import { AGENTS } from '../lib/agents.js';
import { setHelpSections } from '../lib/help.js';
import {
  parseConfigKey,
  formatConfigKey,
  formatAgentVersion,
  devicePropertyToConfigName,
  configKeyStorageHint,
  listKnownConfigKeys,
  type ParsedConfigKey,
  type ParsedRunConfigKey,
  type ParsedDeviceConfigKey,
} from '../lib/config-keys.js';
import { registerBudgetCommand } from './budget.js';
import {
  resolveRunDefaults,
  setRunDefaultModel,
  setRunDefaultMode,
  setRunDefaultEffort,
  unsetRunDefault,
  type RunDefaultEntry,
} from '../lib/run-defaults.js';
import { resolveTierOverride, setTierOverride, clearTierOverride } from '../lib/model-tier-overrides.js';
import {
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
  listConfig,
  type ConfigEntry,
} from '../lib/device-config.js';
import { readMeta, updateMeta } from '../lib/state.js';
import { MODEL_TIERS } from '../lib/model-tiers.js';
import { machineId } from '../lib/machine-id.js';
import { getProjectRoot, setProjectRoot } from '../lib/project-root.js';
import {
  rawAgentAutoUpdateSetting,
  rawGlobalAutoUpdateSetting,
  setAgentAutoUpdateEnabled,
  setGlobalAutoUpdateEnabled,
  unsetAgentAutoUpdateEnabled,
  unsetGlobalAutoUpdateEnabled,
} from '../lib/installations/update-policy.js';

interface ConfigListOptions {
  json?: boolean;
  device?: string;
}


/** Parse a boolean value the same way `agents devices configure` does. */
function parseBool(value: string, key: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  throw new Error(`Config key '${key}' expects a boolean ('on' or 'off'), got '${value}'.`);
}

/** Parse the value for a given key, enforcing type rules. */
function parseValue(key: string, parsed: ParsedConfigKey, raw: string): unknown {
  switch (parsed.scope) {
    case 'run':
      return raw.trim();
    case 'interactive':
      return raw.trim();
    case 'auto':
      return raw.trim();
    case 'browser':
      return raw.trim();
    case 'project':
      return raw.trim();
    case 'summarizer':
      return parsed.property === 'enabled' ? parseBool(raw, key) : raw.trim();
    case 'updates':
      return parseBool(raw, key);
    case 'device': {
      const property = parsed.property;
      switch (property) {
        case 'role':
          return raw.trim();
        case 'max-agents':
          if (!/^\d+$/.test(raw.trim())) {
            throw new Error(`Config key '${key}' expects an integer, got '${raw}'.`);
          }
          return Number.parseInt(raw.trim(), 10);
        case 'scheduler':
        case 'daemon':
        case 'watchdog':
        case 'tmux':
        case 'browser.remote-control':
          return parseBool(raw, key);
        case 'browser.task-idle-minutes':
          if (!/^\d+$/.test(raw.trim())) {
            throw new Error(`Config key '${key}' expects a non-negative integer, got '${raw}'.`);
          }
          return Number.parseInt(raw.trim(), 10);
        case 'notes':
          return raw.trim();
        case 'browser.profile':
        case 'browser.viewer':
        case 'computer.host':
          return raw.trim();
      }
      // A device property with no arm above used to fall out of the switch and
      // return `undefined`, so the write failed downstream with "expects a
      // boolean, got undefined" instead of naming the real gap. The `never`
      // binding makes adding a DeviceConfigProperty without a parse rule a
      // compile error rather than a runtime mystery.
      const unhandled: never = property;
      throw new Error(`Config key '${key}' has no parse rule for device property '${String(unhandled)}'.`);
    }
  }
}

/** Write a value for a parsed config key. */
function setConfig(parsed: ParsedConfigKey, value: unknown): void {
  switch (parsed.scope) {
    case 'run': {
      const selector = `${parsed.agent}:${parsed.version}`;
      if (parsed.property === 'tier') {
        setTierOverride(selector, parsed.tier!, value as string);
        return;
      }
      if (parsed.property === 'model') {
        setRunDefaultModel(selector, value as string);
      } else if (parsed.property === 'mode') {
        setRunDefaultMode(selector, value as string);
      } else {
        setRunDefaultEffort(selector, value as string);
      }
      return;
    }
    case 'interactive': {
      setConfigValue('interactive.host', value as string);
      return;
    }
    case 'auto': {
      setConfigValue('auto.pool', value as string);
      return;
    }
    case 'browser': {
      if (parsed.property === 'device') {
        // Fleet hub: user scope, one central value, never peer-targeted.
        setConfigValue('browser.device', value as string);
        return;
      }
      // Device-local default lives in the per-device doc's config: block
      // (same store `agents devices config` / getConfigValue use). Bare
      // browser.profile targets this machine; devices.<name>.browser.profile
      // targets a peer.
      setConfigValue(
        parsed.property === 'viewer' ? 'browser.viewer' : 'browser.profile',
        value as string,
        parsed.device ? { device: parsed.device } : undefined,
      );
      return;
    }
    case 'project':
      setProjectRoot(value as string);
      return;
    case 'summarizer': {
      setConfigValue(`summarizer.${parsed.property}`, value);
      return;
    }
    case 'updates': {
      if (parsed.agent) setAgentAutoUpdateEnabled(parsed.agent, value as boolean);
      else setGlobalAutoUpdateEnabled(value as boolean);
      return;
    }
    case 'device': {
      const configName = devicePropertyToConfigName(parsed.property);
      if (parsed.property === 'notes') {
        const existing = (getConfigValue('notes', { device: parsed.device }).value as string[] | undefined) ?? [];
        setConfigValue('notes', [...existing, value as string], { device: parsed.device });
      } else {
        setConfigValue(configName, value, { device: parsed.device });
      }
      return;
    }
  }
}

/** Unset a parsed config key. */
function unsetConfig(parsed: ParsedConfigKey): boolean {
  switch (parsed.scope) {
    case 'run': {
      const selector = `${parsed.agent}:${parsed.version}`;
      if (parsed.property === 'tier') {
        return clearTierOverride(selector, parsed.tier);
      }
      return unsetRunDefault(selector);
    }
    case 'interactive': {
      const had = getConfigValue('interactive.host').value !== undefined;
      unsetConfigValue('interactive.host');
      return had;
    }
    case 'auto': {
      const had = getConfigValue('auto.pool').value !== undefined;
      unsetConfigValue('auto.pool');
      return had;
    }
    case 'browser': {
      if (parsed.property === 'device') {
        const had = getConfigValue('browser.device').value !== undefined;
        unsetConfigValue('browser.device');
        return had;
      }
      const target = parsed.device ? { device: parsed.device } : undefined;
      // Must follow parsed.property. Hardcoding 'browser.profile' here meant
      // `config unset browser.viewer` deleted the user's browser.profile while
      // printing success, and left browserViewer in place.
      const name = parsed.property === 'viewer' ? 'browser.viewer' : 'browser.profile';
      const had = getConfigValue(name, target).value !== undefined;
      unsetConfigValue(name, target);
      return had;
    }
    case 'project': {
      const had = getProjectRoot() !== undefined;
      // `projectRoot` is a machine-local key that `writeMeta` persists to the
      // device doc; it only clears that doc when the key is PRESENT-but-falsy
      // (`writesProjectRoot` needs the own-property, state.ts). Dropping the key
      // from the returned object left the device-doc value in place, so
      // `config get` still returned it after unset. Set it undefined instead.
      updateMeta((meta) => ({ ...meta, projectRoot: undefined }));
      return had;
    }
    case 'summarizer': {
      const name = `summarizer.${parsed.property}`;
      const had = getConfigValue(name).value !== undefined;
      unsetConfigValue(name);
      return had;
    }
    case 'updates': {
      if (parsed.agent) {
        const had = rawAgentAutoUpdateSetting(parsed.agent) !== undefined;
        unsetAgentAutoUpdateEnabled(parsed.agent);
        return had;
      }
      const had = rawGlobalAutoUpdateSetting() !== undefined;
      unsetGlobalAutoUpdateEnabled();
      return had;
    }
    case 'device': {
      const configName = devicePropertyToConfigName(parsed.property);
      const had = getConfigValue(configName, { device: parsed.device }).value !== undefined;
      unsetConfigValue(configName, { device: parsed.device });
      return had;
    }
  }
}

/** Read the stored value for a parsed config key. */
function getConfig(parsed: ParsedConfigKey): unknown {
  switch (parsed.scope) {
    case 'run': {
      const defaults = resolveRunDefaults(parsed.agent, parsed.version);
      if (parsed.property === 'tier') {
        return resolveTierOverride(parsed.agent, parsed.version)[parsed.tier!];
      }
      return defaults[parsed.property];
    }
    case 'interactive':
      return getConfigValue('interactive.host').value;
    case 'auto':
      return getConfigValue('auto.pool').value;
    case 'browser': {
      if (parsed.property === 'device') {
        return getConfigValue('browser.device').value;
      }
      return getConfigValue(
        parsed.property === 'viewer' ? 'browser.viewer' : 'browser.profile',
        parsed.device ? { device: parsed.device } : undefined,
      ).value;
    }
    case 'project':
      return getProjectRoot();
    case 'summarizer':
      return getConfigValue(`summarizer.${parsed.property}`).value;
    case 'updates':
      return parsed.agent ? rawAgentAutoUpdateSetting(parsed.agent) : rawGlobalAutoUpdateSetting();
    case 'device': {
      const configName = devicePropertyToConfigName(parsed.property);
      return getConfigValue(configName, { device: parsed.device }).value;
    }
  }
}

/** Format a config value for display. */
function formatValue(value: unknown): string {
  if (value === undefined) return chalk.gray('(unset)');
  if (typeof value === 'boolean') return value ? chalk.green('true') : chalk.red('false');
  return chalk.cyan(JSON.stringify(value));
}

/** Collect all set config entries for a given device scope (self or peer). */
function* listRunConfigEntries(): Generator<{ key: string; value: unknown; hint: string }> {
  const meta = readMeta();
  for (const [selector, defaults] of Object.entries(meta.run?.defaults ?? {})) {
    const [agent, version] = selector.split(':');
    if (!agent || !version) continue;
    const base = `run.${formatAgentVersion(agent as AgentId, version)}`;
    const d = defaults as Record<string, unknown>;
    for (const prop of ['model', 'mode', 'effort'] as const) {
      if (d[prop] !== undefined) {
        const key = `${base}.${prop}`;
        yield { key, value: d[prop], hint: configKeyStorageHint(parseConfigKey(key)) };
      }
    }
  }
  for (const [selector, tiers] of Object.entries(meta.model?.tiers ?? {})) {
    const [agent, version] = selector.split(':');
    if (!agent || !version) continue;
    const base = `run.${formatAgentVersion(agent as AgentId, version)}.tier`;
    for (const tier of MODEL_TIERS) {
      const value = (tiers as Record<string, string>)[tier];
      if (value !== undefined) {
        const key = `${base}.${tier}`;
        yield { key, value, hint: configKeyStorageHint(parseConfigKey(key)) };
      }
    }
  }
}

/** Collect central non-run config entries. */
function* listCentralConfigEntries(): Generator<{ key: string; value: unknown; hint: string }> {
  const meta = readMeta();
  if (meta.config?.interactiveHost !== undefined) {
    yield { key: 'interactive.host', value: meta.config.interactiveHost, hint: 'config.interactiveHost' };
  }
  if (meta.config?.autoPool !== undefined) {
    yield { key: 'auto.pool', value: meta.config.autoPool, hint: 'config.autoPool' };
  }
  if (meta.projectRoot !== undefined) {
    yield { key: 'project.root', value: meta.projectRoot, hint: 'devices.<self>.projectRoot' };
  }
  // This machine's default browser profile lives in fleet.devices.<self>.config
  // (device-config), not the legacy top-level Meta.defaultBrowserProfile field.
  const browserProfile = getConfigValue('browser.profile').value;
  if (browserProfile !== undefined) {
    const key = 'browser.profile';
    yield { key, value: browserProfile, hint: configKeyStorageHint(parseConfigKey(key)) };
  }

  const browserViewer = getConfigValue('browser.viewer').value;
  if (browserViewer !== undefined) {
    const key = 'browser.viewer';
    yield { key, value: browserViewer, hint: configKeyStorageHint(parseConfigKey(key)) };
  }

  // Fleet browser hub — user scope, so it belongs in the central listing next to
  // its siblings. Omitting it repeats the browser.viewer invisibility bug.
  const browserDevice = getConfigValue('browser.device').value;
  if (browserDevice !== undefined) {
    const key = 'browser.device';
    yield { key, value: browserDevice, hint: configKeyStorageHint(parseConfigKey(key)) };
  }

  // Session-summarizer keys (PHNX-3939) — user scope, syncs fleet-wide.
  for (const key of ['summarizer.enabled', 'summarizer.baseUrl', 'summarizer.model'] as const) {
    const value = getConfigValue(key).value;
    if (value !== undefined) {
      yield { key, value, hint: configKeyStorageHint(parseConfigKey(key)) };
    }
  }

  // Managed-harness auto-update switches (PHNX-3940) — user scope, syncs fleet-wide.
  const globalAutoUpdate = rawGlobalAutoUpdateSetting();
  if (globalAutoUpdate !== undefined) {
    yield { key: 'updates.auto', value: globalAutoUpdate, hint: configKeyStorageHint(parseConfigKey('updates.auto')) };
  }
  for (const agent of Object.keys(AGENTS) as AgentId[]) {
    const value = rawAgentAutoUpdateSetting(agent);
    if (value !== undefined) {
      const key = `updates.${agent}.auto`;
      yield { key, value, hint: configKeyStorageHint(parseConfigKey(key)) };
    }
  }
}

/** Collect device-scope config entries. */
function* listDeviceConfigEntries(device: string): Generator<{ key: string; value: unknown; hint: string }> {
  for (const entry of listConfig({ device })) {
    if (entry.value === undefined) continue;
    const prefix = `devices.${device}.`;
    let key: string;
    switch (entry.spec.name) {
      case 'agents.max-concurrent':
        key = `${prefix}max-agents`;
        break;
      case 'scheduler.enabled':
        key = `${prefix}scheduler`;
        break;
      case 'daemon.enabled':
        key = `${prefix}daemon`;
        break;
      case 'watchdog.enabled':
        key = `${prefix}watchdog`;
        break;
      case 'tmux.enabled':
        key = `${prefix}tmux`;
        break;
      case 'browser.remote-control':
        key = `${prefix}browser.remote-control`;
        break;
      case 'browser.task-idle-minutes':
        key = `${prefix}browser.task-idle-minutes`;
        break;
      case 'notes':
        key = `${prefix}notes`;
        break;
      case 'browser.profile':
        // The self device's default browser profile is already surfaced as the
        // top-level `browser.profile` key; skip it here to avoid duplication.
        if (device === machineId()) continue;
        key = `${prefix}browser.profile`;
        break;
      case 'browser.viewer':
        // Same duplication rule as browser.profile above.
        if (device === machineId()) continue;
        key = `${prefix}browser.viewer`;
        break;
      case 'computer.host':
        key = `${prefix}computer.host`;
        break;
      default:
        // A `default: continue` here silently drops any device property with no
        // arm — which is how browser.viewer was invisible to `config list` after
        // being added everywhere else. This is the fourth switch enumerating
        // DeviceConfigProperty; unlike parseValue's it cannot use a `never`
        // binding (it must keep skipping properties that are deliberately not
        // listed), so the completeness test in config.test.ts is the guard.
        continue;
    }
    yield { key, value: entry.value, hint: configKeyStorageHint(parseConfigKey(key)) };
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Get, set, list, and unset run defaults, tier overrides, the projects root, device options, and spend caps.');

  setHelpSections(config, {
    examples: `
      agents config set run.claude@*.model best
      agents config set run.claude@*.tier.best claude-opus-4-8
      agents config set run.claude@2.1.45.model claude-opus-4-8
      agents config set run.claude@*.mode auto
      agents config set interactive.host zion
      agents config set browser.profile work
      agents config set project.root ~/src/github.com/<you>
      agents config set devices.mac-mini.max-agents 4
      agents config set updates.auto off
      agents config set updates.claude.auto off
      agents config get run.claude@*.model
      agents config unset run.claude@*.tier.best
      agents config list
      agents config budget
      agents config budget set per_day 50
    `,
    notes: `
      Every agent/harness reference uses agent@version. Use * for all versions.
      Tier overrides are part of the run namespace: run.<agent@version>.tier.<tier>.
      Project root is auto-inferred from the current Git repository when unset.
      Spend caps live under \`agents config budget\` (not a top-level command).
    `,
  });

  config
    .command('list')
    .description('List configured config keys and their values')
    .option('--device <name>', 'List config for a specific device instead of this machine')
    .option('--json', 'Output machine-readable JSON')
    .action((opts: ConfigListOptions) => {
      try {
        const entries: Array<{ key: string; value: unknown; hint: string }> = [];

        if (!opts.device) {
          entries.push(...listRunConfigEntries());
          entries.push(...listCentralConfigEntries());
          entries.push(...listDeviceConfigEntries(machineId()));
        } else {
          entries.push(...listDeviceConfigEntries(opts.device));
        }

        entries.sort((a, b) => a.key.localeCompare(b.key));

        if (opts.json) {
          process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
          return;
        }

        if (entries.length === 0) {
          console.log(chalk.gray('No config values set.'));
          console.log(chalk.gray("Set one with: agents config set run.claude@*.model best"));
          return;
        }

        console.log(chalk.bold('Config\n'));
        for (const { key, value, hint } of entries) {
          console.log(`  ${chalk.cyan(key.padEnd(42))} ${formatValue(value)}`);
          console.log(`  ${''.padEnd(42)} ${chalk.gray(hint)}`);
        }
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  config
    .command('get <key>')
    .description('Get the current value of a config key')
    .option('--json', 'Output machine-readable JSON')
    .action((key: string, opts: { json?: boolean }) => {
      try {
        const parsed = parseConfigKey(key);
        const value = getConfig(parsed);
        if (opts.json) {
          process.stdout.write(JSON.stringify({ key, value: value ?? null }, null, 2) + '\n');
          return;
        }
        console.log(`${chalk.cyan(key)} = ${formatValue(value)}`);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  config
    .command('set <key> <value>')
    .description('Set a config key')
    .action((key: string, value: string) => {
      try {
        const parsed = parseConfigKey(key);
        const typed = parseValue(key, parsed, value);
        setConfig(parsed, typed);
        console.log(chalk.green('Set:') + ` ${chalk.cyan(key)} = ${formatValue(typed)}`);
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  config
    .command('unset <key>')
    .description('Unset a config key (restore default behavior)')
    .action((key: string) => {
      try {
        const parsed = parseConfigKey(key);
        const removed = unsetConfig(parsed);
        if (removed) {
          console.log(chalk.green(`Unset ${key}`));
        } else {
          console.log(chalk.gray(`No value set for ${key}`));
        }
      } catch (err: any) {
        console.error(chalk.red(err.message));
        process.exit(1);
      }
    });

  registerBudgetCommand(config);
}
