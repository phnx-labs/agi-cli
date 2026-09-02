/**
 * Interactive session picker and preview renderer.
 *
 * Powers the fuzzy-searchable session list shown by `agents sessions` in a TTY.
 * Builds a compact preview for each session (prompt, activity summary, last
 * response) and delegates to the generic `itemPicker` for the interactive UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { truncate, humanDuration } from '../lib/format.js';
import type { SessionEvent, SessionMeta, TodoItem, TodoProgress } from '../lib/session/types.js';
import { sessionDisplayAgent } from '../lib/session/types.js';
import { fetchPeerPreviewDigest } from '../lib/session/remote-list.js';
import { parseSession, sanitizeForTerminal, SNAPSHOT_TODO_TOOLS } from '../lib/session/parse.js';
import { safeTeamText } from '../lib/session/team-filter.js';
import { cleanSessionPrompt, extractSessionTopic, isSyntheticUserMessage } from '../lib/session/prompt.js';
import { linkPath, linkUrl, relativeToCwd, shortenModel } from '../lib/session/render.js';
import { linearIssueUrl } from '../lib/session/linear.js';
import { extractTodoProgress, WORKTREE_RE } from '../lib/session/state.js';
import { renderMarkdown } from '../lib/markdown.js';
import { wrapToWidth } from '../lib/wrap.js';
import { terminalWidth, stringWidth } from '../lib/session/width.js';
import { itemPicker } from '../lib/picker.js';
import { createMemoryCache } from '../lib/memory-cache.js';
import { classifyFileChanges, changeCounts, toolHistogram, detectTestResult } from '../lib/session/digest.js';
import type { FileChange, FileOp } from '../lib/session/digest.js';
import {
  extractArtifacts,
  extractBackgroundShells,
  extractHooks,
  extractLinks,
  extractRepos,
  extractSkills,
  harnessTracksBackgroundShells,
  isBackgroundShellStart,
  isSubAgentTool,
} from '../lib/session/highlights.js';
import { getSessionPlugins, readSessionPreviewCache, writeSessionPreviewCache, readSessionContent, readArchivedSessionPreview } from '../lib/session/db.js';
import { machineId } from '../lib/session/sync/config.js';
/** A session whose transcript FILE is on another machine: its `filePath` is on
 * that peer's disk, so the preview can't parse it locally — it fetches the
 * peer's digest over SSH and shows metadata + a "resume there" note until that
 * lands. `_remote` is an explicit signal; a peer `machine` plus no readable
 * local file covers host-dispatch index rows and live-registry rows that were
 * synthesized outside the fan-out. A locally-readable synced mirror stays
 * local even when its recorded owner is another machine.
 *
 * This is the READ rule and only the read rule. Whether a session may be
 * RESUMED here is a different question with a different answer — a mirror is
 * readable but not resumable — and `sessionOwnerDevice`
 * (lib/session/resume-owner.ts) is the single place that answers it (RUSH-2022). */
export function transcriptOnPeerOf(session: SessionMeta): string | undefined {
  if (session._remote) return session.machine;
  if (
    session.machine
    && session.machine !== machineId()
    && (!session.filePath || !fs.existsSync(session.filePath))
  ) {
    return session.machine;
  }
  return undefined;
}

/**
 * Compact checklist tally for list rows and previews (RUSH-2045).
 * Example: `✓6/8 · A5 wiring runner`. Empty string when there is no list.
 * Consumes `SessionMeta.todos` / `ActiveSession.todos` as populated by the
 * state engine — does not re-parse transcripts.
 */
export function formatTodoCompact(todos?: Pick<TodoProgress, 'done' | 'total' | 'activeForm'> | null): string {
  if (!todos || !Number.isFinite(todos.total) || todos.total < 1) return '';
  const done = Number.isFinite(todos.done) ? Math.max(0, todos.done) : 0;
  const tally = `✓${done}/${todos.total}`;
  const step = todos.activeForm?.replace(/\s+/g, ' ').trim();
  return step ? `${tally} · ${step}` : tally;
}

/**
 * Best-effort GitHub repo URL from a checkout path shaped like
 * `…/github.com/<owner>/<repo>/…`. Used to make the project name clickable
 * when no Linear project URL is available.
 */
export function githubRepoUrlFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/');
  const m = norm.match(/\/github\.com\/([^/]+\/[^/]+)/);
  return m ? `https://github.com/${m[1]}` : undefined;
}

/**
 * SessionMeta originates in discover.ts (gitBranch, cwd, label, etc. read from
 * untrusted session files). parseSession sanitizes event payloads at its
 * chokepoint, but meta fields bypass that path. Strip terminal escapes here
 * before any meta string reaches a TTY.
 */
function sanitizeMeta(s: SessionMeta): SessionMeta {
  const clean = (v: string | undefined) => (v == null ? v : sanitizeForTerminal(v));
  const todos = s.todos
    ? {
        ...s.todos,
        activeForm: clean(s.todos.activeForm),
        items: s.todos.items.map((it) => ({
          ...it,
          content: sanitizeForTerminal(it.content),
          activeForm: clean(it.activeForm),
        })),
      }
    : s.todos;
  return {
    ...s,
    id: sanitizeForTerminal(s.id),
    shortId: sanitizeForTerminal(s.shortId),
    filePath: sanitizeForTerminal(s.filePath),
    cwd: clean(s.cwd),
    project: clean(s.project),
    gitBranch: clean(s.gitBranch),
    version: clean(s.version),
    account: clean(s.account),
    topic: clean(s.topic),
    firstUserMessage: clean(s.firstUserMessage),
    label: clean(s.label),
    generatedTitle: clean(s.generatedTitle),
    ticketId: clean(s.ticketId),
    prUrl: clean(s.prUrl),
    // A remote row's meta is peer-supplied JSON that parseRemoteList hands over
    // unsanitized, and both of these reach the preview pane — so an escape
    // sequence in a peer's plan text or path list would otherwise hit our TTY.
    plan: clean(s.plan),
    spawnedTeam: clean(s.spawnedTeam),
    recentDirectoriesTouched: s.recentDirectoriesTouched?.map(sanitizeForTerminal),
    todos,
  };
}

export interface PickedSession {
  session: SessionMeta;
  action: 'resume' | 'view';
}

export interface SessionPickerConfig {
  message: string;
  /** Dim hint line shown under the header (filters/flags tip). */
  subtitle?: string;
  sessions: SessionMeta[];
  filter: (query: string) => SessionMeta[];
  labelFor: (s: SessionMeta, query: string) => string;
  pageSize?: number;
  initialSearch?: string;
  /** Verb shown on the Enter key in the footer (default 'resume'). */
  enterHint?: string;
  /** Lines the caller printed above the prompt (hidden-session footer). */
  linesAbovePrompt?: number;
}

const previewCache = createMemoryCache<string, string>({
  max: 256,
  ttlMs: 5 * 60_000,
});

/**
 * Peer preview digests for rows whose transcript is remote. The pane fetches
 * its already-computed digest over SSH (the
 * peer's `sessions preview <id> --local --json`) the first time the row is
 * previewed, and renders the full compact preview once it lands. `pending`
 * marks an in-flight fetch; `failed` marks a peer that couldn't answer, retried
 * only after the TTL evicts the entry so arrowing over the row doesn't hammer a
 * dead host.
 */
