import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { truncate, humanDuration, formatBytes } from '../lib/format.js';
import type { SessionEvent, SessionMeta, TodoItem, TodoProgress } from '@phnx-labs/sessions-cli/reader';
import { sessionDisplayAgent } from '@phnx-labs/sessions-cli/reader';
import { fetchPeerPreviewDigest } from '../lib/session/remote-list.js';
import { parseSession, sanitizeForTerminal, SNAPSHOT_TODO_TOOLS } from '@phnx-labs/sessions-cli/reader';
import { readSessionTail, readSessionHead } from '@phnx-labs/sessions-cli/reader';
import { safeTeamText } from '@phnx-labs/sessions-cli/reader';
import { cleanSessionPrompt, extractSessionTopic, isSyntheticUserMessage, firstUserMessageFromEvents } from '@phnx-labs/sessions-cli/reader';
import { linkPath, linkUrl, relativeToCwd, shortenModel } from '@phnx-labs/sessions-cli/reader';
import { linearIssueUrl } from '@phnx-labs/sessions-cli/reader';
import { extractTodoProgress, WORKTREE_RE } from '@phnx-labs/sessions-cli/reader';
import { renderMarkdown } from '../lib/markdown.js';
import { wrapToWidth } from '../lib/wrap.js';
import { terminalWidth, stringWidth } from '../lib/session/width.js';
import { itemPicker } from '../lib/picker.js';
import { createMemoryCache } from '../lib/memory-cache.js';
import { classifyFileChanges, changeCounts, toolHistogram, detectTestResult } from '@phnx-labs/sessions-cli/reader';
import type { FileChange, FileOp } from '@phnx-labs/sessions-cli/reader';
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
} from '@phnx-labs/sessions-cli/reader';
import { getSessionPlugins, readSessionPreviewCache, writeSessionPreviewCache, readSessionContent, readArchivedSessionPreview } from '../lib/session/db.js';
import { machineId } from '../lib/session/sync/config.js';
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

export function formatTodoCompact(todos?: Pick<TodoProgress, 'done' | 'total' | 'activeForm'> | null): string {
  if (!todos || !Number.isFinite(todos.total) || todos.total < 1) return '';
  const done = Number.isFinite(todos.done) ? Math.max(0, todos.done) : 0;
  const tally = `✓${done}/${todos.total}`;
  const step = todos.activeForm?.replace(/\s+/g, ' ').trim();
  return step ? `${tally} · ${step}` : tally;
}

export function githubRepoUrlFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const norm = cwd.replace(/\\/g, '/');
  const m = norm.match(/\/github\.com\/([^/]+\/[^/]+)/);
  return m ? `https://github.com/${m[1]}` : undefined;
}

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

interface SessionPickerConfig {
  message: string;
  subtitle?: string;
  sessions: SessionMeta[];
  filter: (query: string) => SessionMeta[];
  labelFor: (s: SessionMeta, query: string) => string;
  pageSize?: number;
  initialSearch?: string;
  enterHint?: string;
  linesAbovePrompt?: number;
}

const previewCache = createMemoryCache<string, string>({
  max: 256,
  ttlMs: 5 * 60_000,
});

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

let remotePreviewRepaint: (() => void) | undefined;
export function setRemotePreviewRepaint(repaint?: () => void): void {
  remotePreviewRepaint = repaint;
}

let peerDigestFetcher: typeof fetchPeerPreviewDigest = fetchPeerPreviewDigest;
export function setPeerDigestFetcherForTest(fetcher?: typeof fetchPeerPreviewDigest): void {
  peerDigestFetcher = fetcher ?? fetchPeerPreviewDigest;
}
export function clearRemoteDigestCacheForTest(): void {
  remoteDigestCache.clear();
}

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
    backgroundShellCount: optNum(d.backgroundShellCount),
    toolTags: strList(d.toolTags),
    changes,
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
  const remoteDigestState = remote
    ? remoteDigestCache.get(remoteDigestKey(session.id, remote))?.state ?? 'none'
    : '';
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
    const archived = readArchivedSessionPreview<SessionPreviewDigest>(session.id);
    if (archived) {
      archived.plugins = getSessionPlugins(session.id);
      return { digest: archived, events: [] };
    }
    return { events: [], error: 'no local transcript for this session (metadata-only entry, no archived digest)' };
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
    if (sourceStamp.size > PREVIEW_DIGEST_MAX_PARSE_BYTES) {
      events = readSessionTail(session.filePath, session.agent);
      digest = buildSessionPreviewDigest(events, safe);
      if (session.firstUserMessage) {
        digest.firstUser = session.firstUserMessage;
      } else {
        digest.firstUser = firstUserMessageFromEvents(readSessionHead(session.filePath, session.agent)) ?? '';
      }
      digest.partial = true;
      digest.partialReason = `transcript is ${formatBytes(sourceStamp.size)}, over the ${formatBytes(PREVIEW_DIGEST_MAX_PARSE_BYTES)} bounded-parse limit for an uncached preview; digest reflects only the last ~128 KiB (tail) of the transcript, not the whole session`;
      writeSessionPreviewCache({
        id: session.id,
        fileMtimeMs: sourceStamp.mtimeMs,
        fileSize: sourceStamp.size,
        preview: digest,
      });
    } else {
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
  }
  digest.plugins = getSessionPlugins(session.id);
  return { digest, events };
}

