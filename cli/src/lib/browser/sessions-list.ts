/**
 * Read-only listing of a browser profile's on-disk captures — screenshots, PDFs,
 * recordings (`<profile>/sessions/<task>/`) and downloads (`<profile>/downloads/`).
 * Reads straight from `.cache/browser/<profile>/`, so it works whether or not the
 * browser daemon is running. Backs both `agents browser sessions` and the
 * `agents sessions --browser` alias.
 *
 * Also owns the task-first grouping (RUSH-2407): browser captures are per-task
 * (`sessions/<task>/`), and a task persists `owner`/`launchId` in `tasks.json`
 * while it is live (see service.ts `resolveTaskIdentity`). This module groups
 * artifacts by task and, when a launchId is available, resolves it to the
 * agent session that ran it — reusing the session index (`getSessionById`) and
 * the same launchId join keys the rest of the CLI already uses for this exact
 * problem (pid registry, the SessionStart hook index, the activity log; see
 * `feed-post.ts` `resolvePostIdentity`), never a second parser.
 */
import { showFile } from '../open-url.js';
import * as fs from 'fs';
import { formatBytes } from '../format.js';
// Re-exported for the picker, which lists artifacts from this module's rows.
export { formatBytes };
import * as path from 'path';

import { getBrowserRuntimeDir, getProfileRuntimeDir } from './profiles.js';
import { listProfileCacheDirs } from './runtime-state.js';
import { formatRelativeTime } from '../session/relative-time.js';
import type { SessionMeta } from '../session/types.js';
import { getSessionById, listBrowserSessionRecords, pruneToolSessions } from '../session/db.js';
import { listPidSessionEntries } from '../session/pid-registry.js';
import { loadHookSessionIndex } from '../session/hook-sessions.js';
import { readRecentActivity } from '../feed/activity.js';

export type ArtifactKind = 'screenshot' | 'pdf' | 'recording' | 'download';

