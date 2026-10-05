
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getMonitorsDir, getSystemMonitorsDir, ensureAgentsDir, readMeta } from '../state.js';
import { safeJoin, isSafeSegmentName } from '../paths.js';
import { atomicWriteFileSync } from '../fs-atomic.js';
import { machineId, normalizeHost } from '../machine-id.js';
import { loadDevicesSync } from '../devices/registry.js';
import type { AgentId } from '../types.js';
import { ALL_AGENT_IDS } from '../agents.js';
import { isCustomHarnessName } from '../profiles.js';

export type MonitorSourceType =
  | 'command'
  | 'poll'
  | 'poll-http'
  | 'webhook'
  | 'ws'
  | 'file'
  | 'device';

export interface MonitorWebhookSource {
  source: 'github' | 'linear';
  event: string;
  repo?: string;
  branch?: string;
  action?: string;
  teamKey?: string;
  label?: string;
}

export interface MonitorSource {
  type: MonitorSourceType;
  command?: string;
  interval?: string;
  url?: string;
  wsUrl?: string;
  path?: string;
  device?: string;
  webhook?: MonitorWebhookSource;
}

export type MonitorConditionMode = 'on-change' | 'match' | 'every';

export interface MonitorCondition {
  mode: MonitorConditionMode;
  match?: string;
  dedupeKey?: string;
}

export type MonitorActionType = 'run' | 'routine' | 'notify' | 'webhook-out';

export interface ActionConfig {
  type: MonitorActionType;
  agent?: AgentId | (string & {});
  prompt?: string;
  mode?: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  timeout?: string;
  routine?: string;
  notifyChannel?: string;
  url?: string;
  postcondition?: string;
}

export interface MonitorConfig {
  name: string;
  enabled: boolean;
  source: MonitorSource;
  condition: MonitorCondition;
  action: ActionConfig;
  device?: string;
  devices?: string[];
  sharedInput?: boolean;
  runOn?: string;
  cwd?: string;
  rateLimit?: { max: number; per: string };
  variables?: Record<string, string>;
  version?: string;
  scope?: 'user' | 'system';
}

