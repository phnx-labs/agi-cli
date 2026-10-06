import { showFile } from '../open-url.js';
import * as fs from 'fs';
import { formatBytes } from '../format.js';
export { formatBytes };
import * as path from 'path';

import { getBrowserRuntimeDir, getProfileRuntimeDir, listProfileCacheDirs, profileOfCacheKey } from './paths.js';
import { formatRelativeTime } from '../session/relative-time.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { getSessionById, listBrowserSessionRecords, pruneToolSessions } from '../session/db.js';
import Database from '../sqlite.js';
import { getHistoryDir } from '../state.js';
import { listPidSessionEntries } from '../session/pid-registry.js';
import { loadHookSessionIndex } from '../session/hook-sessions.js';
import { readRecentActivity } from '../feed/activity.js';

export type ArtifactKind = 'screenshot' | 'pdf' | 'recording' | 'download';

export interface BrowserArtifact {
  kind: ArtifactKind;
  task?: string;
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface ProfileArtifacts {
  profile: string;
  artifacts: BrowserArtifact[];
}

const EXT_KIND: Record<string, ArtifactKind> = {
  '.png': 'screenshot',
  '.jpg': 'screenshot',
  '.jpeg': 'screenshot',
  '.webp': 'screenshot',
  '.pdf': 'pdf',
  '.webm': 'recording',
};

function statSafe(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function walkFiles(dir: string): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkFiles(full));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function listTaskArtifacts(dir: string, task: string): BrowserArtifact[] {
  const artifacts: BrowserArtifact[] = [];
  for (const file of walkFiles(dir)) {
    const kind = EXT_KIND[path.extname(file).toLowerCase()];
    if (!kind) continue;
    const st = statSafe(file);
    if (!st) continue;
    artifacts.push({ kind, task, name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return artifacts;
}

function listProfileArtifacts(profile: string): BrowserArtifact[] {
  const root = getProfileRuntimeDir(profile);
  const artifacts: BrowserArtifact[] = [];

  const sessionsRoot = path.join(root, 'sessions');
  let taskDirs: fs.Dirent[] = [];
  try { taskDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch {  }
  for (const t of taskDirs) {
    if (t.isDirectory()) artifacts.push(...listTaskArtifacts(path.join(sessionsRoot, t.name), t.name));
  }

  for (const file of walkFiles(path.join(root, 'downloads'))) {
    const st = statSafe(file);
    if (!st) continue;
    artifacts.push({ kind: 'download', name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }

  artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return artifacts;
}

function listBrowserSessions(only?: string): ProfileArtifacts[] {
  let profiles: string[];
  if (only) {
    const dirs = listProfileCacheDirs(only).map((d) => path.basename(d));
    profiles = dirs.length > 0 ? dirs : [only];
  } else {
    try {
      profiles = fs.readdirSync(getBrowserRuntimeDir(), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'sessions')
        .map((e) => e.name)
        .sort();
    } catch {
      profiles = [];
    }
  }
  return profiles
    .map((p) => ({ profile: p, artifacts: listProfileArtifacts(p) }))
    .filter((r) => !!only || r.artifacts.length > 0);
}

function countByKind(artifacts: BrowserArtifact[]): Record<ArtifactKind, number> {
  const counts = { screenshot: 0, pdf: 0, recording: 0, download: 0 } as Record<ArtifactKind, number>;
  for (const a of artifacts) counts[a.kind]++;
  return counts;
}

export function renderBrowserSessions(groups: ProfileArtifacts[]): string {
  if (groups.length === 0) return 'No browser profiles found.';
  const lines: string[] = [];
  for (const g of groups) {
    const counts = countByKind(g.artifacts);
    lines.push(
      `${g.profile}  ` +
      `screenshots ${counts.screenshot}  pdfs ${counts.pdf}  recordings ${counts.recording}  downloads ${counts.download}`
    );
    if (g.artifacts.length === 0) {
      lines.push('  (no captures yet)');
      continue;
    }
    for (const a of g.artifacts) {
      const when = formatRelativeTime(new Date(a.mtimeMs).toISOString());
      const where = a.kind === 'download' ? 'downloads/' : `sessions/${a.task}/`;
      lines.push(`  ${when.padEnd(12)}  ${a.name.padEnd(28)}  ${formatBytes(a.bytes).padStart(8)}  ${where}`);
    }
  }
  return lines.join('\n');
}

export function resolveArtifact(groups: ProfileArtifacts[], selector: string): string | null {
  const all = groups.flatMap((g) => g.artifacts).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (all.length === 0) return null;
  if (selector === 'latest') return all[0].path;
  const hit = all.find((a) => a.name === selector) ?? all.find((a) => a.name.includes(selector));
  return hit ? hit.path : null;
}




export interface TaskIdentity {
  owner?: string;
  launchId?: string;
  sessionId?: string;
  startedAt?: number;
  lastActivity?: number;
  machine?: string;
  captureDir?: string;
  capturesRemote?: string;
  counts?: Partial<Record<ArtifactKind, number>>;
}

export interface BrowserTaskSummary extends Omit<TaskIdentity, 'owner'> {
  profile: string;
  task: string;
  actor?: string;
  startedAt: number;
  lastActivity: number;
}

export const BROWSER_HISTORY_LIMIT = 2000;

export function nativeBrowserHistoryPath(): string {
  return path.join(getHistoryDir(), 'browser', 'history.db');
}

const SUMMARY_TEXT_FIELDS = ['actor', 'sessionId', 'launchId', 'machine', 'captureDir', 'capturesRemote'] as const;
const COUNT_KINDS: ArtifactKind[] = ['screenshot', 'pdf', 'recording', 'download'];

function parseSummary(file: string, raw: string): BrowserTaskSummary {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`unreadable browser history record in ${file}: ${(error as Error).message}`); }
  const r = value as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r.profile !== 'string' || typeof r.task !== 'string'
    || !Number.isFinite(r.startedAt) || !Number.isFinite(r.lastActivity)) {
    throw new Error(`unexpected browser history record in ${file}: needs profile, task and finite timestamps`);
  }
  const summary: BrowserTaskSummary = {
    profile: r.profile, task: r.task, startedAt: r.startedAt as number, lastActivity: r.lastActivity as number,
  };
  for (const key of SUMMARY_TEXT_FIELDS) {
    if (typeof r[key] === 'string') summary[key] = r[key] as string;
  }
  if (r.counts && typeof r.counts === 'object') {
    const counts: Partial<Record<ArtifactKind, number>> = {};
    for (const kind of COUNT_KINDS) {
      const n = (r.counts as Record<string, unknown>)[kind];
      if (Number.isFinite(n)) counts[kind] = n as number;
    }
    summary.counts = counts;
  }
  return summary;
}

/**
 * The standalone browser's own task history (`.history/browser/history.db`,
 * written by @phnx-labs/browser-cli `task-history.ts`). Opened read-only so a
 * read never checkpoints the writer's WAL; an absent file is an empty history,
 * any other failure throws so a feed snapshot reports itself incomplete.
 */
export function readNativeBrowserHistory(file = nativeBrowserHistoryPath(), limit = BROWSER_HISTORY_LIMIT): BrowserTaskSummary[] {
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readOnly: true });
  try {
    const rows = db.prepare('SELECT record FROM tasks ORDER BY last_activity DESC LIMIT ?').all(limit) as { record: string }[];
    return rows.map((row) => parseSummary(file, row.record));
  } finally {
    db.close();
  }
}

function belongsToProfile(key: string, profile: string | undefined): boolean {
  return !profile || key === profile || profileOfCacheKey(key) === profile;
}

/**
 * One summary per profile+task: native history first, the agents-recorded
 * `browser_sessions` row only for what native history does not say. Neither
 * store is written.
 */
export function readBrowserTaskHistory(profile?: string): BrowserTaskSummary[] {
  const merged = new Map<string, BrowserTaskSummary>();
  const key = (s: { profile: string; task: string }) => `${s.profile}\0${s.task}`;
  for (const legacy of listBrowserSessionRecords(undefined, { limit: BROWSER_HISTORY_LIMIT })) {
    if (!belongsToProfile(legacy.profile, profile) || legacy.startedAt === undefined) continue;
    merged.set(key(legacy), { ...legacy, startedAt: legacy.startedAt, lastActivity: legacy.lastActivity ?? legacy.startedAt });
  }
  for (const native of readNativeBrowserHistory()) {
    if (!belongsToProfile(native.profile, profile)) continue;
    const legacy = merged.get(key(native));
    merged.set(key(native), legacy ? { ...legacy, ...native } : native);
  }
  return [...merged.values()];
}

export function loadTaskIdentities(profile: string): Map<string, TaskIdentity> {
  const out = new Map<string, TaskIdentity>();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(getProfileRuntimeDir(profile), 'tasks.json'), 'utf8');
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const t = value as Record<string, unknown>;
    out.set(name, {
      owner: typeof t.owner === 'string' ? t.owner : undefined,
      launchId: typeof t.launchId === 'string' ? t.launchId : undefined,
      sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
    });
  }
  return out;
}

