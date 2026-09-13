/**
 * Unified config key grammar for `agents config`.
 *
 * Translates user-facing dotted keys like `run.claude@*.tier.best` into the
 * existing storage locations (run.defaults, model.tiers, config.*,
 * defaultBrowserProfile, deviceConfig.*) so the new command barrel can sit on
 * top of the current YAML schema without a migration.
 */

import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import { MODEL_TIERS, type ModelTier } from './model-tiers.js';
import { VERSION_RE } from './run-defaults.js';

/** The top-level scope of a unified config key. */
export type ConfigScope = 'run' | 'interactive' | 'auto' | 'browser' | 'project' | 'device' | 'summarizer' | 'updates';

/** A run-time default key: model, mode, effort, or tier override. */
export interface ParsedRunConfigKey {
  scope: 'run';
  agent: AgentId;
  version: string;
  property: 'model' | 'mode' | 'effort' | 'tier';
  tier?: ModelTier;
}

/** The interactive host pin. */
export interface ParsedInteractiveConfigKey {
  scope: 'interactive';
  property: 'host';
}

/** Which devices automatic placement (`--device auto`) may pick. */
export interface ParsedAutoConfigKey {
  scope: 'auto';
  property: 'pool';
}

/** A browser key: the profile agents drive or the browser that shows the user a
 *  page (both device-scope, self or peer), or `device` — the user-scope fleet
 *  hub every box drives by default, which is central and never peer-targeted. */
export interface ParsedBrowserConfigKey {
  scope: 'browser';
  property: 'profile' | 'viewer' | 'device';
  device?: string;
}

export interface ParsedProjectConfigKey {
  scope: 'project';
  property: 'root';
}

/** A per-device configuration key. */
export interface ParsedDeviceConfigKey {
  scope: 'device';
  device: string;
  property: DeviceConfigProperty;
}

/** The daemon session-summarizer keys (PHNX-3939). */
export interface ParsedSummarizerConfigKey {
  scope: 'summarizer';
  property: 'enabled' | 'baseUrl' | 'model';
}

/**
 * The managed-harness auto-update switch (PHNX-3940): `updates.auto` (global)
 * or `updates.<agent>.auto` (one harness — `agent` is set).
 */
export interface ParsedUpdatesConfigKey {
  scope: 'updates';
  property: 'auto';
  agent?: AgentId;
}

export type ParsedConfigKey =
  | ParsedRunConfigKey
  | ParsedInteractiveConfigKey
  | ParsedAutoConfigKey
  | ParsedBrowserConfigKey
  | ParsedProjectConfigKey
  | ParsedDeviceConfigKey
  | ParsedSummarizerConfigKey
  | ParsedUpdatesConfigKey;

export type DeviceConfigProperty =
  | 'role'
  | 'max-agents'
  | 'scheduler'
  | 'daemon'
  | 'watchdog'
  | 'tmux'
  | 'browser.remote-control'
  | 'browser.task-idle-minutes'
  | 'notes'
  | 'browser.profile'
  | 'browser.viewer'
  | 'computer.host';

const DEVICE_CONFIG_PROPERTIES: DeviceConfigProperty[] = [
  'browser.viewer',
  'role',
  'max-agents',
  'scheduler',
  'daemon',
  'watchdog',
  'tmux',
  'browser.remote-control',
  'browser.task-idle-minutes',
  'notes',
  'browser.profile',
  'computer.host',
];

/** Split an agent@version token into its parts. Accepts both `@` and `:`. */
function parseAgentVersion(token: string): { agent: AgentId; version: string } {
  const sep = token.includes('@') ? '@' : ':';
  const [agentPart, versionPart = '*'] = token.split(sep);
  const agent = agentPart.toLowerCase();
  if (!(agent in AGENTS)) {
    throw new Error(
      `Unknown agent '${agentPart}'. Known agents: ${Object.keys(AGENTS).join(', ')}.`,
    );
  }
  if (!VERSION_RE.test(versionPart)) {
    throw new Error(
      `Invalid version '${versionPart}' in '${token}'. Use *, latest, or [A-Za-z0-9._+-]{1,64}.`,
    );
  }
  return { agent: agent as AgentId, version: versionPart };
}