export interface MonitorEvent {
  monitorName: string;
  firedAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

const MONITOR_DEFAULTS: Partial<MonitorConfig> = {
  enabled: true,
};

const SOURCE_TYPES: readonly MonitorSourceType[] = [
  'command',
  'poll',
  'poll-http',
  'webhook',
  'ws',
  'file',
  'device',
];

const CONDITION_MODES: readonly MonitorConditionMode[] = ['on-change', 'match', 'every'];
const ACTION_TYPES: readonly MonitorActionType[] = ['run', 'routine', 'notify', 'webhook-out'];

export function parseInterval(interval: string): number | null {
  const match = interval.trim().match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return null;
  const weeks = parseInt(match[1] || '0', 10);
  const days = parseInt(match[2] || '0', 10);
  const hours = parseInt(match[3] || '0', 10);
  const minutes = parseInt(match[4] || '0', 10);
  const seconds = parseInt(match[5] || '0', 10);
  const ms = ((((weeks * 7 + days) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

export function requiresSingleOwner(
  config: Pick<MonitorConfig, 'device' | 'devices' | 'scope' | 'sharedInput'>,
): boolean {
  if (config.device || (config.devices && config.devices.length > 0)) return false;
  if (config.scope === 'system') return config.sharedInput !== false;
  return config.sharedInput === true;
}

export function resolveSharedInputOwner(
  interactiveHost: string | undefined,
  deviceNames: string[],
  self: string,
): string | undefined {
  if (typeof interactiveHost === 'string' && interactiveHost.trim()) {
    return normalizeHost(interactiveHost);
  }
  const others = deviceNames.map((d) => normalizeHost(d)).filter((d) => d && d !== self);
  if (others.length === 0) return self;
  return undefined;
}

export function monitorSharedInputOwner(): string | undefined {
  const self = machineId();
  const interactiveHost = readMeta().config?.interactiveHost;
  let deviceNames: string[] = [];
  try {
    deviceNames = Object.keys(loadDevicesSync());
  } catch {
    deviceNames = [];
  }
  return resolveSharedInputOwner(
    typeof interactiveHost === 'string' ? interactiveHost : undefined,
    deviceNames,
    self,
  );
}

export function monitorRunsOnThisDevice(
  config: Pick<MonitorConfig, 'device' | 'devices' | 'scope' | 'sharedInput'>,
  ownerHost?: string,
): boolean {
  const self = machineId();
  if (config.device) return normalizeHost(config.device) === self;
  if (config.devices && config.devices.length > 0) {
    return config.devices.some((d) => normalizeHost(d) === self);
  }
  if (requiresSingleOwner(config)) {
    const resolved = ownerHost !== undefined ? ownerHost : monitorSharedInputOwner();
    const owner = resolved && resolved.trim() ? normalizeHost(resolved) : undefined;
    return owner !== undefined && owner === self;
  }
  return true;
}

function populatedSourceFields(source: MonitorSource): string[] {
  const fields: Array<[string, unknown]> = [
    ['command', source.command],
    ['url', source.url],
    ['wsUrl', source.wsUrl],
    ['path', source.path],
    ['device', source.device],
    ['webhook', source.webhook],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k]) => k);
}

const SOURCE_TYPE_FIELD: Record<MonitorSourceType, string> = {
  command: 'command',
  poll: 'command',
  'poll-http': 'url',
  webhook: 'webhook',
  ws: 'wsUrl',
  file: 'path',
  device: 'device',
};

function populatedActionFields(action: ActionConfig): string[] {
  const fields: Array<[string, unknown]> = [
    ['agent', action.agent],
    ['routine', action.routine],
    ['url', action.url],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k]) => k);
}

export function validateMonitor(config: Partial<MonitorConfig>): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== 'string') {
    errors.push('name is required');
  } else if (!isSafeSegmentName(config.name)) {
    errors.push(
      `invalid name ${JSON.stringify(config.name)}: must be a single path segment ` +
        `(no '/', '\\\\', or null bytes, and not '.' or '..')`,
    );
  }

  const source = config.source;
  if (!source || typeof source !== 'object') {
    errors.push('a source is required (source: { type, ... })');
  } else {
    if (!source.type || !SOURCE_TYPES.includes(source.type)) {
      errors.push(`source.type must be one of: ${SOURCE_TYPES.join(', ')}`);
    }
    const populated = populatedSourceFields(source);
    if (source.type && SOURCE_TYPES.includes(source.type)) {
      const required = SOURCE_TYPE_FIELD[source.type];
      const stray = populated.filter((f) => f !== required);
      if (stray.length > 0) {
        errors.push(
          `source has conflicting fields (${[required, ...stray].join(', ')}); specify exactly one source`,
        );
      }
      if (!populated.includes(required)) {
        errors.push(`source.type '${source.type}' requires source.${required}`);
      }
    } else if (populated.length > 1) {
      errors.push(`source has conflicting fields (${populated.join(', ')}); specify exactly one source`);
    }
    if ((source.type === 'poll' || source.type === 'poll-http') && source.interval === undefined) {
      errors.push(`source.type '${source.type}' requires source.interval (e.g. 30s, 15m, 8h)`);
    }
    if (source.interval !== undefined && parseInterval(source.interval) === null) {
      errors.push(`source.interval must be like 30s, 15m, 8h, 1d (got ${JSON.stringify(source.interval)})`);
    }
    if (source.webhook !== undefined) {
      const w = source.webhook;
      if (!w || typeof w !== 'object') {
        errors.push('source.webhook must be an object');
      } else if (w.source !== 'github' && w.source !== 'linear') {
        errors.push("source.webhook.source must be 'github' or 'linear'");
      } else if (!w.event || typeof w.event !== 'string') {
        errors.push('source.webhook.event is required');
      }
    }
  }

  const condition = config.condition;
  if (!condition || typeof condition !== 'object') {
    errors.push('a condition is required (condition: { mode, ... })');
  } else {
    if (!condition.mode || !CONDITION_MODES.includes(condition.mode)) {
      errors.push(`condition.mode must be one of: ${CONDITION_MODES.join(', ')}`);
    }
    if (condition.mode === 'match') {
      if (!condition.match || typeof condition.match !== 'string') {
        errors.push("condition.mode 'match' requires condition.match (a regex)");
      }
    }
    for (const key of ['match', 'dedupeKey'] as const) {
      const val = condition[key];
      if (val !== undefined) {
        if (typeof val !== 'string') {
          errors.push(`condition.${key} must be a regex string`);
        } else {
          try {
            new RegExp(val);
          } catch {
            errors.push(`condition.${key} is not a valid regular expression: ${JSON.stringify(val)}`);
          }
        }
      }
    }
  }

  const action = config.action;
  if (!action || typeof action !== 'object') {
    errors.push('an action is required (action: { type, ... })');
  } else {
    if (!action.type || !ACTION_TYPES.includes(action.type)) {
      errors.push(`action.type must be one of: ${ACTION_TYPES.join(', ')}`);
    }
    const populatedAct = populatedActionFields(action);
    const requiredByType: Partial<Record<MonitorActionType, string>> = {
      run: 'agent',
      routine: 'routine',
      'webhook-out': 'url',
    };
    if (action.type && ACTION_TYPES.includes(action.type)) {
      const required = requiredByType[action.type];
      const stray = populatedAct.filter((f) => f !== required);
      if (stray.length > 0) {
        errors.push(
          `action has conflicting fields (${[...(required ? [required] : []), ...stray].join(', ')}); specify exactly one action`,
        );
      }
      if (required && !populatedAct.includes(required)) {
        errors.push(`action.type '${action.type}' requires action.${required}`);
      }
    } else if (populatedAct.length > 1) {
      errors.push(`action has conflicting fields (${populatedAct.join(', ')}); specify exactly one action`);
    }
    if (action.type === 'run') {
      if (action.agent && !ALL_AGENT_IDS.includes(action.agent as AgentId) && !isCustomHarnessName(action.agent)) {
        errors.push(`action.agent must be one of: ${ALL_AGENT_IDS.join(', ')}, or a custom harness (agents harness list)`);
      }
      if (!action.prompt || typeof action.prompt !== 'string') {
        errors.push("action.type 'run' requires action.prompt");
      }
      if (action.mode && !['plan', 'edit', 'auto', 'skip', 'full'].includes(action.mode)) {
        errors.push("action.mode must be plan, edit, auto, or skip ('full' accepted as alias for skip)");
      }
      if (action.effort && !['low', 'medium', 'high', 'xhigh', 'max', 'auto'].includes(action.effort)) {
        errors.push('action.effort must be low, medium, high, xhigh, max, or auto');
      }
    }
    if (action.type === 'webhook-out' && action.url) {
      try {
        // eslint-disable-next-line no-new
        new URL(action.url);
      } catch {
        errors.push(`action.url must be an absolute URL (got ${JSON.stringify(action.url)})`);
      }
    }
    if (action.postcondition !== undefined) {
      if (action.type !== 'run' && action.type !== 'routine') {
        errors.push("action.postcondition only applies to run or routine actions");
      } else if (typeof action.postcondition !== 'string' || action.postcondition.trim() === '') {
        errors.push('action.postcondition must be a non-empty shell command');
      }
    }
  }

  if (config.device !== undefined && config.devices !== undefined) {
    errors.push("device (single owner) and devices (allowlist) are mutually exclusive — pick one");
  }
  if (config.device !== undefined && (typeof config.device !== 'string' || config.device.trim() === '')) {
    errors.push('device must be a non-empty device name');
  }
  if (config.devices !== undefined) {
    if (!Array.isArray(config.devices)) {
      errors.push('devices must be an array of device names');
    } else {
      for (const d of config.devices) {
        if (typeof d !== 'string' || d.trim() === '') {
          errors.push('each entry in devices must be a non-empty device name');
          break;
        }
      }
    }
  }
  if (config.sharedInput !== undefined && typeof config.sharedInput !== 'boolean') {
    errors.push('sharedInput must be a boolean (true = source polls a fleet-shared queue)');
  }
  if (config.runOn !== undefined && (typeof config.runOn !== 'string' || config.runOn.trim() === '')) {
    errors.push('runOn must be a non-empty machine name (a registered host, device, capability tag, or user@host)');
  }
  if (config.cwd !== undefined && (typeof config.cwd !== 'string' || config.cwd.trim() === '')) {
    errors.push('cwd must be a non-empty path (home-relative or ~/…)');
  }

  if (config.rateLimit !== undefined) {
    const rl = config.rateLimit;
    if (!rl || typeof rl !== 'object' || typeof rl.max !== 'number' || rl.max <= 0) {
      errors.push('rateLimit.max must be a positive number');
    }
    if (!rl || typeof rl.per !== 'string' || parseInterval(rl.per) === null) {
      errors.push('rateLimit.per must be an interval like 1m, 1h, 1d');
    }
  }

  return errors;
}