type RemoteDigestEntry =
  | { state: 'pending' }
  | { state: 'ready'; digest: SessionPreviewDigest }
  | { state: 'failed' };
const remoteDigestCache = createMemoryCache<string, RemoteDigestEntry>({
  max: 256,
  ttlMs: 5 * 60_000,
});

function remoteDigestKey(sessionId: string, machine: string): string {
  return `${machine}:${sessionId}`;
}

/**
 * The open picker's repaint trigger. The peer fetch resolves while the pane is
 * already painted, so completion has to nudge the picker into re-rendering —
 * pickers register their trigger here (via `registerPreviewRepaint`) and clear
 * it when they close, making a late fetch after close a no-op.
 */
let remotePreviewRepaint: (() => void) | undefined;
export function setRemotePreviewRepaint(repaint?: () => void): void {
  remotePreviewRepaint = repaint;
}

/** Seam for tests: the real fetcher opens an SSH connection to the peer. */
let peerDigestFetcher: typeof fetchPeerPreviewDigest = fetchPeerPreviewDigest;
export function setPeerDigestFetcherForTest(fetcher?: typeof fetchPeerPreviewDigest): void {
  peerDigestFetcher = fetcher ?? fetchPeerPreviewDigest;
}
export function clearRemoteDigestCacheForTest(): void {
  remoteDigestCache.clear();
}

/**
 * Look up (or start fetching) the peer digest for a remote row. Returns the
 * current entry synchronously — `buildPreview` renders whatever state exists
 * now, and the fetch's completion repaints the pane through the registered
 * trigger.
 */
function remoteDigestForPreview(session: SessionMeta, machine: string): RemoteDigestEntry {
  const key = remoteDigestKey(session.id, machine);
  const existing = remoteDigestCache.get(key);
  if (existing) return existing;
  const pending: RemoteDigestEntry = { state: 'pending' };
  remoteDigestCache.set(key, pending);
  void peerDigestFetcher(session.id, machine)
    .then((raw) => {
      const digest = sanitizeRemoteDigest(raw);
      remoteDigestCache.set(key, digest ? { state: 'ready', digest } : { state: 'failed' });
    })
    .catch(() => {
      remoteDigestCache.set(key, { state: 'failed' });
    })
    .then(() => remotePreviewRepaint?.());
  return pending;
}

/**
 * Validate + scrub a peer-supplied preview digest before any of it reaches this
 * terminal. Peer JSON is untrusted at this boundary — the same rule
 * `sanitizeMeta` applies to fan-out rows — so every string is stripped of
 * terminal escapes and every list re-shaped field by field. Anything that
 * doesn't look like the v1 digest is rejected, so a version-skewed peer
 * degrades to the metadata card instead of a corrupted pane.
 */
export function sanitizeRemoteDigest(raw: unknown): SessionPreviewDigest | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const d = raw as Record<string, unknown>;
  if (d.schemaVersion !== 1) return undefined;

  const str = (v: unknown): string => (typeof v === 'string' ? sanitizeForTerminal(v) : '');
  const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? sanitizeForTerminal(v) : undefined);
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(sanitizeForTerminal) : [];
  const objList = <T>(v: unknown, map: (o: Record<string, unknown>) => T | undefined): T[] =>
    Array.isArray(v)
      ? v.flatMap((x) => {
          if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
          const mapped = map(x as Record<string, unknown>);
          return mapped === undefined ? [] : [mapped];
        })
      : [];

  let todos: TodoProgress | undefined;
  if (d.todos && typeof d.todos === 'object' && !Array.isArray(d.todos)) {
    const t = d.todos as Record<string, unknown>;
    const items = objList<TodoItem>(t.items, (it) => {
      const content = str(it.content ?? it.text);
      if (!content) return undefined;
      const status = it.status === 'completed' || it.status === 'in_progress' ? it.status : 'pending';
      return { content, status, activeForm: optStr(it.activeForm) };
    });
    todos = { items, done: num(t.done), total: num(t.total), activeForm: optStr(t.activeForm) };
  }

  const changes = d.changes && typeof d.changes === 'object' && !Array.isArray(d.changes)
    ? {
        created: num((d.changes as Record<string, unknown>).created),
        modified: num((d.changes as Record<string, unknown>).modified),
        deleted: num((d.changes as Record<string, unknown>).deleted),
      }
    : { created: 0, modified: 0, deleted: 0 };

  let test: SessionPreviewDigest['test'];
  if (d.test && typeof d.test === 'object' && !Array.isArray(d.test)) {
    const t = d.test as Record<string, unknown>;
    const runner = str(t.runner);
    if (runner) {
      test = { runner, ok: t.ok === true, ts: num(t.ts), passed: optNum(t.passed), failed: optNum(t.failed) };
    }
  }

  return {
    schemaVersion: 1,
    firstUser: str(d.firstUser),
    lastAssistant: str(d.lastAssistant),
    filesRead: num(d.filesRead),
    toolCalls: num(d.toolCalls),
    planFile: str(d.planFile),
    todos,
    subAgentCount: num(d.subAgentCount),
    // optNum, not num: a peer's JSON is untrusted, and the undefined-vs-0
    // distinction is load-bearing here — num() would coerce a malformed value
    // to 0, which reads as "scanned, none running".
    backgroundShellCount: optNum(d.backgroundShellCount),
    toolTags: strList(d.toolTags),
    changes,
    // Per-file paths from an untrusted peer: keep only well-formed {path, op}
    // entries (path scrubbed of terminal escapes, op a known FileOp), bounded
    // like the local build so a hostile peer can't flood the pane.
    changedFiles: objList<FileChange>(d.changedFiles, (f) => {
      const path = str(f.path);
      const op = f.op === 'created' || f.op === 'modified' || f.op === 'deleted' ? (f.op as FileOp) : undefined;
      return path && op ? { path, op } : undefined;
    }).slice(0, CHANGED_FILES_MAX),
    dirs: strList(d.dirs),
    repos: strList(d.repos),
    artifacts: objList(d.artifacts, (a) => {
      const p = str(a.path);
      const basename = str(a.basename);
      if (!p || !basename) return undefined;
      const bucket = a.bucket === 'artifacts' || a.bucket === 'plans' || a.bucket === 'reports' ? a.bucket : 'docs';
      return { path: p, basename, bucket };
    }),
    skills: objList(d.skills, (s) => {
      const name = str(s.name);
      return name ? { name, count: num(s.count) } : undefined;
    }),
    plugins: strList(d.plugins),
    hooks: objList(d.hooks, (h) => {
      const name = str(h.name);
      return name ? { name, event: optStr(h.event), count: num(h.count), failed: num(h.failed) } : undefined;
    }),
    links: objList(d.links, (l) => {
      const url = str(l.url);
      const label = str(l.label);
      // Only http(s) URLs render as OSC 8 hyperlinks — anything else a peer
      // sends (file:, a bare payload) is dropped rather than linkified.
      return /^https?:\/\//.test(url) && label ? { kind: 'other' as const, url, label } : undefined;
    }),
    errorCount: num(d.errorCount),
    firstError: optStr(d.firstError),
    toolHistogram: objList(d.toolHistogram, (h) => {
      const tool = str(h.tool);
      return tool ? { tool, count: num(h.count) } : undefined;
    }),
    test,
  };
}

