
import { AGENTS } from './agents.js';
import type { AgentId } from './types.js';
import { MODEL_TIERS, type ModelTier } from './model-tiers.js';
import { VERSION_RE } from './run-defaults.js';

export type ConfigScope = 'run' | 'interactive' | 'auto' | 'browser' | 'project' | 'device' | 'summarizer' | 'updates' | 'menubar';

export const MENUBAR_MENU_PROPERTIES = [
  'defaultProject',
  'workingRowsShown',
  'showPreviews',
  'projectPriorityFilter',
  'hideCompletedMilestones',
  'bannerWhenNeedsYou',
  'includeOtherDeviceRequests',
  'groupBy',
  'thenBy',
  'projectScope',
  'projectSort',
  'ticketSort',
  'showPullRequests',
  'sessionUpdates',
  'deviceSort',
  'headlessAgent',
  'headlessFallbackAgent',
  'headlessPlacement',
  'pinnedProjects',
  'tabOrder',
  'hiddenTabs',
  'groupTicketsByMilestone',
  'prGroupOpen',
  'prGroupMerged',
  'homeGoals',
] as const;

export const MENUBAR_STATUSBAR_PROPERTIES = ['goalCountdown'] as const;

export type MenubarSection = 'menu' | 'statusbar';

export const MENUBAR_CONFIG_KEYS: readonly string[] = [
  ...MENUBAR_MENU_PROPERTIES.map((p) => `menubar.menu.${p}`),
  ...MENUBAR_STATUSBAR_PROPERTIES.map((p) => `menubar.statusbar.${p}`),
];

export interface ParsedRunConfigKey {
  scope: 'run';
  agent: AgentId;
  version: string;
  property: 'model' | 'mode' | 'effort' | 'tier';
  tier?: ModelTier;
}

export interface ParsedInteractiveConfigKey {
  scope: 'interactive';
  property: 'host';
}

export interface ParsedAutoConfigKey {
  scope: 'auto';
  property: 'pool';
}

export interface ParsedBrowserConfigKey {
  scope: 'browser';
  property: 'profile' | 'viewer' | 'device';
  device?: string;
}

export interface ParsedProjectConfigKey {
  scope: 'project';
  property: 'root';
}

export interface ParsedDeviceConfigKey {
  scope: 'device';
  device: string;
  property: DeviceConfigProperty;
}

export interface ParsedSummarizerConfigKey {
  scope: 'summarizer';
  property: 'enabled' | 'baseUrl' | 'model';
}

export interface ParsedUpdatesConfigKey {
  scope: 'updates';
  property: 'auto';
  agent?: AgentId;
}

export interface ParsedMenubarConfigKey {
  scope: 'menubar';
  section: MenubarSection;
  property: string;
}

export type ParsedConfigKey =
  | ParsedRunConfigKey
  | ParsedInteractiveConfigKey
  | ParsedAutoConfigKey
  | ParsedBrowserConfigKey
  | ParsedProjectConfigKey
  | ParsedDeviceConfigKey
  | ParsedSummarizerConfigKey
  | ParsedUpdatesConfigKey
  | ParsedMenubarConfigKey;

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
  | 'computer.host'
  | 'formFactor';

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
  'formFactor',
];

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

export function formatAgentVersion(agent: AgentId, version: string): string {
  return `${agent}@${version}`;
}

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

  const menubarMatch = raw.match(/^menubar\.(menu|statusbar)\.(.+)$/);
  if (menubarMatch) {
    if (!MENUBAR_CONFIG_KEYS.includes(raw)) {
      throw new Error(`Unknown AGI Menu preference '${key}'. Known keys: ${MENUBAR_CONFIG_KEYS.join(', ')}.`);
    }
    return { scope: 'menubar', section: menubarMatch[1] as MenubarSection, property: menubarMatch[2] };
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
    /^devices\.(.+)\.(role|max-agents|scheduler|daemon|watchdog|tmux|notes|formFactor|browser\.remote-control|browser\.task-idle-minutes|browser\.profile|browser\.viewer|computer\.host)$/,
  );
  if (deviceMatch) {
    return {
      scope: 'device',
      device: deviceMatch[1],
      property: deviceMatch[2] as DeviceConfigProperty,
    };
  }

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
  if (raw.startsWith('menubar.')) {
    throw new Error(
      `Invalid AGI Menu config key '${key}'. Use ${MENUBAR_CONFIG_KEYS.join(', ')}.`,
    );
  }
  if (raw.startsWith('devices.')) {
    throw new Error(
      `Invalid device config key '${key}'. Expected devices.<name>.<${DEVICE_CONFIG_PROPERTIES.join('|')}>.`,
    );
  }

  throw new Error(
    `Unknown config scope in '${key}'. Use one of: run, interactive, auto, browser, project, devices, summarizer, updates, menubar.`,
  );
}

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
    case 'menubar':
      return `menubar.${parsed.section}.${parsed.property}`;
  }
}

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
  keys.push(...MENUBAR_CONFIG_KEYS);
  for (const prop of DEVICE_CONFIG_PROPERTIES) {
    keys.push(`devices.<name>.${prop}`);
  }
  return keys;
}

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
    case 'formFactor':
      return 'formFactor';
  }
}

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
    case 'menubar':
      return `config.menubar${parsed.section === 'menu' ? 'Menu' : 'Statusbar'}${parsed.property.charAt(0).toUpperCase()}${parsed.property.slice(1)} (central agents.yaml; syncs fleet-wide)`;
  }
}
