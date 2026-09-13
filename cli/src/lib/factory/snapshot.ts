/**
 * Read-only Software Factory state aggregation.
 *
 * ~/.agents/factory.yml example:
 *
 * ceiling: 4
 * max_dispatch_per_tick: 2
 * per_project:
 *   Agents CLI: { weight: 2, cap: 2 }
 * idle_boxes: [yosemite-m1, yosemite-m2]
 * digest: { times: ["09:00", "17:00"], tz: America/Los_Angeles }
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'yaml';
import { getActiveSessions, type ActiveSession } from '../session/active.js';
import { serializeActiveSessionsForJson } from '../session/active.js';
import { readAuthHealthCache, type AuthVerdict } from '../auth-health.js';
import { readStatsCache } from '../devices/stats-cache.js';

const execFile = promisify(execFileCallback);

export const FACTORY_PROJECTS = [
  { name: 'Prix', repo: 'phnx-labs/prix' },
  { name: 'Rush App', repo: 'phnx-labs/rush' },
  { name: 'Rush CLI', repo: 'phnx-labs/rush-cli' },
  { name: 'Agents CLI', repo: 'phnx-labs/agi-cli' },
  { name: 'Linear CLI', repo: 'phnx-labs/linear-cli' },
] as const;

export interface FactoryConfig {
  source: 'default' | 'file';
  ceiling: number;
  max_dispatch_per_tick: number;
  per_project: Record<string, { weight: number; cap: number }>;
  idle_boxes: string[];
  digest: { times: string[]; tz: string };
}

export interface FactorySnapshot {
  generatedAt: string;
  sessions: ReturnType<typeof serializeActiveSessionsForJson>;
  queues: Record<string, { todo: number; inProgress: number; blocked: number }>;
  prs: Array<{ repo: string; number: number; ci: string; review: string; mergeable: string }>;
  devices: Array<{ name: string; load: number | null; idle: boolean }>;
  recentRuns: Array<{ routine: string; status: string; durationMs: number | null }>;
  auth: { claude: AuthVerdict | null };
  config: FactoryConfig;
}

interface SnapshotDependencies {
  home: string;
  now: () => Date;
  activeSessions: () => Promise<ActiveSession[]>;
  run: (file: string, args: string[]) => Promise<string>;
  readAuth: () => ReturnType<typeof readAuthHealthCache>;
  readDeviceStats: () => ReturnType<typeof readStatsCache>;
}

const defaults = (): FactoryConfig => ({
  source: 'default',
  ceiling: 4,
  max_dispatch_per_tick: 2,
  per_project: {},
  idle_boxes: [],
  digest: { times: [], tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
});

export function readFactoryConfig(home: string): FactoryConfig {
  const file = path.join(home, '.agents', 'factory.yml');
  if (!fs.existsSync(file)) return defaults();
  const raw = yaml.parse(fs.readFileSync(file, 'utf8')) as Partial<Omit<FactoryConfig, 'source'>> | null;
  if (!raw || typeof raw !== 'object') throw new Error(`${file} must contain a YAML mapping`);
  const base = defaults();
  return {
    source: 'file',
    ceiling: integer(raw.ceiling ?? base.ceiling, 'ceiling'),
    max_dispatch_per_tick: integer(raw.max_dispatch_per_tick ?? base.max_dispatch_per_tick, 'max_dispatch_per_tick'),
    per_project: parseProjectConfig(raw.per_project),
    idle_boxes: stringArray(raw.idle_boxes, 'idle_boxes'),
    digest: raw.digest ? {
      times: stringArray(raw.digest.times, 'digest.times'),
      tz: typeof raw.digest.tz === 'string' ? raw.digest.tz : base.digest.tz,
    } : base.digest,
  };
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`factory.yml ${name} must be a non-negative integer`);
  return value as number;
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`factory.yml ${name} must be a string array`);
  return value;
}

function parseProjectConfig(value: unknown): FactoryConfig['per_project'] {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('factory.yml per_project must be a mapping');
  return Object.fromEntries(Object.entries(value).map(([name, item]) => {
    const record = item as Record<string, unknown>;
    return [name, { weight: integer(record?.weight, `per_project.${name}.weight`), cap: integer(record?.cap, `per_project.${name}.cap`) }];
  }));
}

function json(text: string): unknown {
  return JSON.parse(text);
}

function issueCount(payload: unknown): number {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.count === 'number') return record.count;
    if (Array.isArray(record.issues)) return record.issues.length;
  }
  return 0;
}

export function queueCounts(todoPayload: unknown, openPayload: unknown): FactorySnapshot['queues'][string] {
  const issues = openPayload && typeof openPayload === 'object' && Array.isArray((openPayload as Record<string, unknown>).issues)
    ? (openPayload as { issues: Array<Record<string, unknown>> }).issues : [];
  const blocked = issues.filter((issue) => {
    const state = issue.state && typeof issue.state === 'object' ? issue.state as Record<string, unknown> : {};
    const labels = issue.labels && typeof issue.labels === 'object' && Array.isArray((issue.labels as Record<string, unknown>).nodes)
      ? (issue.labels as { nodes: Array<Record<string, unknown>> }).nodes : [];
    return String(state.name ?? '').toLowerCase().includes('block') || labels.some((label) => String(label.name ?? '').toLowerCase() === 'blocked');
  }).length;
  const inProgress = issues.filter((issue) => {
    const state = issue.state && typeof issue.state === 'object' ? issue.state as Record<string, unknown> : {};
    return String(state.type ?? '').toLowerCase() === 'started' && !String(state.name ?? '').toLowerCase().includes('block');
  }).length;
  return { todo: issueCount(todoPayload), inProgress, blocked };
}

export function parsePullRequests(repo: string, payload: unknown): FactorySnapshot['prs'] {
  if (!Array.isArray(payload)) return [];
  return payload.map((raw) => {
    const pr = raw as Record<string, unknown>;
    const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup as Array<Record<string, unknown>> : [];
    const states = checks.map((check) => String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase());
    const ci = states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(s)) ? 'failing'
      : states.some((s) => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS'].includes(s)) ? 'pending'
        : states.length > 0 ? 'passing' : 'none';
    return {
      repo,
      number: Number(pr.number),
      ci,
      review: String(pr.reviewDecision ?? 'none').toLowerCase(),
      mergeable: String(pr.mergeable ?? 'unknown').toLowerCase(),
    };
  });
}

export function parseDevices(payload: unknown, cached: ReturnType<typeof readStatsCache> = {}): FactorySnapshot['devices'] {
  const rows = Array.isArray(payload) ? payload : [];
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const name = String(row.name ?? row.host ?? '');
    const stats = row.stats && typeof row.stats === 'object' ? row.stats as Record<string, unknown> : cached[name] as unknown as Record<string, unknown> ?? row;
    const candidate = stats.loadPercent ?? stats.load ?? stats.loadPct;
    const load = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
    return { name, load, idle: row.idle === true || (load !== null && load < 20) };
  }).filter((row) => row.name.length > 0);
}

function readRecentRuns(home: string, limit = 3): FactorySnapshot['recentRuns'] {
  const root = path.join(home, '.agents', '.history', 'runs');
  if (!fs.existsSync(root)) return [];
  const found: Array<FactorySnapshot['recentRuns'][number] & { mtime: number }> = [];
  for (const routine of fs.readdirSync(root)) {
    const routineDir = path.join(root, routine);
    if (!fs.statSync(routineDir).isDirectory()) continue;
    const routineRuns: typeof found = [];
    for (const run of fs.readdirSync(routineDir)) {
      const file = path.join(routineDir, run, 'meta.json');
      if (!fs.existsSync(file)) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        const started = Date.parse(String(meta.startedAt ?? meta.createdAt ?? ''));
        const ended = Date.parse(String(meta.finishedAt ?? meta.completedAt ?? meta.updatedAt ?? ''));
        const duration = typeof meta.durationMs === 'number' ? meta.durationMs : Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null;
        routineRuns.push({ routine, status: String(meta.status ?? 'unknown'), durationMs: duration, mtime: fs.statSync(file).mtimeMs });
      } catch { /* A concurrently-written or malformed run is not a completed outcome. */ }
    }
    found.push(...routineRuns.sort((a, b) => b.mtime - a.mtime).slice(0, limit));
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _, ...run }) => run);
}