function previewCacheKey(session: SessionMeta, remote: string | undefined): string {
  let fileStamp = '';
  if (!remote && session.filePath) {
    try {
      const stat = fs.statSync(session.filePath);
      fileStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      fileStamp = 'missing';
    }
  }
  // A remote row's rendered pane depends on the fetched digest's state
  // (none → pending → ready/failed), so the state rides the key — otherwise the
  // memoized metadata-only card would keep serving after the digest arrived.
  const remoteDigestState = remote
    ? remoteDigestCache.get(remoteDigestKey(session.id, remote))?.state ?? 'none'
    : '';
  // The transcript stamp invalidates derived activity. Metadata that can change
  // independently (label/ticket/PR/live scanner enrichment) also rides the key.
  return JSON.stringify([
    remote ?? '', remoteDigestState, session.id, fileStamp, session.lastActivity, session.label,
    session.generatedTitle,
    session.topic, session.ticketId, session.prUrl, session.messageCount,
    session.tokenCount, session.model, session.todos, session.plan,
    session.recentDirectoriesTouched, session.skillsUsed,
    session.firstUserMessage, session.mirrorSyncedAt,
  ]);
}

export function clearPreviewMemoryCacheForTest(): void {
  previewCache.clear();
}

export function loadSessionPreviewDigest(session: SessionMeta): {
  digest?: SessionPreviewDigest;
  events: SessionEvent[];
  error?: string;
} {
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    // File gone, but an archived session (RUSH-2436) keeps its last-computed
    // digest in the DB — serve that so the picker preview still shows its turns
    // instead of a bare "not indexed here" note. No events to replay.
    const archived = readArchivedSessionPreview<SessionPreviewDigest>(session.id);
    if (archived) {
      archived.plugins = getSessionPlugins(session.id);
      return { digest: archived, events: [] };
    }
    return { events: [] };
  }
  const safe = sanitizeMeta(session);
  let events: SessionEvent[] = [];
  let sourceStamp: fs.Stats;
  try {
    sourceStamp = fs.statSync(session.filePath);
  } catch (err: any) {
    return { events, error: sanitizeForTerminal(err?.message ?? String(err)) };
  }
  let digest = readSessionPreviewCache<SessionPreviewDigest>(session.id, {
    fileMtimeMs: sourceStamp.mtimeMs,
    fileSize: sourceStamp.size,
  });
  if (!digest) {
    try {
      events = parseSession(session.filePath, session.agent);
      digest = buildSessionPreviewDigest(events, safe);
      writeSessionPreviewCache({
        id: session.id,
        fileMtimeMs: sourceStamp.mtimeMs,
        fileSize: sourceStamp.size,
        preview: digest,
      });
    } catch (err: any) {
      return { events, error: sanitizeForTerminal(err?.message ?? String(err)) };
    }
  }
  digest.plugins = getSessionPlugins(session.id);
  return { digest, events };
}

/** Build a cached multi-line preview string for display in the session picker. */
export function buildPreview(session: SessionMeta): string {
  const remote = transcriptOnPeerOf(session);
  const cacheKey = previewCacheKey(session, remote);
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;

  const safe = sanitizeMeta(session);

  // Remote session: the transcript is on the peer's disk, so there is nothing to
  // parse here. The common case is now a fleet-synced MIRROR row (PHNX-3792): its
  // topic + first-user snippet + metadata are already local, so the compact card
  // renders INLINE with no per-row SSH. The live SSH digest fetch stays as the
  // fallback for a never-synced row (or a peer whose digest was already fetched
  // this session), and `space` still reads the full transcript live over SSH.
  if (remote) {
    // A fleet-synced MIRROR row is the explicit signal that this box already
    // holds the peer session's topic + first-user snippet locally (PHNX-3792):
    // render inline with NO per-row SSH. An ordinary remote row (a live fan-out
    // row, or a never-synced host-dispatch stub) is NOT treated as synced — it
    // keeps the live digest fetch below, so this change is scoped to mirror rows.
    const fetched = remoteDigestCache.get(remoteDigestKey(session.id, remote));
    if (fetched?.state === 'ready') {
      // A richer live digest already landed this session (changed files, tool
      // mix) — prefer it over the lightweight mirror card.
      const note = '  ' + chalk.gray(`on `) + chalk.bold.white(remote)
        + chalk.gray(` — enter to resume there`);
      const body = formatCompactPreview(fetched.digest, safe);
      const output = [formatHeader(safe, []), '', note, body].filter(Boolean).join('\n');
      previewCache.set(cacheKey, output);
      return output;
    }
    if (safe.mirrorSyncedAt !== undefined) {
      const note = '  ' + chalk.gray(`on `) + chalk.bold.white(remote)
        + chalk.gray(` — synced from the fleet; enter to resume there, or space to read it live over SSH`);
      const metaBody = formatMetaOnlyBody(safe);
      const output = [formatHeader(safe, []), '', note, metaBody].filter(Boolean).join('\n');
      previewCache.set(cacheKey, output);
      return output;
    }
    // Not a mirror row: fall back to the live SSH digest fetch (kicked off on
    // first render; the pane repaints when it lands).
    const note = '  ' + chalk.gray(`on `) + chalk.bold.white(remote)
      + chalk.gray(` — enter to resume there, or space then enter to read it over SSH`);
    const entry = remoteDigestForPreview(session, remote);
    if (entry.state === 'ready') {
      const body = formatCompactPreview(entry.digest, safe);
      const output = [formatHeader(safe, []), '', note, body].filter(Boolean).join('\n');
      previewCache.set(cacheKey, output);
      return output;
    }
    const fetching = entry.state === 'pending'
      ? '  ' + chalk.gray(`fetching preview from ${remote} over SSH…`)
      : '';
    const metaBody = formatMetaOnlyBody(safe);
    const output = [formatHeader(safe, []), '', note, fetching, metaBody].filter(Boolean).join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  // No transcript on disk — either an archived session (file gone, user turns
  // still in the DB — RUSH-2436), a live session not indexed locally, or a
  // synthesized entry (e.g. `sessions go`). Show the header + a clean note.
  if (!session.filePath || !fs.existsSync(session.filePath)) {
    const archivedContent = readSessionContent(session.id);
    if (archivedContent && archivedContent.trim() !== '') {
      const note = '  ' + chalk.yellow('archived — transcript file removed; served from the local DB');
      const { digest } = loadSessionPreviewDigest(session);
      const body = digest ? formatCompactPreview(digest, safe) : formatMetaOnlyBody(safe);
      const output = [formatHeader(safe, []), '', note, body].filter(Boolean).join('\n');
      previewCache.set(cacheKey, output);
      return output;
    }
    const note = '  ' + chalk.gray('Live session — full transcript not indexed here.');
    const metaBody = formatMetaOnlyBody(safe);
    const output = [formatHeader(safe, []), '', note, metaBody].filter(Boolean).join('\n');
    previewCache.set(cacheKey, output);
    return output;
  }

  const { digest, events, error: parseError } = loadSessionPreviewDigest(session);

  const header = formatHeader(safe, events);
  const body = parseError
    ? '  ' + chalk.red(`Failed to parse session: ${parseError}`)
    : formatCompactPreview(digest!, safe, events);
  const output = [header, '', body].filter(Boolean).join('\n');
  previewCache.set(cacheKey, output);
  return output;
}

function displayAgent(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

const DOT = chalk.gray(' · ');

function formatHeader(session: SessionMeta, events: SessionEvent[]): string {
  const model = extractModel(events) || session.model;
  const { createdAgo, lastActiveAgo, duration } = extractTiming(session, events);

  // Line 1: Agent v version · shortId · model · account
  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(sessionDisplayAgent(session))}${session.version ? ` v${session.version}` : ''}`));
  if (session.shortId) line1.push(chalk.dim(session.shortId));
  if (model) line1.push(chalk.bold.white(shortenModel(model)));
  if (session.account) line1.push(chalk.gray(session.account));

  // Line 2: cwd · project · branch · created X ago · last active Y ago · lasted Z
  // Project is clickable: Linear issue URL is for tickets (line 4); for the
  // project name prefer a GitHub repo URL derived from the checkout path.
  const line2: string[] = [];
  if (session.cwd) {
    const label = relativeToCwd(session.cwd);
    line2.push(chalk.bold.white(linkPath(session.cwd, label)));
  }
  if (session.project) {
    const repoUrl = githubRepoUrlFromCwd(session.cwd);
    line2.push(chalk.cyan(repoUrl ? linkUrl(repoUrl, session.project) : session.project));
  }
  if (session.gitBranch) line2.push(chalk.cyan(session.gitBranch));
  if (createdAgo) line2.push(chalk.gray('created ') + chalk.white(createdAgo + ' ago'));
  if (lastActiveAgo) line2.push(chalk.gray('last active ') + chalk.white(lastActiveAgo + ' ago'));
  if (duration) line2.push(chalk.gray('lasted ') + chalk.white(duration));

  // Line 4: ticket + PR — clickable when a URL is resolvable (OSC 8 hyperlink),
  // plain text otherwise. Only rendered when the session carries either.
  const line4: string[] = [];
  if (session.ticketId) {
    const url = linearIssueUrl(session.ticketId);
    line4.push(chalk.blue(url ? linkUrl(url, session.ticketId) : session.ticketId));
  }
  if (session.prUrl) {
    const label = session.prNumber ? `PR#${session.prNumber}` : 'PR';
    line4.push(chalk.blue(linkUrl(session.prUrl, label)));
  }

  // Lead with the session's human title: `session.label` — an agent-generated
  // name / `/rename`, else the `--name` launch handle — else the daemon-generated
  // title (PHNX-3797), which is a short technical NAME, not a restatement of the
  // prompt. NOT `session.topic`: the topic is the derived first-prompt, already
  // shown on the `Prompt:` line, so using it here too would print the same text
  // twice. A session with neither keeps that `Prompt:` line as its topic
  // indicator and simply leads with the agent line. Wrapped to the pane (the
  // header sits at column 0, full terminal width).
  const title = (session.label || session.generatedTitle || '').trim();
  const titleLines = title
    ? wrapToWidth(title, terminalWidth()).map(l => chalk.bold.white(l))
    : [];

  return [
    ...titleLines,
    line1.join(DOT),
    line2.join(DOT),
    ...(line4.length ? [line4.join(DOT)] : []),
  ].join('\n');
}