/** Normalize agent@version to use `@` consistently. */
export function formatAgentVersion(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

/**
 * Parse a unified config key into its structured representation.
 *
 * Supported forms:
 *   run.<agent@version>.model
 *   run.<agent@version>.mode
 *   run.<agent@version>.effort
 *   run.<agent@version>.tier.<cheap|default|best|ultra>
 *   interactive.host
 *   auto.pool
 *   browser.profile
 *   project.root
 *   devices.<name>.role
 *   devices.<name>.max-agents
 *   devices.<name>.scheduler
 *   devices.<name>.daemon
 *   devices.<name>.watchdog
 *   devices.<name>.tmux
 *   devices.<name>.browser.remote-control
 *   devices.<name>.browser.task-idle-minutes
 *   devices.<name>.notes
 *   devices.<name>.browser.profile
 */
export function parseConfigKey(key: string): ParsedConfigKey {
  const raw = key.trim();
  if (!raw) throw new Error('Config key is required.');

  const runMatch = raw.match(/^run\.(.+)\.(model|mode|effort)$/);
  if (runMatch) {
    const { agent, version } = parseAgentVersion(runMatch[1]);
    return { scope: 'run', agent, version, property: runMatch[2] as 'model' | 'mode' | 'effort' };
  }

  const tierMatch = raw.match(/^run\.(.+)\.tier\.(cheap|default|best|ultra)$/i);
  if (tierMatch) {
    const { agent, version } = parseAgentVersion(tierMatch[1]);
    return { scope: 'run', agent, version, property: 'tier', tier: tierMatch[2].toLowerCase() as ModelTier };
  }

  if (raw === 'interactive.host') {
    return { scope: 'interactive', property: 'host' };
  }

  if (raw === 'auto.pool') {
    return { scope: 'auto', property: 'pool' };
  }

  if (raw === 'browser.profile') {
    return { scope: 'browser', property: 'profile' };
  }

  if (raw === 'browser.viewer') {
    return { scope: 'browser', property: 'viewer' };
  }

  if (raw === 'browser.device') {
    return { scope: 'browser', property: 'device' };
  }

  if (raw === 'project.root') {
    return { scope: 'project', property: 'root' };
  }

  const summarizerMatch = raw.match(/^summarizer\.(enabled|baseUrl|model)$/);
  if (summarizerMatch) {
    return { scope: 'summarizer', property: summarizerMatch[1] as 'enabled' | 'baseUrl' | 'model' };
  }

  if (raw === 'updates.auto') {
    return { scope: 'updates', property: 'auto' };
  }

  const updatesAgentMatch = raw.match(/^updates\.(.+)\.auto$/);
  if (updatesAgentMatch) {
    const agentPart = updatesAgentMatch[1].toLowerCase();
    if (!(agentPart in AGENTS)) {
      throw new Error(`Unknown agent '${updatesAgentMatch[1]}' in '${key}'. Known agents: ${Object.keys(AGENTS).join(', ')}.`);
    }
    return { scope: 'updates', agent: agentPart as AgentId, property: 'auto' };
  }

  const deviceMatch = raw.match(
    /^devices\.(.+)\.(role|max-agents|scheduler|daemon|watchdog|tmux|notes|browser\.remote-control|browser\.task-idle-minutes|browser\.profile|browser\.viewer|computer\.host)$/,
  );
  if (deviceMatch) {
    return {
      scope: 'device',
      device: deviceMatch[1],
      property: deviceMatch[2] as DeviceConfigProperty,
    };
  }

  // Provide helpful errors for common mistakes.
  if (raw.startsWith('run.')) {
    throw new Error(
      `Invalid run config key '${key}'. Expected run.<agent@version>.<model|mode|effort> or run.<agent@version>.tier.<cheap|default|best|ultra>.`,
    );
  }
  if (raw.startsWith('interactive.')) {
    throw new Error(`Invalid interactive config key '${key}'. Use interactive.host.`);
  }
  if (raw.startsWith('auto.')) {
    throw new Error(`Invalid auto config key '${key}'. Use auto.pool.`);
  }
  if (raw.startsWith('browser.')) {
    throw new Error(`Invalid browser config key '${key}'. Use browser.profile, browser.viewer, or browser.device.`);
  }
  if (raw.startsWith('project.')) {
    throw new Error(`Invalid project config key '${key}'. Use project.root.`);
  }
  if (raw.startsWith('summarizer.')) {
    throw new Error(`Invalid summarizer config key '${key}'. Use summarizer.enabled, summarizer.baseUrl, or summarizer.model.`);
  }
  if (raw.startsWith('updates.')) {
    throw new Error(`Invalid updates config key '${key}'. Use updates.auto or updates.<agent>.auto.`);
  }
  if (raw.startsWith('devices.')) {
    throw new Error(
      `Invalid device config key '${key}'. Expected devices.<name>.<${DEVICE_CONFIG_PROPERTIES.join('|')}>.`,
    );
  }

  throw new Error(
    `Unknown config scope in '${key}'. Use one of: run, interactive, auto, browser, project, devices, summarizer.`,
  );
}

/** Render a parsed key back to its canonical dotted string. */
export function formatConfigKey(parsed: ParsedConfigKey): string {
  switch (parsed.scope) {
    case 'run':
      if (parsed.property === 'tier') {
        return `run.${formatAgentVersion(parsed.agent, parsed.version)}.tier.${parsed.tier}`;
      }
      return `run.${formatAgentVersion(parsed.agent, parsed.version)}.${parsed.property}`;
    case 'interactive':
      return 'interactive.host';
    case 'auto':
      return 'auto.pool';
    case 'browser':
      return parsed.device
        ? `devices.${parsed.device}.browser.${parsed.property}`
        : `browser.${parsed.property}`;
    case 'project':
      return 'project.root';
    case 'device':
      return `devices.${parsed.device}.${parsed.property}`;
    case 'summarizer':
      return `summarizer.${parsed.property}`;
    case 'updates':
      return parsed.agent ? `updates.${parsed.agent}.auto` : 'updates.auto';
  }
}

/** List every canonical key the command documents, with wildcards expanded to a concrete example. */
export function listKnownConfigKeys(): string[] {
  const keys: string[] = [];
  keys.push(
    'run.<agent@version>.model',
    'run.<agent@version>.mode',
    'run.<agent@version>.effort',
  );
  for (const tier of MODEL_TIERS) {
    keys.push(`run.<agent@version>.tier.${tier}`);
  }
  keys.push(
    'interactive.host',
    'auto.pool',
    'browser.profile',
    'browser.viewer',
    'browser.device',
    'project.root',
    'summarizer.enabled',
    'summarizer.baseUrl',
    'summarizer.model',
    'updates.auto',
    'updates.<agent>.auto',
  );
  for (const prop of DEVICE_CONFIG_PROPERTIES) {
    keys.push(`devices.<name>.${prop}`);
  }
  return keys;
}

/**
 * Map a parsed device property to the internal device-config key name.
 * This is the bridge between the friendly `agents config` surface and the
 * existing CONFIG_KEYS registry in lib/device-config.ts.
 */
export function devicePropertyToConfigName(property: DeviceConfigProperty): string {
  switch (property) {
    case 'role':
      return 'role';
    case 'max-agents':
      return 'agents.max-concurrent';
    case 'scheduler':
      return 'scheduler.enabled';
    case 'daemon':
      return 'daemon.enabled';
    case 'watchdog':
      return 'watchdog.enabled';
    case 'tmux':
      return 'tmux.enabled';
    case 'browser.remote-control':
      return 'browser.remote-control';
    case 'browser.task-idle-minutes':
      return 'browser.task-idle-minutes';
    case 'notes':
      return 'notes';
    case 'browser.profile':
      return 'browser.profile';
    case 'browser.viewer':
      return 'browser.viewer';
    case 'computer.host':
      return 'computer.host';
  }
}

/**
 * Map a parsed key to the human-readable "where is this stored" note.
 * Useful for `agents config list --source` output.
 */
export function configKeyStorageHint(parsed: ParsedConfigKey): string {
  switch (parsed.scope) {
    case 'run':
      if (parsed.property === 'tier') {
        return `model.tiers.${parsed.agent}:${parsed.version}.${parsed.tier}`;
      }
      return `run.defaults.${parsed.agent}:${parsed.version}.${parsed.property}`;
    case 'interactive':
      return 'config.interactiveHost';
    case 'auto':
      return 'config.autoPool';
    case 'browser': {
      if (parsed.property === 'device') {
        // User scope: one value in the central agents.yaml that syncs fleet-wide.
        return 'config.defaultBrowserDevice (central agents.yaml; syncs fleet-wide)';
      }
      const yamlKey = parsed.property === 'viewer' ? 'browserViewer' : 'defaultBrowserProfile';
      return parsed.device
        ? `devices/${parsed.device}/agents.yaml config.${yamlKey}`
        : `devices/<self>/agents.yaml config.${yamlKey}`;
    }
    case 'project':
      return 'devices.<self>.projectRoot';
    case 'device':
      return `devices/${parsed.device}/agents.yaml config (${devicePropertyToConfigName(parsed.property)}; fleet default: fleet.defaults.config)`;
    case 'summarizer': {
      const yamlKey = parsed.property === 'enabled'
        ? 'summarizerEnabled'
        : parsed.property === 'baseUrl' ? 'summarizerBaseUrl' : 'summarizerModel';
      return `config.${yamlKey} (central agents.yaml; syncs fleet-wide)`;
    }
    case 'updates':
      return parsed.agent
        ? `config.updatesAgentAuto.${parsed.agent} (central agents.yaml; syncs fleet-wide)`
        : 'config.updatesAuto (central agents.yaml; syncs fleet-wide)';
  }
}