function latestClaudeVerdict(entries: ReturnType<typeof readAuthHealthCache>): AuthVerdict | null {
  return Object.entries(entries)
    .filter(([key]) => key.split(':').includes('claude'))
    .map(([, value]) => value)
    .sort((a, b) => b.checkedAt - a.checkedAt)[0]?.verdict ?? null;
}

export async function buildFactorySnapshot(overrides: Partial<SnapshotDependencies> = {}): Promise<FactorySnapshot> {
  const deps: SnapshotDependencies = {
    home: os.homedir(),
    now: () => new Date(),
    activeSessions: () => getActiveSessions(),
    run: async (file, args) => (await execFile(file, args, { maxBuffer: 10 * 1024 * 1024 })).stdout,
    readAuth: readAuthHealthCache,
    readDeviceStats: readStatsCache,
    ...overrides,
  };
  const linear = path.join(deps.home, '.agents', 'skills', 'linear', 'scripts', 'linear');
  const safeRun = async (file: string, args: string[]): Promise<unknown> => {
    try { return json(await deps.run(file, args)); } catch { return null; }
  };

  const sessionsPromise = deps.activeSessions().then(serializeActiveSessionsForJson);
  const queuePromise = Promise.all(FACTORY_PROJECTS.map(async ({ name }) => {
    const query = (status: string) => safeRun(linear, ['tasks', '--project', name, '--label', 'pilot', '--status', status, '--cycle', 'all', '--all', '--json']);
    const [todo, open] = await Promise.all([query('todo'), query('open')]);
    return [name, queueCounts(todo, open)] as const;
  })).then(Object.fromEntries);
  const prsPromise = Promise.all(FACTORY_PROJECTS.map(async ({ repo }) => parsePullRequests(repo, await safeRun('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title,statusCheckRollup,reviewDecision,mergeable'])))).then((rows) => rows.flat());
  // `devices list --json` is the registry's read-only JSON surface. Load comes
  // from the daemon-warmed cache so snapshot never probes or writes reachability.
  const devicesPromise = safeRun('agents', ['devices', 'list', '--json']).then((payload) => parseDevices(payload, deps.readDeviceStats()));

  const [sessions, queues, prs, devices] = await Promise.all([sessionsPromise, queuePromise, prsPromise, devicesPromise]);
  return {
    generatedAt: deps.now().toISOString(), sessions, queues, prs, devices,
    recentRuns: readRecentRuns(deps.home), auth: { claude: latestClaudeVerdict(deps.readAuth()) },
    config: readFactoryConfig(deps.home),
  };
}