export interface BrowserArtifact {
  kind: ArtifactKind;
  /** Owning task for session captures; undefined for downloads. */
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

/** Every capture for one profile, newest first. */
function listProfileArtifacts(profile: string): BrowserArtifact[] {
  const root = getProfileRuntimeDir(profile);
  const artifacts: BrowserArtifact[] = [];

  const sessionsRoot = path.join(root, 'sessions');
  let taskDirs: fs.Dirent[] = [];
  try { taskDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { /* none */ }
  for (const t of taskDirs) {
    if (!t.isDirectory()) continue;
    for (const file of walkFiles(path.join(sessionsRoot, t.name))) {
      const kind = EXT_KIND[path.extname(file).toLowerCase()];
      if (!kind) continue;
      const st = statSafe(file);
      if (!st) continue;
      artifacts.push({ kind, task: t.name, name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }

  for (const file of walkFiles(path.join(root, 'downloads'))) {
    const st = statSafe(file);
    if (!st) continue;
    artifacts.push({ kind: 'download', name: path.basename(file), path: file, bytes: st.size, mtimeMs: st.mtimeMs });
  }

  artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return artifacts;
}

/**
 * Captures grouped by profile. With `only` set, returns just that profile (even
 * when empty); otherwise every profile dir on disk that has at least one capture.
 */
function listBrowserSessions(only?: string): ProfileArtifacts[] {
  let profiles: string[];
  if (only) {
    // A profile's live tasks/captures may live under a composite runtime dir
    // (`<name>@<device>`, `<name>@endpoint-N`, forks) — NOT the bare `<name>`
    // dir. Resolve `only` to every cache dir that belongs to it, the same rule
    // status()/findTask use (keyBelongsToProfile), so `--profile comet-local`
    // surfaces the real `comet-local@zion` store instead of the empty legacy
    // dir. Keep the requested name when nothing exists on disk yet so a fresh
    // profile still returns its (empty) entry rather than vanishing.
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

/** Per-kind counts over a flat artifact list — shared by the printed table and
 *  the interactive row labels. */
function countByKind(artifacts: BrowserArtifact[]): Record<ArtifactKind, number> {
  const counts = { screenshot: 0, pdf: 0, recording: 0, download: 0 } as Record<ArtifactKind, number>;
  for (const a of artifacts) counts[a.kind]++;
  return counts;
}

/** Human table for the CLI. Returns lines (no trailing newline). */
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

/**
 * Resolve `--open <sel>`: `latest` (newest across the groups) or a filename
 * substring match. Returns the absolute path, or null if nothing matched.
 */
export function resolveArtifact(groups: ProfileArtifacts[], selector: string): string | null {
  const all = groups.flatMap((g) => g.artifacts).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (all.length === 0) return null;
  if (selector === 'latest') return all[0].path;
  const hit = all.find((a) => a.name === selector) ?? all.find((a) => a.name.includes(selector));
  return hit ? hit.path : null;
}



// ─── Task-first grouping (RUSH-2407) ───────────────────────────────────────

/** The identity fields this module cares about for one task. */
export interface TaskIdentity {
  owner?: string;
  launchId?: string;
  /**
   * The agent session that drove the task. Primary identity: it is carried by
   * every agent process, whereas a launch id is present on a minority of them.
   * Sourced from the durable `browser_sessions` row, which survives task stop —
   * `tasks.json` never records it beyond the task's own lifetime (RUSH-2549).
   */
  sessionId?: string;
}

/**
 * Read a profile's `tasks.json` for the identity of its CURRENTLY LIVE tasks,
 * keyed by task name. A task's entry is deleted on `agents browser stop` (see
 * service.ts `saveTaskState`), so a task whose run has already ended is absent
 * here even though its captures remain on disk — that is exactly the
 * "unlinked legacy task" case {@link groupIntoRows} reports. Same read-straight-
 * from-disk approach as the rest of this module: works whether or not the
 * browser daemon is running.
 */
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

/**
 * Identity for one profile's tasks, durable copy first.
 *
 * `browser_sessions` is the source of truth: it is written at task start and
 * never deleted, so it answers for tasks that have already stopped — the case
 * `tasks.json` structurally cannot, since `saveTaskState` rewrites that file
 * from the LIVE task map. The live file is still merged on top for a task that
 * is running right now, so a task started by an older CLI (no DB row yet) keeps
 * whatever identity it does have rather than regressing to nothing.
 */
export function loadDurableTaskIdentities(profile: string): Map<string, TaskIdentity> {
  const merged = new Map<string, TaskIdentity>();
  for (const record of listBrowserSessionRecords(profile)) {
    merged.set(record.task, {
      owner: record.actor,
      launchId: record.launchId,
      sessionId: record.sessionId,
    });
  }
  for (const [task, live] of loadTaskIdentities(profile)) {
    const durable = merged.get(task);
    merged.set(task, {
      owner: live.owner ?? durable?.owner,
      launchId: live.launchId ?? durable?.launchId,
      sessionId: live.sessionId ?? durable?.sessionId,
    });
  }
  return merged;
}

/** launchId -> indexed session id, built once from every source that records
 *  this join, so a task-heavy profile resolves without re-scanning per task. */
export interface LaunchSessionIndex {
  byLaunchId: Map<string, string>;
}

/**
 * Build the launchId -> sessionId index from the same three sources
 * `feed-post.ts` `resolvePostIdentity` already uses for this exact problem —
 * a browser task's `launchId` IS the `AGENT_LAUNCH_ID` of the CLI run that
 * called `agents browser start` (see service.ts `resolveTaskIdentity`), so
 * resolving "which session ran this launch" is the same join, not a new one.
 * Lowest-confidence source first so a later, more specific source overwrites
 * it on a collision:
 *  1. the activity log (durable, but least specific — read last)
 *  2. the SessionStart hook's live-session index (kept for parity with
 *     `hook-sessions.ts`; empty on this fleet today, harmless when so)
 *  3. the per-pid launch registry (`ag run`, launch-scoped, most authoritative)
 * Computed once per interactive session, not per row.
 */
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

/** Resolve one launchId through the index to its canonical `SessionMeta`, or
 *  `null` when the join has no hit or the resolved session isn't indexed here. */
export function resolveLaunchSession(index: LaunchSessionIndex, launchId: string): SessionMeta | null {
  const sessionId = index.byLaunchId.get(launchId);
  return sessionId ? getSessionById(sessionId) : null;
}

/** Why a row carries no session digest: `linked` resolved one, `unresolved`
 *  has a launchId but no matching indexed session, `unlinked` has no launchId
 *  at all (a legacy task, or one whose owning run already stopped). */
export type BrowserSessionLinkStatus = 'linked' | 'unresolved' | 'unlinked';

/** One task-first row: every capture for one browser task (or, for
 *  `kind: 'downloads'`, one profile's downloads bucket), plus the agent
 *  session it links to when resolvable. */
export interface BrowserSessionRow {
  kind: 'task' | 'downloads';
  profile: string;
  /** Task name; undefined for the downloads row. */
  task?: string;
  owner?: string;
  launchId?: string;
  /** The agent session that drove the task, when one was recorded. */
  sessionId?: string;
  linkStatus: BrowserSessionLinkStatus;
  linkedSession?: SessionMeta;
  /** Newest first. */
  artifacts: BrowserArtifact[];
  counts: Record<ArtifactKind, number>;
  /** Most recent capture's mtime — the row's sort/age key. */
  latestMtimeMs: number;
}

/**
 * Group flat per-profile artifacts into task-first rows, newest first. Pure:
 * identities and the launch resolver are passed in, so this has no filesystem
 * or session-index dependency and is unit-testable with synthetic data (see
 * {@link buildBrowserSessionRows} for the impure disk/index-reading caller).
 */
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
    for (const [task, artifacts] of byTask) {
      artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const identity = identities.get(task);
      // Session id first: it is the direct answer and the one agents actually
      // carry. The launchId join stays as the fallback for a task that recorded
      // only that (an older CLI, or a run whose session id was unset).
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
        counts: countByKind(artifacts),
        latestMtimeMs: artifacts[0]?.mtimeMs ?? 0,
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

/** Build task-first rows for one profile (or every profile with captures),
 *  reading `tasks.json` and resolving launchIds against the live indexes.
 *  The interactive picker's data source. */
export function buildBrowserSessionRows(profile?: string): BrowserSessionRow[] {
  // Retention runs from BOTH listing paths, not just the computer one: a box
  // that uses `agents browser` and never runs `agents sessions --computer`
  // would otherwise never sweep either table. Best-effort — a read-only DB
  // must not break a listing.
  try { pruneToolSessions(); } catch { /* listing must not fail on retention */ }
  const groups = listBrowserSessions(profile);
  const taskIdentities = new Map(groups.map((g) => [g.profile, loadDurableTaskIdentities(g.profile)]));
  const index = buildLaunchSessionIndex();
  return groupIntoRows(
    groups,
    taskIdentities,
    (launchId) => resolveLaunchSession(index, launchId),
    (sessionId) => getSessionById(sessionId),
  );
}

/**
 * Search predicate for the interactive picker: task name, profile, the linked
 * session's agent/topic/label, and any artifact filename in the row.
 */
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

/**
 * Shared CLI action for `agents browser sessions` and `agents sessions --browser`.
 * `open` is the Commander value for `--open [selector]`: undefined when the flag
 * is absent, `true` when passed bare (defaults to 'latest'), or the selector string.
 */
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
