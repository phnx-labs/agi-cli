
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { getDaemonConfigDir } from './state.js';
import { atomicWriteFileSync } from './fs-atomic.js';

export type DaemonServiceId =
  | 'scheduler'
  | 'catchup'
  | 'webhook-receiver'
  | 'self-heal'
  | 'self-update'
  | 'account-state'
  | 'account-auth'
  | 'watchdog'
  | 'device-probe'
  | 'state-dir-check'
  | 'session-index'
  | 'session-title'
  | 'auth-sync'
  | 'usage-sync'
  | 'daemon-heartbeat'
  | 'tmux-reap'
  | 'session-state'
  | 'feed-stream'
  | 'session-summarizer'
  | 'attention-notify'
  | 'recordings'
  | 'harness-update';

interface DaemonServiceDef {
  id: DaemonServiceId;
  title: string;
  description: string;
  defaultEnabled?: boolean;
}

export const DAEMON_SERVICES: DaemonServiceDef[] = [
  {
    id: 'scheduler',
    title: 'Routine scheduler',
    description: 'Fires cron-scheduled routines and catches up missed fires.',
  },
  {
    id: 'catchup',
    title: 'Catch-up recovery',
    description: 'Supervised pass that re-runs routines whose scheduled fire this device missed (sleep, wedge, or suspend). No-ops while the scheduler gate is off.',
  },
  {
    id: 'webhook-receiver',
    title: 'Webhook receiver',
    description: 'Hosts signed GitHub/Linear webhook ingress declared in daemon/webhooks.yaml, drawing signing secrets from the standalone secrets CLI; binds nothing when no receivers are declared.',
  },
  {
    id: 'self-heal',
    title: 'Self-heal registry',
    description: 'Repairs shims, PATH, shadowing, and resource drift on a schedule.',
  },
  {
    id: 'self-update',
    title: 'Self-update',
    description: 'Checks npm for a newer agents-cli, installs + verifies it, then exits so the OS supervisor relaunches onto the new code (PHNX-3695).',
  },
  {
    id: 'account-state',
    title: 'Account usage refresh',
    description: 'Refreshes account quota/usage on its own tick (PHNX-3608: independent circuit breaker from account-auth).',
  },
  {
    id: 'account-auth',
    title: 'Account auth refresh',
    description: 'Publishes this host\'s fleet-status row and refreshes auth health on its own slower tick (PHNX-3608: independent circuit breaker from account-state).',
  },
  {
    id: 'watchdog',
    title: 'Watchdog',
    description: 'Nudges stalled agent sessions on this host when opted in via watchdog.enabled.',
  },
  {
    id: 'device-probe',
    title: 'Device probe',
    description: 'Discovers Tailscale devices and surfaces pending ones for registration.',
  },
  {
    id: 'state-dir-check',
    title: 'State-dir self-check',
    description: 'Self-terminates the daemon if its state directory is removed.',
  },
  {
    id: 'daemon-heartbeat',
    title: 'Daemon heartbeat',
    description: 'Publishes daemon liveness and reconciles routine process state.',
  },
  {
    id: 'tmux-reap',
    title: 'Tmux reap',
    description: 'Reaps dead managed tmux sessions and their orphaned helper processes.',
  },
  {
    id: 'session-state',
    title: 'Live session state',
    description: 'Publishes this host\'s active session metadata for sessions watch and fleet consumers.',
  },
  {
    id: 'feed-stream',
    title: 'Shared feed stream',
    description: 'Owns the one fleet feed fan-out and serves it to every reader over a socket, so N consumers cost one ssh per peer instead of N.',
  },
  {
    id: 'session-index',
    title: 'Session-index warm',
    description: 'Keeps this host\'s transcript index current so a locally-started session is discoverable within seconds.',
  },
  {
    id: 'session-summarizer',
    title: 'Session summarizer',
    description: 'Computes a per-session goal / progress checkpoints / checklist off the request path and delivers them on the session stream. Off unless summarizer.enabled and a local model endpoint are configured (PHNX-3939).',
  },
  {
    id: 'attention-notify',
    title: 'Attention desktop banners',
    description: 'Posts one actionable desktop banner per new attention item (question / permission / plan review / stall) so the macOS helper can answer it through agents feed answer (PHNX-4004).',
  },
  {
    id: 'recordings',
    title: 'CleanShot recording publisher',
    description: 'Publishes settled CleanShot videos as organization-only artifacts. Off until enabled by `agents recordings watch`.',
    defaultEnabled: false,
  },
  {
    id: 'session-title',
    title: 'Session titles',
    description: 'Generates the short technical title shown as each session row\'s headline, once per session, with a cheap model — so a row is named by what the user asked for, never by the agent\'s latest message.',
  },
  {
    id: 'auth-sync',
    title: 'Auth bundle sync',
    description: 'Pushes the reserved file-backed auth bundle (setup-tokens) to pinned fleet devices that do not yet have it.',
  },
  {
    id: 'usage-sync',
    title: 'Usage snapshot sync',
    description: 'Bidirectional per-account usage sync: a headed personal/desktop box pushes its snapshot to worker peers, and a worker with a stale cache pulls from the primary — so workers that cannot read the endpoint themselves still route by real capacity.',
  },
  {
    id: 'harness-update',
    title: 'Harness auto-update',
    description: 'Moves eligible, non-pinned npm-package harness installations (Claude, Codex, …) to their latest release via a bounded child process, subject to updates.auto / updates.<agent>.auto and each installation\'s own update policy (PHNX-3940).',
  },
];

