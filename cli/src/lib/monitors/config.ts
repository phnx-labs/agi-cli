/** Monitor (event-triggered watcher) config, validation and CRUD. A monitor is a routine triggered
 * by a watched SOURCE: it detects a CONDITION change and fires an ACTION, reusing the routines
 * daemon, dispatch and notify path. YAML in ~/.agents/monitors/. */

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

/** Source types a monitor can watch. */
export type MonitorSourceType =
  | 'command'
  | 'poll'
  | 'poll-http'
  | 'webhook'
  | 'ws'
  | 'file'
  | 'device';

/** Webhook source filters — reuse the github/linear matcher shape from triggers/webhook.ts. */
export interface MonitorWebhookSource {
  source: 'github' | 'linear';
  event: string;
  repo?: string;
  branch?: string;
  action?: string;
  teamKey?: string;
  label?: string;
}

/** What a monitor watches. Exactly one source-payload field is populated, keyed by `type`:
 * `command`/`interval` (command/poll), `url`/`interval` (poll-http), `wsUrl` (ws), `path` (file),
 * `device` (device), `webhook` (webhook). */
export interface MonitorSource {
  type: MonitorSourceType;
  /** Shell command whose stdout is the observation (command, poll). */
  command?: string;
  /** Re-evaluation interval (poll, poll-http; optional for command/file/device). e.g. `30s`, `15m`, `8h`. */
  interval?: string;
  /** URL to GET (poll-http). */
  url?: string;
  /** WebSocket URL; each frame is an observation (ws). */
  wsUrl?: string;
  /** File or directory to watch (file). */
  path?: string;
  /** A registered fleet device whose health/reachability is the observation (device). */
  device?: string;
  /** Webhook trigger filters (webhook). */
  webhook?: MonitorWebhookSource;
}

/** How an observation becomes a fire. */
export type MonitorConditionMode = 'on-change' | 'match' | 'every';

export interface MonitorCondition {
  mode: MonitorConditionMode;
  /** Regex (required for `match` mode) — fire when the observation matches. */
  match?: string;
  /** What counts as "the same event" for de-duplication. When set, the signature is the first regex
   * match against the observation (re-observing the same token is silent); otherwise the full
   * observation. */
  dedupeKey?: string;
}

/** Action types a monitor can fire. */
export type MonitorActionType = 'run' | 'routine' | 'notify' | 'webhook-out';

/** What a monitor does on a fire. Shares the run-shaped fields (agent, prompt, mode, effort,
 * timeout) with JobConfig (lib/routines.ts) so dispatch reuses executeJobDetached. The fired event
 * is injected into the prompt as `{event}`. */
export interface ActionConfig {
  type: MonitorActionType;
  /** run: which agent to spawn — a native harness id or a custom harness name (agents harness list). */
  agent?: AgentId | (string & {});
  /** run: the prompt; `{event}` is replaced with the fired event summary. */
  prompt?: string;
  /** run: execution mode (shared with routines). */
  mode?: 'plan' | 'edit' | 'auto' | 'skip' | 'full';
  /** run: reasoning effort (shared with routines). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  /** run: kill the action if it runs longer than this (e.g. `10m`). */
  timeout?: string;
  /** routine: name of an existing routine to fire. */
  routine?: string;
  /** notify: override the owner channel (defaults to `notify.owner.channel`). */
  notifyChannel?: string;
  /** webhook-out: URL to POST the event to. */
  url?: string;
  /** Shell command that must exit 0 after a `run`/`routine` action settles, asserting the effect
   * happened (PHNX-2842), e.g. `gh pr view 1682 --json state --jq .state | grep -qx MERGED`. A
   * failed check makes the fire `ok: false`, not `completed`. Notify/webhook-out refuse it. */
  postcondition?: string;
}