export function buildPreview(session: SessionMeta): string {
  const remote = transcriptOnPeerOf(session);
  const cacheKey = previewCacheKey(session, remote);
  const cached = previewCache.get(cacheKey);
  if (cached) return cached;

  const safe = sanitizeMeta(session);

  if (remote) {
    const fetched = remoteDigestCache.get(remoteDigestKey(session.id, remote));
    if (fetched?.state === 'ready') {
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

  const line1: string[] = [];
  line1.push(chalk.gray(`${displayAgent(sessionDisplayAgent(session))}${session.version ? ` v${session.version}` : ''}`));
  if (session.shortId) line1.push(chalk.dim(session.shortId));
  if (model) line1.push(chalk.bold.white(shortenModel(model)));
  if (session.account) line1.push(chalk.gray(session.account));

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

  const line4: string[] = [];
  if (session.ticketId) {
    const url = linearIssueUrl(session.ticketId);
    line4.push(chalk.blue(url ? linkUrl(url, session.ticketId) : session.ticketId));
  }
  if (session.prUrl) {
    const label = session.prNumber ? `PR#${session.prNumber}` : 'PR';
    line4.push(chalk.blue(linkUrl(session.prUrl, label)));
  }

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

export function formatFanOut(
  session: SessionMeta,
  derived?: { subAgentCount?: number; backgroundShellCount?: number },
): string[] {
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

const TIMING_SPAN_MIN_MS = 60_000;

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

const SYSTEM_MESSAGE_PATTERNS = [
  /^\s*<environment_context>/i,
  /^\s*<system-reminder>/i,
  /^\s*<permissions\s/i,
  /^\s*<collaboration_mode>/i,
  /^\s*<local-command-caveat>/i,
  /^\s*# AGENTS\.md instructions for\b/i,
  /^\s*<command-(message|name|args)>/i,
];

function stripTags(text: string): string {
  let cleaned = text.replace(/<(system-reminder|environment_context|permissions[^>]*)>[\s\S]*?<\/\1>/gi, '');
  cleaned = cleaned.replace(/<\/?[a-z_-]+[^>]*>/gi, '');
  return cleaned;
}

const LAST_RESPONSE_MAX_LINES = 15;
const LAST_RESPONSE_MAX_LINES_WITH_TODOS = 8;
const TODOS_MAX_ITEMS = 5;
const DIRS_TOUCHED_MAX = 5;
const CHANGED_FILES_MAX = 200;

const PREVIEW_DIGEST_MAX_PARSE_BYTES = 4 * 1024 * 1024;

export interface SessionPreviewDigest {
  schemaVersion: 1;
  firstUser: string;
  lastAssistant: string;
  filesRead: number;
  toolCalls: number;
  planFile: string;
  todos?: TodoProgress;
  subAgentCount: number;
  backgroundShellCount?: number;
  toolTags: string[];
  changes: ReturnType<typeof changeCounts>;
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
  partial?: boolean;
  partialReason?: string;
}

export function buildSessionPreviewDigest(events: SessionEvent[], session: SessionMeta): SessionPreviewDigest {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
  let latestTodos: TodoProgress | undefined;
  let subAgentCount = 0;
  let backgroundShellCount: number | undefined = harnessTracksBackgroundShells(session.agent)
    ? 0
    : undefined;
  const toolTags = new Set<string>();
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
      if (SNAPSHOT_TODO_TOOLS.has(tool)) {
        const progress = extractTodoProgress(event.args);
        if (progress) latestTodos = progress;
      }
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  if (session.usedBrowser) toolTags.add('browser');
  if (session.usedComputer) toolTags.add('computer');

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

  const asked = firstUser
    ? (extractSessionTopic(firstUser) || cleanSessionPrompt(firstUser).split('\n').find(l => l.trim()) || '')
    : (session.topic && !isSyntheticUserMessage(session.topic) ? session.topic : '');
  if (asked.trim()) {
    lines.push(verbLabel('Asked') + chalk.white(`"${truncate(asked.trim(), valueWidth)}"`));
  }

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

  if (lastAssistant) {
    const maxLines = todosRendered.length > 0 || compact ? LAST_RESPONSE_MAX_LINES_WITH_TODOS : LAST_RESPONSE_MAX_LINES;
    const rendered = renderLastResponse(lastAssistant, maxLines, terminalWidth() - 4);
    if (rendered.length > 0) {
      lines.push('');
      lines.push(chalk.cyan('Latest'));
      for (const l of rendered) lines.push('  ' + l);
    }
  }

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

function directoriesTouched(
  session: SessionMeta,
  events: SessionEvent[],
  changes: ReturnType<typeof classifyFileChanges>,
): string[] {
  const fromMeta = session.recentDirectoriesTouched;
  if (Array.isArray(fromMeta) && fromMeta.length > 0) {
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

function encodeClaudeSlug(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

const SLUG_WORKTREE_RE = /--agents-worktrees-(.+)$/;

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

export function relativizeDir(filePath: string, cwd?: string): string | undefined {
  const norm = filePath.replace(/\\/g, '/');
  if (!norm || norm.includes('node_modules') || norm.includes('/.git/') || norm.includes('/plans/')) {
    return undefined;
  }
  const normBase = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  const underCwd = normBase && (norm === normBase || norm.startsWith(normBase + '/'));
  if (!underCwd && (norm.includes('/.agents/.history/') || /\/\.agents\/worktrees(\/[^/]+)?\/?$/.test(norm))) {
    return undefined;
  }
  let dir = path.posix.dirname(norm);

  if (dir.startsWith('-')) {
    const slash = dir.indexOf('/');
    const slug = slash === -1 ? dir : dir.slice(0, slash);
    if (cwd) {
      const cwdSlug = encodeClaudeSlug(cwd.replace(/\\/g, '/').replace(/\/$/, ''));
      if (slug === cwdSlug || slug.startsWith(cwdSlug + '-')) return undefined;
    }
    const wtSlug = slug.match(SLUG_WORKTREE_RE);
    if (wtSlug) return `⧉ ${wtSlug[1]}`;
    const segs = slug.split('-').filter(Boolean);
    return segs.length ? segs[segs.length - 1] : undefined;
  }

  if (cwd) {
    const base = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (dir === base) return '.';
    if (dir.startsWith(base + '/')) return dir.slice(base.length + 1);
  }
  const wt = dir.match(WORKTREE_RE);
  if (wt) {
    const after = dir.slice(dir.indexOf(wt[0]) + wt[0].length).replace(/^\//, '');
    return after ? `⧉ ${wt[1]}/${after}` : `⧉ ${wt[1]}`;
  }
  const home = (process.env.HOME || '').replace(/\\/g, '/');
  if (home && dir.startsWith(home + '/')) dir = '~' + dir.slice(home.length);
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

  const all = rendered
    .replace(/\s+$/, '')
    .split('\n')
    .flatMap(line => (stringWidth(line) <= width ? [line] : wrapToWidth(line, width)));
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


export async function sessionPicker(config: SessionPickerConfig): Promise<PickedSession | null> {
  const picked = await itemPicker<SessionMeta>({
    message: config.message,
    subtitle: config.subtitle,
    items: config.sessions,
    filter: config.filter,
    labelFor: config.labelFor,
    buildPreview,
    registerPreviewRepaint: setRemotePreviewRepaint,
    shortIdFor: (s) => s.shortId,
    pageSize: config.pageSize,
    initialSearch: config.initialSearch,
    emptyMessage: 'No sessions match.',
    enterHint: config.enterHint ?? 'resume',
    linesAbovePrompt: config.linesAbovePrompt,
  }).finally(() => setRemotePreviewRepaint(undefined));
  if (!picked) return null;
  return { session: picked.item, action: 'resume' };
}