export const DAEMON_SERVICE_IDS: DaemonServiceId[] = DAEMON_SERVICES.map((s) => s.id);

export interface DaemonServicesConfig {
  services: Record<DaemonServiceId, boolean>;
}

function defaultServicesConfig(): DaemonServicesConfig {
  const services = {} as Record<DaemonServiceId, boolean>;
  for (const service of DAEMON_SERVICES) services[service.id] = service.defaultEnabled !== false;
  return { services };
}

export function getDaemonServicesConfigPath(): string {
  return path.join(getDaemonConfigDir(), 'services.yaml');
}

export function readDaemonServicesConfig(): DaemonServicesConfig {
  const cfg = defaultServicesConfig();
  try {
    const raw = fs.readFileSync(getDaemonServicesConfigPath(), 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object') {
      for (const id of DAEMON_SERVICE_IDS) {
        const value = (parsed.services as Record<string, unknown>)[id];
        if (typeof value === 'boolean') cfg.services[id] = value;
      }
    }
  } catch {
  }
  return cfg;
}

export function writeDaemonServicesConfig(cfg: DaemonServicesConfig): void {
  const dir = getDaemonConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = getDaemonServicesConfigPath();

  let preserved: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') preserved = parsed;
  } catch {
  }

  const services: Record<string, boolean> = {};
  for (const service of DAEMON_SERVICES) {
    services[service.id] = cfg.services[service.id] ?? service.defaultEnabled !== false;
  }

  const out = yaml.stringify({ ...preserved, services }, { sortMapEntries: false });
  atomicWriteFileSync(filePath, out, 'utf-8');
}

export function isDaemonServiceEnabled(id: DaemonServiceId): boolean {
  return readDaemonServicesConfig().services[id] !== false;
}

export function setDaemonServiceEnabled(id: DaemonServiceId, enabled: boolean): DaemonServicesConfig {
  const cfg = readDaemonServicesConfig();
  cfg.services[id] = enabled;
  writeDaemonServicesConfig(cfg);
  return cfg;
}

export function listDaemonServiceStates(): Array<DaemonServiceDef & { enabled: boolean }> {
  const cfg = readDaemonServicesConfig();
  return DAEMON_SERVICES.map((s) => ({ ...s, enabled: cfg.services[s.id] }));
}

function getDaemonServiceActionsPath(): string {
  return path.join(getDaemonConfigDir(), 'service-actions.json');
}

export function queueDaemonServiceRestart(id: DaemonServiceId): void {
  const filePath = getDaemonServiceActionsPath();
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { restart?: string[] };
    if (Array.isArray(parsed.restart)) ids = parsed.restart;
  } catch {
  }
  if (!ids.includes(id)) ids.push(id);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFileSync(filePath, JSON.stringify({ restart: ids }), 'utf-8');
}

export function drainDaemonServiceRestartQueue(): DaemonServiceId[] {
  const filePath = getDaemonServiceActionsPath();
  let ids: DaemonServiceId[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { restart?: DaemonServiceId[] };
    if (Array.isArray(parsed.restart)) ids = parsed.restart;
  } catch {
    return [];
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
  }
  return ids;
}