/**
 * Body lines available from SessionMeta alone (no transcript parse) — used for
 * remote / unindexed sessions so checklist progress still surfaces when the
 * parser teammate (or a prior scan) has populated `session.todos`.
 */
/**
 * The session's place in a team, from whichever end it sits at: the orchestrator
 * that ran `agents teams create` (from the scan-derived `spawnedTeam`), or a
 * teammate (from its `meta.json`, via `classifyTeamSession`). Empty for a session
 * with no team involvement, which is the overwhelming majority.
 *
 * Deliberately no live teammate counts: tallying a team means reading every
 * record under the teams-agents dir, which runs to thousands of files on a busy
 * machine — far too much for a pane that repaints as the cursor moves. The line
 * names the command that does report them instead.
 */
/**
 * The "what did this session leave running" segments of the Doing line.
 *
 * Prefers a DERIVED count (fresh, from the transcript the caller just parsed)
 * and falls back to the PERSISTED column, which is what lets a remote/unindexed
 * row — rendered from `SessionMeta` alone, with no events — show fan-out at all.
 * That fallback is the whole reason the counts are columns (RUSH-3091/3095).
 *
 * A count of 0 or undefined renders NOTHING. Both are real states — "scanned,
 * none found" and "this harness cannot report it" — and a literal "0 background
 * shells" would assert "nothing is running" for a harness that simply does not
 * record them.
 *
 * Wording is "left behind", not "running": a transcript records a start and
 * never a death (see extractBackgroundShells).
 */
export function formatFanOut(
  session: SessionMeta,
  derived?: { subAgentCount?: number; backgroundShellCount?: number },
): string[] {
  // DERIVED wins when the caller has one. It is computed from the transcript as
  // it stands right now, whereas the persisted column is only as fresh as the
  // last scan — for a live session those disagree within seconds. The persisted
  // value is the fallback that makes a remote/unindexed row (no events, so no
  // derived value) render at all, which is the whole reason it is a column.
  const subAgents = derived?.subAgentCount ?? session.subAgentCount ?? 0;
  const shells = derived?.backgroundShellCount ?? session.backgroundShellCount ?? 0;
  const out: string[] = [];
  if (subAgents > 0) out.push(chalk.gray(`${subAgents} sub-agent${subAgents === 1 ? '' : 's'}`));
  if (shells > 0) out.push(chalk.gray(`${shells} background shell${shells === 1 ? '' : 's'}`));
  return out;
}

export function formatTeamLineage(session: SessionMeta): string {
  const origin = session.teamOrigin;
  if (origin) {
    const team = safeTeamText(origin.team);
    const handleName = safeTeamText(origin.handle);
    const mode = safeTeamText(origin.mode);
    const parent = safeTeamText(origin.parentSessionId);
    const parts = [chalk.white(team ?? 'team')];
    const handle = handleName ? `teammate ${handleName}` : 'teammate';
    parts.push(chalk.white(mode ? `${handle} (${mode})` : handle));
    if (parent) {
      parts.push(chalk.gray('spawned by ') + chalk.white(parent.slice(0, 8)));
    }
    return parts.join(chalk.gray(' · '));
  }
  const spawned = safeTeamText(session.spawnedTeam);
  if (spawned) {
    return (
      chalk.gray('spawned team ') +
      chalk.white(spawned) +
      chalk.gray(` · agents teams status ${spawned}`)
    );
  }
  return '';
}