export function loadDurableTaskIdentities(profile: string, history = readBrowserTaskHistory(profile)): Map<string, TaskIdentity> {
  const merged = new Map<string, TaskIdentity>();
  for (const record of history) {
    if (record.profile !== profile) continue;
    const { actor, profile: _profile, task: _task, ...rest } = record;
    merged.set(record.task, { ...rest, owner: actor });
  }
  for (const [task, live] of loadTaskIdentities(profile)) {
    const durable = merged.get(task);
    merged.set(task, {
      ...durable,
      owner: live.owner ?? durable?.owner,
      launchId: live.launchId ?? durable?.launchId,
      sessionId: live.sessionId ?? durable?.sessionId,
    });
  }
  return merged;
}

export interface LaunchSessionIndex {
  byLaunchId: Map<string, string>;
}

export function buildLaunchSessionIndex(): LaunchSessionIndex {
  const byLaunchId = new Map<string, string>();
  for (const ev of readRecentActivity({ maxBytesPerSession: 64 * 1024 })) {
    if (ev.launchId && ev.sessionId) byLaunchId.set(ev.launchId, ev.sessionId);
  }
  for (const [launchId, rec] of loadHookSessionIndex().byLaunchId) {
    if (rec.session_id) byLaunchId.set(launchId, rec.session_id);
  }
  for (const entry of listPidSessionEntries()) {
    if (entry.launchId && entry.sessionId) byLaunchId.set(entry.launchId, entry.sessionId);
  }
  return { byLaunchId };
}