/** Full monitor configuration (persisted as YAML in ~/.agents/monitors/). */
export interface MonitorConfig {
  name: string;
  enabled: boolean;
  source: MonitorSource;
  condition: MonitorCondition;
  action: ActionConfig;
  /** Pin-to-one OWNER device: the single machine whose daemon evaluates the source and fires
   * (exactly-once for v1, no distributed lock). Everywhere else the monitor is inert. */
  device?: string;
  /** Fleet allowlist (advanced): each listed device evaluates and fires independently, like
   * routines' `devices`. Mutually exclusive with `device`. */
  devices?: string[];
  /** Does this monitor's SOURCE poll a fleet-shared queue (PR list, tracker) rather than the firing
   * box's own state? SING-9 switch for an UNPINNED monitor: shared-input fires only on the single
   * owner. System built-ins default to it; user monitors stay fleet-wide. */
  sharedInput?: boolean;
  /** Execute the ACTION on this machine over SSH (placement), distinct from the owner that fires it. */
  runOn?: string;
  /** Working directory for a `run` action, routines-portable (`~/...` or relative to the target's
   * home); defaults to `~`. Without it `run` actions were blocked with `execution_context_missing`
   * since a monitor has no project to supply one (RUSH-2681). */
  cwd?: string;
  /** Firehose guard: auto-pause the monitor if it fires more than `max` times per `per`. */
  rateLimit?: { max: number; per: string };
  /** User-defined prompt variables (expanded like routines' variables). */
  variables?: Record<string, string>;
  /** Pin the agent version for `run` actions (omit to use the run strategy). */
  version?: string;
  /** Which layer this monitor came from: `user` or `system` (built-in mirror). Derived and
   * runtime-only, stamped by `readMonitorFile` and stripped by `writeMonitor`; it tags built-ins
   * in `list`/`view`. */
  scope?: 'user' | 'system';
}

/** A fired event. `summary` is injected into the action prompt as `{event}`; `payload` carries the
 * structured observation for `webhook-out` and inspection. */
export interface MonitorEvent {
  monitorName: string;
  firedAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

/** Default values applied to every monitor config when fields are omitted. */
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

/** Parses a human interval (`30s`, `15m`, `8h`, `1d`, `1h30m`) into ms. Unlike routines'
 * parseTimeout, seconds are supported (polls tick in seconds). Null on empty, unparseable or zero
 * input. */
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

/** True when an UNPINNED monitor must run on a single owner rather than every daemon (SING-9
 * shared-queue double-fire guard). A `device`/`devices` pin is an explicit choice (false). Else a
 * system built-in is shared-input unless `sharedInput: false`; a user monitor only opts IN. */
export function requiresSingleOwner(
  config: Pick<MonitorConfig, 'device' | 'devices' | 'scope' | 'sharedInput'>,
): boolean {
  if (config.device || (config.devices && config.devices.length > 0)) return false;
  if (config.scope === 'system') return config.sharedInput !== false;
  return config.sharedInput === true;
}

/** The single fleet box owning unpinned shared-input monitors; PURE for tests. Priority: configured
 * `interactive.host`; else this box when no OTHER device is registered; else `undefined`: a
 * multi-box fleet with no interactive host fires NOWHERE until pinned. */
export function resolveSharedInputOwner(
  interactiveHost: string | undefined,
  deviceNames: string[],
  self: string,
): string | undefined {
  if (typeof interactiveHost === 'string' && interactiveHost.trim()) {
    return normalizeHost(interactiveHost);
  }
  const others = deviceNames.map((d) => normalizeHost(d)).filter((d) => d && d !== self);
  if (others.length === 0) return self; // single-box fleet: no peer, no race
  return undefined; // multi-box, no interactive host pinned → no safe owner
}

/** Resolve {@link resolveSharedInputOwner} from live config + the device registry. */
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

/** True when the monitor may evaluate and fire here: `device` pins one machine; else `devices`
 * allowlist; else an unpinned SHARED-INPUT monitor fires only on the resolved owner (SING-9); else
 * unrestricted. Names are normalized. `ownerHost` overrides the owner for tests. */
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

/** Count the populated source-payload fields to detect "two sources". */
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

/** Which source-payload field each source type requires. */
const SOURCE_TYPE_FIELD: Record<MonitorSourceType, string> = {
  command: 'command',
  poll: 'command',
  'poll-http': 'url',
  webhook: 'webhook',
  ws: 'wsUrl',
  file: 'path',
  device: 'device',
};

/** Count the populated action-payload fields to detect "two actions". */
function populatedActionFields(action: ActionConfig): string[] {
  const fields: Array<[string, unknown]> = [
    ['agent', action.agent],
    ['routine', action.routine],
    ['url', action.url],
  ];
  return fields.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k]) => k);
}