function formatMetaOnlyBody(session: SessionMeta): string {
  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;
  const valueWidth = termWidth - VERB_GUTTER - 5;

  // Same verb-led rows as the digest body (RUSH-2757), from SessionMeta alone.
  // Prefer the fuller first genuine user turn over the one-line topic when the
  // row carries it (a fleet-synced mirror row does — PHNX-3792) so the inline
  // card reads like the originating prompt, not just its title.
  const asked = session.firstUserMessage?.trim() || session.topic?.trim();
  if (asked) {
    lines.push(verbLabel('Asked') + chalk.white(`"${truncate(asked, valueWidth)}"`));
  }
  const compact = formatTodoCompact(session.todos);
  const teamLine = formatTeamLineage(session);
  const doing = [compact ? chalk.white(compact) : '', teamLine, ...formatFanOut(session)].filter(Boolean);
  if (doing.length) {
    lines.push(verbLabel('Doing') + doing.join(DOT));
  }
  for (const l of session.todos?.items?.length ? renderTodos(session.todos.items, termWidth) : []) {
    lines.push('  ' + l);
  }
  // `plan` is the whole ExitPlanMode markdown, not a path — summarize it. The
  // pane is height-clamped anyway, so pasting the blob would just push every
  // other line out of view.
  const planLines = session.plan?.trim() ? session.plan.trim().split('\n') : [];
  if (planLines.length) {
    const head = truncate(planLines[0].replace(/^#+\s*/, ''), termWidth - 20);
    lines.push(verbLabel('Made') + chalk.white(head) + chalk.gray(` · plan, ${planLines.length} lines`));
  }
  const cost: string[] = [];
  if (session.messageCount !== undefined) {
    cost.push(chalk.white(String(session.messageCount)) + chalk.gray(` msg${session.messageCount === 1 ? '' : 's'}`));
  }
  if (session.tokenCount !== undefined) {
    cost.push(chalk.white(formatTokens(session.tokenCount)) + chalk.gray(' tokens'));
  }
  if (cost.length) {
    lines.push(verbLabel('Cost') + cost.join(DOT));
  }
  const dirs = session.recentDirectoriesTouched?.slice(0, DIRS_TOUCHED_MAX) ?? [];
  const details: string[] = [
    session.filePath ? chalk.gray(linkPath(session.filePath, session.id.slice(0, 8))) : chalk.gray(session.id.slice(0, 8)),
    ...dirs.map(d => chalk.gray(d)),
  ];
  lines.push(verbLabel('Details ▸') + joinWidthCapped(details, valueWidth));
  return lines.map(l => '  ' + l).join('\n');
}

function extractModel(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const m = events[i].model;
    if (events[i].type === 'usage' && m) return m;
  }
  for (const e of events) {
    if (e.type === 'init' && e.model) return e.model;
  }
  return undefined;
}

/** Shortest span worth reporting as a separate last-activity field — matches the
 * listing's rule, so the pane and the row agree on what counts as a one-shot. */
const TIMING_SPAN_MIN_MS = 60_000;

/**
 * The three timing facts the header reports: when the session was created, when
 * it was last active, and how long it ran. Reads the parsed transcript when
 * there is one and otherwise the indexed `SessionMeta`, so a remote or
 * unindexed session — which has no local transcript to parse — still reports
 * them instead of silently dropping the whole line.
 *
 * `lastActive` and `lasted` are omitted for a session whose whole life was under
 * a minute: there they just restate `created`.
 */
export function extractTiming(
  session: Pick<SessionMeta, 'timestamp' | 'lastActivity' | 'durationMs'>,
  events: SessionEvent[],
): { createdAgo?: string; lastActiveAgo?: string; duration?: string } {
  const firstMs = Date.parse(events[0]?.timestamp ?? session.timestamp);
  if (Number.isNaN(firstMs)) return {};
  const createdAgo = humanDuration(Math.max(0, Date.now() - firstMs));

  const lastMs = Date.parse(
    events[events.length - 1]?.timestamp ?? session.lastActivity ?? session.timestamp,
  );
  if (Number.isNaN(lastMs)) return { createdAgo };
  // A scan-persisted duration beats the timestamp subtraction when there are no
  // events to read, because `lastActivity` may have fallen back to file mtime.
  const spanMs = events.length === 0 && session.durationMs !== undefined
    ? session.durationMs
    : Math.max(0, lastMs - firstMs);
  if (spanMs < TIMING_SPAN_MIN_MS) return { createdAgo };
  return {
    createdAgo,
    lastActiveAgo: humanDuration(Math.max(0, Date.now() - lastMs)),
    duration: humanDuration(spanMs),
  };
}


function countMessages(events: SessionEvent[]): number {
  return events.filter(e => e.type === 'message').length;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = n / 1000;
    return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  const v = n / 1_000_000;
  return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, '')) + 'm';
}

/** Patterns that indicate a user message is system context, not a real prompt. */
const SYSTEM_MESSAGE_PATTERNS = [
  /^\s*<environment_context>/i,
  /^\s*<system-reminder>/i,
  /^\s*<permissions\s/i,
  /^\s*<collaboration_mode>/i,
  /^\s*<local-command-caveat>/i,
  /^\s*# AGENTS\.md instructions for\b/i,
  /^\s*<command-(message|name|args)>/i,
];

/** Strip XML/HTML tags and clean up content for display. */
function stripTags(text: string): string {
  // Remove complete tag pairs with their content for known system tags
  let cleaned = text.replace(/<(system-reminder|environment_context|permissions[^>]*)>[\s\S]*?<\/\1>/gi, '');
  // Remove remaining XML-like tags
  cleaned = cleaned.replace(/<\/?[a-z_-]+[^>]*>/gi, '');
  return cleaned;
}

const LAST_RESPONSE_MAX_LINES = 15;
const LAST_RESPONSE_MAX_LINES_WITH_TODOS = 8;
const TODOS_MAX_ITEMS = 5;
const DIRS_TOUCHED_MAX = 5;
// Upper bound on the per-file `changedFiles` list carried on the digest. High
// enough to cover any real session's edits, low enough that a runaway rewrite
// can't bloat the cached JSON. The `changes` counts stay the true totals.
const CHANGED_FILES_MAX = 200;

export interface SessionPreviewDigest {
  schemaVersion: 1;
  firstUser: string;
  lastAssistant: string;
  filesRead: number;
  toolCalls: number;
  planFile: string;
  todos?: TodoProgress;
  subAgentCount: number;
  /** undefined when the harness records no background-shell concept. */
  backgroundShellCount?: number;
  toolTags: string[];
  changes: ReturnType<typeof changeCounts>;
  /**
   * The per-file source paths behind `changes`. `changes` keeps the roll-up
   * counts every existing consumer already reads; `changedFiles` carries the
   * real path + op the CLI computed at scan time (via classifyFileChanges) and
   * used to discard — kept so a consumer that renders a per-file diff list (the
   * AGI EXT Fleet detail panel, PHNX-2973) has the paths, not just the totals.
   * Capped so a session that rewrote thousands of files can't bloat the cached
   * digest / JSON payload; the `changes` counts stay the true totals.
   */
  changedFiles: FileChange[];
  dirs: string[];
  repos: string[];
  artifacts: ReturnType<typeof extractArtifacts>;
  skills: ReturnType<typeof extractSkills>;
  plugins: string[];
  hooks: ReturnType<typeof extractHooks>;
  links: ReturnType<typeof extractLinks>;
  errorCount: number;
  firstError?: string;
  toolHistogram: ReturnType<typeof toolHistogram>;
  test: ReturnType<typeof detectTestResult>;
}