export function resolveLaunchSession(index: LaunchSessionIndex, launchId: string): SessionMeta | null {
  const sessionId = index.byLaunchId.get(launchId);
  return sessionId ? getSessionById(sessionId) : null;
}

export type BrowserSessionLinkStatus = 'linked' | 'unresolved' | 'unlinked';

export interface BrowserSessionRow {
  kind: 'task' | 'downloads';
  profile: string;
  task?: string;
  owner?: string;
  launchId?: string;
  sessionId?: string;
  linkStatus: BrowserSessionLinkStatus;
  linkedSession?: SessionMeta;
  artifacts: BrowserArtifact[];
  counts: Record<ArtifactKind, number>;
  latestMtimeMs: number;
  startedAt?: number;
  machine?: string;
  captureDir?: string;
  capturesRemote?: string;
}

function mergeCounts(found: Record<ArtifactKind, number>, recorded: Partial<Record<ArtifactKind, number>> | undefined): Record<ArtifactKind, number> {
  const out = { ...found };
  for (const kind of COUNT_KINDS) out[kind] = Math.max(found[kind], recorded?.[kind] ?? 0);
  return out;
}

export function groupIntoRows(
  groups: ProfileArtifacts[],
  taskIdentities: Map<string, Map<string, TaskIdentity>>,
  resolveLaunch?: (launchId: string) => SessionMeta | null,
  resolveSession?: (sessionId: string) => SessionMeta | null,
): BrowserSessionRow[] {
  const rows: BrowserSessionRow[] = [];
  for (const g of groups) {
    const identities = taskIdentities.get(g.profile) ?? new Map<string, TaskIdentity>();
    const byTask = new Map<string, BrowserArtifact[]>();
    const downloads: BrowserArtifact[] = [];
    for (const a of g.artifacts) {
      if (a.kind === 'download' || !a.task) {
        downloads.push(a);
        continue;
      }
      const list = byTask.get(a.task) ?? [];
      list.push(a);
      byTask.set(a.task, list);
    }
    for (const task of identities.keys()) {
      if (!byTask.has(task)) byTask.set(task, []);
    }
    for (const [task, artifacts] of byTask) {
      artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const identity = identities.get(task);
      let linkedSession: SessionMeta | null = null;
      if (identity?.sessionId && resolveSession) linkedSession = resolveSession(identity.sessionId);
      if (!linkedSession && identity?.launchId && resolveLaunch) {
        linkedSession = resolveLaunch(identity.launchId);
      }
      const hasIdentityKey = !!(identity?.sessionId || identity?.launchId);
      rows.push({
        kind: 'task',
        profile: g.profile,
        task,
        owner: identity?.owner,
        launchId: identity?.launchId,
        sessionId: identity?.sessionId,
        linkStatus: linkedSession ? 'linked' : hasIdentityKey ? 'unresolved' : 'unlinked',
        linkedSession: linkedSession ?? undefined,
        artifacts,
        counts: mergeCounts(countByKind(artifacts), identity?.counts),
        latestMtimeMs: Math.max(artifacts[0]?.mtimeMs ?? 0, identity?.lastActivity ?? 0),
        ...(identity?.startedAt !== undefined ? { startedAt: identity.startedAt } : {}),
        ...(identity?.machine ? { machine: identity.machine } : {}),
        ...(identity?.captureDir ? { captureDir: identity.captureDir } : {}),
        ...(identity?.capturesRemote ? { capturesRemote: identity.capturesRemote } : {}),
      });
    }
    if (downloads.length > 0) {
      downloads.sort((a, b) => b.mtimeMs - a.mtimeMs);
      rows.push({
        kind: 'downloads',
        profile: g.profile,
        linkStatus: 'unlinked',
        artifacts: downloads,
        counts: countByKind(downloads),
        latestMtimeMs: downloads[0]?.mtimeMs ?? 0,
      });
    }
  }
  rows.sort((a, b) => b.latestMtimeMs - a.latestMtimeMs);
  return rows;
}