/**
 * Read and normalize a monitor file. A built-in defaults to enabled exactly like
 * every other system-layer resource (rules, hooks, commands, skills): a monitor
 * shipped in the system mirror is on for every install unless the user shadows it
 * with an explicit `enabled: false` (via `agents monitors pause`, which writes a
 * user copy — the system mirror is pull-only). There is deliberately no
 * system-scope special-case: monitors used to be the lone outlier that shipped
 * disabled+invisible (PHNX-2506). `scope` no longer changes the enabled default;
 * it is retained on the config so `list`/`view` can tag a built-in.
 *
 * Enabled-by-default is NOT, on its own, permission to fire on every daemon. A
 * shared-input built-in (one whose source polls a fleet-shared queue such as `gh
 * pr list --author @me`) is placed on a single owner by `monitorRunsOnThisDevice`
 * / `requiresSingleOwner` even when the shipped YAML carries no `device:` pin: a
 * system built-in is treated as shared-input unless it sets `sharedInput: false`,
 * so it can never fan out across the fleet and double-fire on a shared queue
 * (SING-9). A device-local built-in opts back into fleet-wide firing with
 * `sharedInput: false`; a genuinely-shared one should still ship a `device:` pin
 * (or `sharedInput: true`) to document the intent.
 */
function readMonitorFile(filePath: string, scope: 'user' | 'system' = 'user'): MonitorConfig | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const hasEnabled = Object.prototype.hasOwnProperty.call(parsed, 'enabled');
    return {
      ...MONITOR_DEFAULTS,
      ...parsed,
      name: parsed.name || path.basename(filePath).replace(/\.ya?ml$/, ''),
      enabled: hasEnabled ? parsed.enabled !== false : (MONITOR_DEFAULTS.enabled ?? true),
      scope,
    } as MonitorConfig;
  } catch {
    return null;
  }
}