/** Validates a partial monitor config into human-readable errors; hand-rolled like validateJob, no
 * zod. Rejects: no source, two sources, no action, two actions, match-mode without `match`, plus
 * per-type field checks. */
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

  // ─── SOURCE ───────────────────────────────────────────────────────────────
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
      // Two sources: any populated field that doesn't belong to this type.
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
    // Interval-bearing sources must carry a parseable interval.
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

  // ─── CONDITION ──────────────────────────────────────────────────────────────
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

  // ─── ACTION ─────────────────────────────────────────────────────────────────
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
      // Two actions: a populated field that belongs to a different action type.
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

  // ─── PLACEMENT ───────────────────────────────────────────────────────────────
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

  // ─── HYGIENE ─────────────────────────────────────────────────────────────────
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

/** Reads and normalizes a monitor file. A built-in is enabled by default like every system-layer
 * resource unless shadowed by a user `enabled: false` copy (PHNX-2506). Enabled is not firing
 * everywhere: a shared-input built-in is placed on one owner (SING-9). */
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
      // Enabled unless the user explicitly disables it, the same default for user and system
      // layers. `scope` is stamped below for the (built-in) tag, not to gate enablement.
      enabled: hasEnabled ? parsed.enabled !== false : (MONITOR_DEFAULTS.enabled ?? true),
      scope,
    } as MonitorConfig;
  } catch {
    return null;
  }
}

/** The layered monitor dirs, user before system so user shadows system by name. */
function monitorLayers(): Array<{ scope: 'user' | 'system'; path: string }> {
  return [
    { scope: 'user', path: getMonitorsDir() },
    { scope: 'system', path: getSystemMonitorsDir() },
  ];
}

/** Lists all monitor configs, unioning the user dir (~/.agents/monitors/) over the built-in system
 * dir. The higher layer wins by name, so a user monitor shadows a same-named built-in. */
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

/** Reads one monitor by name from the user dir, then the system dir (a user monitor shadows a
 * built-in). Null if not found or corrupt. */
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

/** Path of a monitor's YAML in the USER dir, or null. User-layer only by design (like getJobPath):
 * `agents monitors edit` writes to it and the system mirror is pull-only, so editing a built-in
 * materializes a user copy via readMonitor(). */
export function getMonitorPath(name: string): string | null {
  const dir = getMonitorsDir();
  for (const ext of ['.yml', '.yaml']) {
    const filePath = safeJoin(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

/** Write a monitor config to disk atomically, omitting fields that match defaults. */
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
  // `scope` is a derived read-time annotation, never part of the on-disk schema —
  // strip it so a materialized user copy of a built-in doesn't persist `scope: system`.
  delete output.scope;
  const devArr = output.devices as string[] | undefined;
  if (!devArr || devArr.length === 0) delete output.devices;

  atomicWriteFileSync(filePath, yaml.stringify(output));
}

/** Delete a monitor config file by name. Returns true if the file existed. */
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

/** Enable or disable a monitor by name. */
export function setMonitorEnabled(name: string, enabled: boolean): void {
  const monitor = readMonitor(name);
  if (!monitor) throw new Error(`Monitor '${name}' not found`);
  monitor.enabled = enabled;
  writeMonitor(monitor);
}