/** Task-first rows from captures, browser history and live task state. Reads only. */
export function readBrowserSessionRows(profile?: string): BrowserSessionRow[] {
  const groups = listBrowserSessions(profile);
  const history = readBrowserTaskHistory(profile);
  const byProfile = new Map(groups.map((g) => [g.profile, g]));
  for (const record of history) {
    let group = byProfile.get(record.profile);
    if (!group) {
      group = { profile: record.profile, artifacts: listProfileArtifacts(record.profile) };
      byProfile.set(record.profile, group);
      groups.push(group);
    }
    if (record.captureDir && !record.capturesRemote) {
      const known = new Set(group.artifacts.map((a) => a.path));
      group.artifacts.push(...listTaskArtifacts(record.captureDir, record.task).filter((a) => !known.has(a.path)));
    }
  }
  const taskIdentities = new Map(groups.map((g) => [g.profile, loadDurableTaskIdentities(g.profile, history)]));
  const index = buildLaunchSessionIndex();
  return groupIntoRows(
    groups,
    taskIdentities,
    (launchId) => resolveLaunchSession(index, launchId),
    (sessionId) => getSessionById(sessionId),
  );
}

export function buildBrowserSessionRows(profile?: string): BrowserSessionRow[] {
  try { pruneToolSessions(); } catch {  }
  return readBrowserSessionRows(profile);
}

export function matchesBrowserSessionRow(row: BrowserSessionRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.task?.toLowerCase().includes(q)) return true;
  if (row.profile.toLowerCase().includes(q)) return true;
  if (row.kind === 'downloads' && 'downloads'.includes(q)) return true;
  const s = row.linkedSession;
  if (s && (s.agent.toLowerCase().includes(q) || s.topic?.toLowerCase().includes(q) || s.label?.toLowerCase().includes(q))) {
    return true;
  }
  return row.artifacts.some((a) => a.name.toLowerCase().includes(q));
}

export async function runBrowserSessions(opts: { profile?: string; open?: string | boolean; json?: boolean }): Promise<void> {
  const groups = listBrowserSessions(opts.profile);

  if (opts.open !== undefined && opts.open !== false) {
    const selector = opts.open === true ? 'latest' : opts.open;
    const target = resolveArtifact(groups, selector);
    if (!target) {
      console.error(`No capture matching "${selector}".`);
      process.exit(1);
    }
    console.log(target);
    if ((await showFile(target)).via === 'none') {
      console.error(`Could not open ${target}`);
      process.exit(1);
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(groups, null, 2));
    return;
  }

  console.log(renderBrowserSessions(groups));
}