function monitorLayers(): Array<{ scope: 'user' | 'system'; path: string }> {
  return [
    { scope: 'user', path: getMonitorsDir() },
    { scope: 'system', path: getSystemMonitorsDir() },
  ];
}

export function listMonitors(): MonitorConfig[] {
  ensureAgentsDir();
  const monitors: MonitorConfig[] = [];
  const seen = new Set<string>();
  for (const { scope, path: dir } of monitorLayers()) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
      const monitor = readMonitorFile(path.join(dir, file), scope);
      if (!monitor || seen.has(monitor.name)) continue;
      seen.add(monitor.name);
      monitors.push(monitor);
    }
  }
  return monitors;
}

export function readMonitor(name: string): MonitorConfig | null {
  ensureAgentsDir();
  for (const { scope, path: dir } of monitorLayers()) {
    for (const ext of ['.yml', '.yaml']) {
      const filePath = safeJoin(dir, name + ext);
      if (fs.existsSync(filePath)) return readMonitorFile(filePath, scope);
    }
  }
  return null;
}

export function getMonitorPath(name: string): string | null {
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

export function writeMonitor(config: MonitorConfig): void {
  ensureAgentsDir();
  const dir = getMonitorsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ymlPath = safeJoin(dir, config.name + '.yml');
  const yamlPath = safeJoin(dir, config.name + '.yaml');
  if (fs.existsSync(ymlPath) && fs.existsSync(yamlPath)) {
    throw new Error(
      `Monitor '${config.name}' has both .yml and .yaml files; resolve the ambiguity before editing.`,
    );
  }
  const filePath = fs.existsSync(yamlPath) ? yamlPath : ymlPath;

  const output: Record<string, unknown> = { ...config };
  if (output.enabled === true) delete output.enabled;
  delete output.scope;
  const devArr = output.devices as string[] | undefined;
  if (!devArr || devArr.length === 0) delete output.devices;

  atomicWriteFileSync(filePath, yaml.stringify(output));
}

export function deleteMonitor(name: string): boolean {
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

export function setMonitorEnabled(name: string, enabled: boolean): void {
  const monitor = readMonitor(name);
  if (!monitor) throw new Error(`Monitor '${name}' not found`);
  monitor.enabled = enabled;
  writeMonitor(monitor);
}