/** Fold a harness-normalized event stream into the stable preview data model. */
export function buildSessionPreviewDigest(events: SessionEvent[], session: SessionMeta): SessionPreviewDigest {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
  /** Latest checklist from the transcript (Claude TodoWrite / Codex update_plan). */
  let latestTodos: TodoProgress | undefined;
  let subAgentCount = 0;
  // undefined, not 0, when the harness records no background-shell concept —
  // formatFanOut renders absence for both, but conflating them here would let a
  // later consumer read "0 shells" as a positive "none running" claim.
  let backgroundShellCount: number | undefined = harnessTracksBackgroundShells(session.agent)
    ? 0
    : undefined;
  const toolTags = new Set<string>();
  // usedBrowser/usedComputer are computed at scan time from a sessionId-scoped
  // events-log read (session/db.ts detectToolUsage), NOT a transcript regex —
  // undefined means a legacy row this scanner hasn't computed the field for
  // yet, so only THEN does classifySessionTool's transcript-derived guess run
  // below (mirrors directoriesTouched's prefer-persisted/fall-back-to-derived
  // pattern for recentDirectoriesTouched).
  const knownToolUsage = session.usedBrowser !== undefined;

  for (const event of events) {
    if (event.type === 'message') {
      if (event.role === 'user' && !event._synthetic && !firstUser && event.content) {
        if (!SYSTEM_MESSAGE_PATTERNS.some(p => p.test(event.content!))) {
          firstUser = event.content;
        }
      }
      if (event.role === 'assistant' && event.content) {
        lastAssistant = event.content;
      }
    } else if (event.type === 'tool_use' && !event._local) {
      const tool = event.tool || '';
      const command = event.command || '';
      if (!knownToolUsage) {
        for (const tag of classifySessionTool(tool, command)) toolTags.add(tag);
      }
      if (isSubAgentTool(tool, command)) subAgentCount++;
      if (backgroundShellCount !== undefined && isBackgroundShellStart(event)) backgroundShellCount++;
      const p = event.path || event.args?.file_path || event.args?.path || '';
      if (['Read', 'read_file', 'view_file', 'cat_file', 'get_file'].includes(tool) && p) {
        filesRead.add(p);
      }
      if (!planFile && p && /\/plans\/[^/]+\.md$/.test(p)) {
        planFile = p;
      }
      // Every harness's checklist-snapshot tool (Claude TodoWrite, Kimi TodoList,
      // Codex update_plan, …) — the same registry the state engine folds through
      // extractTodoProgress. Prefer the most recent write.
      if (SNAPSHOT_TODO_TOOLS.has(tool)) {
        const progress = extractTodoProgress(event.args);
        if (progress) latestTodos = progress;
      }
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  // Persisted field wins when computed — it comes from real browser.navigate/
  // browser.screenshot/computer.action events, not a fuzzy tool-name regex.
  if (session.usedBrowser) toolTags.add('browser');
  if (session.usedComputer) toolTags.add('computer');

  // Prefer the transcript-derived list when we just re-parsed the file (freshest
  // checklist write); fall back to SessionMeta.todos for rows where the scan/
  // fan-out attached progress but the event stream has no TodoWrite yet.
  const todos: TodoProgress | undefined = latestTodos ?? session.todos;

  const changes = classifyFileChanges(events);
  const chg = changeCounts(changes);

  const errorEvents = events.filter(e => e.type === 'error');
  return {
    schemaVersion: 1,
    firstUser,
    lastAssistant,
    filesRead: filesRead.size,
    toolCalls,
    planFile,
    todos,
    subAgentCount,
    backgroundShellCount,
    toolTags: [...toolTags],
    changes: chg,
    // Full per-file list the picker used to collapse to `chg` and throw away.
    // Bounded so a mass-rewrite session can't blow up the cached digest; the
    // counts above remain the true totals.
    changedFiles: changes.slice(0, CHANGED_FILES_MAX),
    dirs: directoriesTouched(session, events, changes),
    repos: extractRepos(events, session.cwd),
    artifacts: extractArtifacts(changes),
    skills: extractSkills(events),
    plugins: getSessionPlugins(session.id),
    hooks: extractHooks(events),
    links: extractLinks(events),
    errorCount: errorEvents.length,
    firstError: errorEvents[0]?.tool,
    toolHistogram: toolHistogram(toolCounts, 4),
    test: detectTestResult(events),
  };
}

// Verb-led row gutter (RUSH-2757): every row label pads to this width so the
// values align into one scannable column. 'Details ▸' is the widest label.
const VERB_GUTTER = 9;
function verbLabel(v: string): string {
  return chalk.cyan(v.padEnd(VERB_GUTTER)) + ' ';
}

function formatCompactPreview(digest: SessionPreviewDigest, session: SessionMeta, events?: SessionEvent[]): string {
  const {
    firstUser, lastAssistant, filesRead, toolCalls, planFile, todos,
    subAgentCount, backgroundShellCount, toolTags, changes: chg, dirs, repos, artifacts, skills, plugins,
    hooks, links, errorCount, firstError, toolHistogram: hist, test,
  } = digest;

  const lines: string[] = [];
  const termWidth = process.stdout.columns || 80;
  const valueWidth = termWidth - VERB_GUTTER - 5;

  // Asked — the originating user prompt (first non-system user turn), quoted.
  const asked = firstUser
    ? (extractSessionTopic(firstUser) || cleanSessionPrompt(firstUser).split('\n').find(l => l.trim()) || '')
    : (session.topic && !isSyntheticUserMessage(session.topic) ? session.topic : '');
  if (asked.trim()) {
    lines.push(verbLabel('Asked') + chalk.white(`"${truncate(asked.trim(), valueWidth)}"`));
  }

  // Doing — the work in motion: checklist progress (RUSH-2045), team lineage,
  // sub-agent fan-out. The full checklist renders indented beneath.
  const compact = formatTodoCompact(todos);
  const teamLine = formatTeamLineage(session);
  const doing = [
    compact ? chalk.white(compact) : '',
    teamLine,
    ...formatFanOut(session, { subAgentCount, backgroundShellCount }),
  ].filter(Boolean);
  if (doing.length) {
    lines.push(verbLabel('Doing') + doing.join(DOT));
  }
  const todosRendered = todos?.items?.length ? renderTodos(todos.items, termWidth) : [];
  for (const l of todosRendered) lines.push('  ' + l);

  // Made — what the session produced: file deltas, reads, artifacts (named +
  // clickable), the plan file, and the PR when the session carries one.
  const made: string[] = [];
  const changed = chg.created + chg.modified + chg.deleted;
  if (changed) {
    const parts = [
      chg.created ? chalk.green(`+${chg.created}`) : '',
      chg.modified ? chalk.yellow(`~${chg.modified}`) : '',
      chg.deleted ? chalk.red(`−${chg.deleted}`) : '',
    ].filter(Boolean).join(' ');
    made.push(`${parts} ${chalk.gray('changed')}`);
  }
  if (filesRead) made.push(chalk.gray(`${filesRead} read`));
  if (artifacts.length) {
    const shown = artifacts.slice(0, 2).map(a => linkPath(a.path, a.basename));
    const more = artifacts.length > 2 ? chalk.gray(` +${artifacts.length - 2}`) : '';
    made.push(shown.join(chalk.gray(' · ')) + more);
  }
  if (planFile) {
    made.push(chalk.white(linkPath(planFile, planFile.split('/').pop() || planFile)));
  }
  if (session.prUrl) {
    made.push(chalk.blue(linkUrl(session.prUrl, session.prNumber ? `PR#${session.prNumber}` : 'PR')));
  }
  if (made.length) {
    lines.push(verbLabel('Made') + made.join(DOT));
  }

  // Health — error tally + the last test/build verdict; absent when both clean.
  const health: string[] = [];
  if (errorCount) {
    health.push(chalk.red(`${errorCount} failure${errorCount === 1 ? '' : 's'}`) + chalk.gray(` — first: ${firstError || 'unknown'}`));
  }
  if (test?.ok) {
    const bits = [
      test.passed !== undefined ? chalk.green(`${test.passed} pass`) : '',
      test.failed ? chalk.red(`${test.failed} fail`) : '',
    ].filter(Boolean).join(chalk.gray(' · '));
    const mark = test.failed ? chalk.red('✗') : chalk.green('✓');
    health.push(`${mark} ${test.runner}${bits ? ' ' + bits : ''}`);
  }
  if (health.length) {
    lines.push(verbLabel('Health') + health.join(DOT));
  }

  // Cost — volume: messages, tokens (moved here from the header's old line 3),
  // and the top of the tool mix.
  const totalMessages = session.messageCount ?? (events ? countMessages(events) : undefined);
  const cost: string[] = [];
  if (totalMessages !== undefined) {
    cost.push(chalk.white(String(totalMessages)) + chalk.gray(` msg${totalMessages === 1 ? '' : 's'}`));
  }
  if (session.tokenCount !== undefined) {
    cost.push(chalk.white(formatTokens(session.tokenCount)) + chalk.gray(' tokens'));
  }
  if (hist.length) {
    cost.push(chalk.gray(hist.map(h => `${h.tool} ${h.count}`).join(' · ')));
  } else if (toolCalls) {
    cost.push(chalk.gray(`${toolCalls} tool${toolCalls === 1 ? '' : 's'}`));
  }
  if (cost.length) {
    lines.push(verbLabel('Cost') + cost.join(DOT));
  }

  // Latest — the agent's last message, full and wrapped to the pane (the densest
  // line in the preview; parts 1-2 of RUSH-2757 made it wrap instead of clip).
  if (lastAssistant) {
    const maxLines = todosRendered.length > 0 || compact ? LAST_RESPONSE_MAX_LINES_WITH_TODOS : LAST_RESPONSE_MAX_LINES;
    // Content sits at column 4 (outer body indent + the '  ' prefix below), so
    // wrap it to the pane minus that indent.
    const rendered = renderLastResponse(lastAssistant, maxLines, terminalWidth() - 4);
    if (rendered.length > 0) {
      lines.push('');
      lines.push(chalk.cyan('Latest'));
      for (const l of rendered) lines.push('  ' + l);
    }
  }

  // Details ▸ — the folded long tail: session id, skills, plugins, hooks, links,
  // dirs, repos, capability tags. One width-capped line instead of seven labeled
  // rows (a long tail used to wrap and swamp the whole pane); links stay
  // clickable (OSC 8), hook failures stay red. Full lists go to the cap — it is
  // the ONLY bounding, so its `… +N more` tail accounts for every hidden item
  // (pre-slicing here made overflow vanish with no trace).
  const details: string[] = [
    session.filePath ? chalk.gray(linkPath(session.filePath, session.id.slice(0, 8))) : chalk.gray(session.id.slice(0, 8)),
    ...skills.map(s => chalk.white(s.name) + (s.count > 1 ? chalk.gray(` ×${s.count}`) : '')),
    ...plugins.map(p => chalk.white(p)),
    ...hooks.map(h => chalk.white(h.name) + (h.failed ? chalk.red(` (${h.failed} failed)`) : '')),
    ...links.map(l => chalk.blue(linkUrl(l.url, l.label))),
    ...dirs.map(d => chalk.gray(d)),
    ...repos.map(r => chalk.gray(r)),
    ...toolTags.map(t => chalk.gray(t)),
  ];
  lines.push(verbLabel('Details ▸') + joinWidthCapped(details, valueWidth));

  return lines.map(l => '  ' + l).join('\n');
}

function classifySessionTool(tool: string, command: string): string[] {
  const toolName = tool.toLowerCase();
  const commandUses = (surface: 'browser' | 'computer') => (
    new RegExp(`\\b(?:agents|ag)\\b[^\\n;&|]*\\b${surface}\\b`).test(command.toLowerCase())
  );
  const tags: string[] = [];
  if (/browser|webfetch|websearch/.test(toolName) || commandUses('browser')) tags.push('browser');
  if (/computer/.test(toolName) || commandUses('computer')) tags.push('computer');
  return tags;
}

/**
 * Unique directories the session touched, compact and human-readable.
 * Prefer `session.recentDirectoriesTouched` — the scan records it on the row, so
 * it is present for remote rows whose transcript we can't parse here — otherwise
 * derive from the file-change + tool paths already available.
 */
export function directoriesTouched(
  session: SessionMeta,
  events: SessionEvent[],
  changes: ReturnType<typeof classifyFileChanges>,
): string[] {
  const fromMeta = session.recentDirectoriesTouched;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
    // The scan stores ABSOLUTE paths, so they go through the same relativizer the
    // derived branch below uses — otherwise adopting this field (which a remote row
    // needs, having no transcript to derive from) would turn every local preview's
    // `Dirs:` line from `src/lib · docs` into a column of full home-rooted paths.
    const seen = new Set<string>();
    for (const raw of fromMeta) {
      const dir = relativizeDir(sanitizeForTerminal(String(raw).trim()), session.cwd);
      if (dir) seen.add(dir);
      if (seen.size >= DIRS_TOUCHED_MAX) break;
    }
    if (seen.size > 0) return [...seen];
  }

  const counts = new Map<string, number>();
  const bump = (raw: string) => {
    const dir = relativizeDir(raw, session.cwd);
    if (!dir) return;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  };
  for (const ch of changes) bump(ch.path);
  for (const event of events) {
    if (event.type !== 'tool_use' || event._local) continue;
    const p = event.path || event.args?.file_path || event.args?.path || '';
    if (p) bump(p);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([d]) => d)
    .slice(0, DIRS_TOUCHED_MAX);
}

/**
 * Claude names its per-project transcript store `~/.claude/projects/<slug>`, where
 * `<slug>` is the cwd with every `/` AND `.` replaced by `-` — so `/Users/me/app`
 * → `-Users-me-app` and `.agents/worktrees/x` → `--agents-worktrees-x`. That slug
 * leaks into transcript paths as a leading segment (`<slug>/<session-id>/…`).
 *
 * The encoding is LOSSY and irreversible (`-`, `/`, and `.` all collapse to `-`),
 * so we never try to decode it back to a path. Instead we ENCODE the comparison
 * targets (cwd, the worktree marker) into the same slug space and match there. See
 * {@link relativizeDir}. `encodeClaudeSlug` mirrors Claude's own transform.
 */
function encodeClaudeSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

/** The `.agents/worktrees/<name>` marker, Claude-slug-encoded (`/.` → `--`). */
const SLUG_WORKTREE_RE = /--agents-worktrees-(.+)$/;

/**
 * Join display tokens with ` · `, stopping before the line exceeds `maxWidth`
 * and appending `… +N more` for the rest. Keeps the Dirs line on one row.
 */
/**
 * Join pre-styled items with ` · ` up to a visible width, then `… +N more`.
 * Width is measured ANSI-aware (stringWidth), so colored / OSC 8-linked items
 * are not miscounted; items arrive already styled and are not recolored.
 */
function joinWidthCapped(items: string[], maxWidth: number): string {
  let out = '';
  let width = 0;
  let shown = 0;
  for (const item of items) {
    const itemWidth = stringWidth(item);
    const nextWidth = shown === 0 ? itemWidth : width + 3 + itemWidth;
    if (shown > 0 && nextWidth > maxWidth) break;
    out = shown === 0 ? item : out + DOT + item;
    width = nextWidth;
    shown++;
  }
  const remaining = items.length - shown;
  return out + (remaining > 0 ? chalk.gray(` … +${remaining} more`) : '');
}

/** Relativize a file path to its parent dir, short enough for one preview line. */
export function relativizeDir(filePath: string, cwd?: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/');
  if (!norm || norm.includes('node_modules') || norm.includes('/.git/') || norm.includes('/plans/')) {
    return undefined;
  }
  // agents-cli internals — version homes, session/run archives, the bare
  // worktree container/root — are never meaningful "directories the user works
  // in". Cwd is exempt: a session running inside such a dir keeps its own paths.
  const normBase = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  const underCwd = normBase && (norm === normBase || norm.startsWith(normBase + '/'));
  if (!underCwd && (norm.includes('/.agents/.history/') || /\/\.agents\/worktrees(\/[^/]+)?\/?$/.test(norm))) {
    return undefined;
  }
  let dir = path.posix.dirname(norm);

  // Claude project-slug form: a leading `-`-segment (`-home-me-…`) that carries
  // the cwd, lossily encoded. Handle it in SLUG SPACE — never lossy-decode to a
  // fake path. The slug is the first path segment; any real `/`-subdirs after it
  // are Claude's internal storage (`<session-id>/scratchpad|tasks`), not code.
  if (dir.startsWith('-')) {
    const slash = dir.indexOf('/');
    const slug = slash === -1 ? dir : dir.slice(0, slash);
    // CWD FIRST: if the slug is (or is under) this session's own cwd, the leaked
    // path is Claude's internal projects-storage scratch (`<id>/scratchpad`) —
    // not a meaningful code dir — so drop it like node_modules. Precedence over
    // the worktree collapse so a session editing its OWN worktree isn't relabeled.
    if (cwd) {
      const cwdSlug = encodeClaudeSlug(cwd.replace(/\\/g, '/').replace(/\/$/, ''));
      if (slug === cwdSlug || slug.startsWith(cwdSlug + '-')) return undefined;
    }
    // Only a DIFFERENT worktree than cwd reaches here: a worktree encodes its
    // `/.agents/worktrees/<name>` marker as `--agents-worktrees-<name>`, so
    // collapse to the worktree name to disambiguate. (The name may contain `-`;
    // we can't losslessly re-split it, so show the whole encoded remainder.)
    const wtSlug = slug.match(SLUG_WORKTREE_RE);
    if (wtSlug) return `⧉ ${wtSlug[1]}`;
    // An unattributable slug: don't invent a `/`-joined fake path. Show only the
    // trailing `-`-group as a minimal, honest token.
    const segs = slug.split('-').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : undefined;
  }

  // CWD FIRST for real paths too: strip the session-cwd prefix so a session
  // editing its OWN worktree renders the concise relative remainder (`src/lib`),
  // not the longer `⧉ <slug>/…` collapse.
  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (dir === base) return '.';
    if (dir.startsWith(base + '/')) return dir.slice(base.length + 1);
  }
  // No cwd match. If the dir is in a (different) git worktree, collapse to the
  // worktree NAME + in-worktree remainder to disambiguate; else home→`~` + trim.
  const wt = dir.match(WORKTREE_RE);
  if (wt) {
    const after = dir.slice(dir.indexOf(wt[0]) + wt[0].length).replace(/^\//, '');
    return after ? `⧉ ${wt[1]}/${after}` : `⧉ ${wt[1]}`;
  }
  // Collapse home prefix.
  const home = (process.env.HOME || '').replace(/\\/g, '/');
  if (home && dir.startsWith(home + '/')) dir = '~' + dir.slice(home.length);
  // Drop ultra-deep absolute noise; keep last 3 segments.
  const parts = dir.split('/').filter(Boolean);
  if (parts.length > 3 && dir.startsWith('/')) dir = parts.slice(-3).join('/');
  return dir || undefined;
}

export function renderLastResponse(
  content: string,
  maxLines: number = LAST_RESPONSE_MAX_LINES,
  width: number = terminalWidth(),
): string[] {
  const cleaned = stripTags(content).trim();
  if (!cleaned) return [];

  let rendered: string;
  try {
    rendered = renderMarkdown(cleaned);
  } catch {
    rendered = cleaned;
  }

  // `marked-terminal` runs with `reflowText` off, so a paragraph with no hard
  // breaks renders as one long line that overflows the pane. Wrap any line whose
  // VISIBLE width exceeds the budget; leave lines that already fit untouched so
  // rendered-markdown indentation (lists, code blocks) is preserved. The text is
  // ANSI-coloured, so width is measured with `stringWidth`, never `String.length`.
  const all = rendered
    .replace(/\s+$/, '')
    .split('\n')
    .flatMap(line => (stringWidth(line) <= width ? [line] : wrapToWidth(line, width)));
  // Drop leading/trailing empty lines
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();

  if (all.length <= maxLines) return all;
  const shown = all.slice(0, maxLines);
  const more = all.length - maxLines;
  shown.push(chalk.gray(`… (${more} more line${more === 1 ? '' : 's'})`));
  return shown;
}

function renderTodos(todos: Array<{ content?: string; text?: string; status?: string }>, termWidth: number): string[] {
  const out: string[] = [];
  const shown = todos.slice(0, TODOS_MAX_ITEMS);
  // Outer body indent (2) + inner '  ' (2) + marker (3) + space (1) = 8
  const maxText = Math.max(20, termWidth - 8);
  for (const item of shown) {
    const rawText = (item.content || item.text || '').trim();
    if (!rawText) continue;
    const text = truncate(rawText, maxText);
    const status = item.status || 'pending';
    let marker: string;
    let textOut: string;
    if (status === 'completed') {
      marker = chalk.green('[x]');
      textOut = chalk.gray(text);
    } else if (status === 'in_progress') {
      marker = chalk.yellow('[>]');
      textOut = chalk.white(text);
    } else {
      marker = chalk.gray('[ ]');
      textOut = chalk.white(text);
    }
    out.push(marker + ' ' + textOut);
  }
  if (todos.length > TODOS_MAX_ITEMS) {
    const more = todos.length - TODOS_MAX_ITEMS;
    out.push(chalk.gray(`… (${more} more)`));
  }
  return out;
}


/** Show an interactive session picker and return the selected session with its action (resume or view). */
export async function sessionPicker(config: SessionPickerConfig): Promise<PickedSession | null> {
  const picked = await itemPicker<SessionMeta>({
    message: config.message,
    subtitle: config.subtitle,
    items: config.sessions,
    filter: config.filter,
    labelFor: config.labelFor,
    buildPreview,
    // A remote row's digest arrives over SSH after the pane painted — this is
    // what lets its completion swap the metadata card for the full preview.
    registerPreviewRepaint: setRemotePreviewRepaint,
    shortIdFor: (s) => s.shortId,
    pageSize: config.pageSize,
    initialSearch: config.initialSearch,
    emptyMessage: 'No sessions match.',
    enterHint: config.enterHint ?? 'resume',
    linesAbovePrompt: config.linesAbovePrompt,
    // A late digest fetch must not poke a closed prompt.
  }).finally(() => setRemotePreviewRepaint(undefined));
  if (!picked) return null;
  return { session: picked.item, action: 'resume' };
}
