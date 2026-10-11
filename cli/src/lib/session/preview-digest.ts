import fs from 'node:fs';
import path from 'node:path';
import type { SessionEvent, SessionMeta, TodoProgress } from '@phnx-labs/sessions-cli/reader';
import {
  changeCounts,
  classifyFileChanges,
  detectTestResult,
  extractArtifacts,
  extractHooks,
  extractLinks,
  extractRepos,
  extractSkills,
  extractTodoProgressFromEvents,
  firstUserMessageFromEvents,
  harnessTracksBackgroundShells,
  inferSessionState,
  isBackgroundShellStart,
  isSubAgentTool,
  parseSession,
  readSessionHead,
  readSessionTail,
  sanitizeForTerminal,
  toolHistogram,
  WORKTREE_RE,
} from '@phnx-labs/sessions-cli/reader';
import { formatBytes } from '../format.js';
import { getSessionPlugins, readArchivedSessionPreview, readSessionPreviewCache, writeSessionPreviewCache } from './db.js';
import { cachedAttachmentImages, materializeInlineImages, mergePreviewImages, previewImagesFromEvents, previewSubAgentsFromEvents, previewSubAgentsFromFiles } from './glance-files.js';
import type { SessionPreviewDigest } from './presentation.js';

export const DIRS_TOUCHED_MAX = 5;
export const CHANGED_FILES_MAX = 200;
const PREVIEW_DIGEST_MAX_PARSE_BYTES = 4 * 1024 * 1024;

// Peer metadata is untrusted: bound its shape and strip terminal escapes before rendering.
export function sanitizeMeta(s: SessionMeta): SessionMeta {
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

export function readCachedPreviewDigest(session: SessionMeta): SessionPreviewDigest | undefined {
  if (!session.filePath) return readArchivedSessionPreview<SessionPreviewDigest>(session.id);
  let stamp: fs.Stats;
  try { stamp = fs.statSync(session.filePath); }
  catch { return readArchivedSessionPreview<SessionPreviewDigest>(session.id); }
  return readSessionPreviewCache<SessionPreviewDigest>(session.id, { fileMtimeMs: stamp.mtimeMs, fileSize: stamp.size });
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
    // Large uncached transcripts use bounded tail plus bounded head, so a tail follow-up is never mislabeled as the first prompt.
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
        events = parseSession(session.filePath, session.agent, { includeInlineImages: true });
        if (session.agent === 'claude') materializeInlineImages(events, session.id);
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
  applyLiveSessionFiles(digest, session);
  return { digest, events };
}

function applyLiveSessionFiles(digest: SessionPreviewDigest, session: SessionMeta): void {
  if (session.agent === 'claude' && session.filePath) {
    const children = previewSubAgentsFromFiles(session.filePath, digest.subAgents ?? []);
    if (children) {
      digest.subAgents = children;
      digest.subAgentCount = children.length;
    }
  }
  const known = new Set((digest.images ?? []).map(image => image.path));
  const images = mergePreviewImages(digest.images ?? [], cachedAttachmentImages(session.id).filter(image => !known.has(image.path)));
  if (images.length) digest.images = images;
  else delete digest.images;
  if (!digest.subAgents?.length) delete digest.subAgents;
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

export function buildSessionPreviewDigest(events: SessionEvent[], session: SessionMeta): SessionPreviewDigest {
  let firstUser = '';
  let lastAssistant = '';
  const filesRead = new Set<string>();
  const toolCounts: Record<string, number> = {};
  let toolCalls = 0;
  let planFile = '';
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
      if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      toolCalls++;
    }
  }

  if (session.usedBrowser) toolTags.add('browser');
  if (session.usedComputer) toolTags.add('computer');

  const todos: TodoProgress | undefined = extractTodoProgressFromEvents(events) ?? session.todos;

  const changes = classifyFileChanges(events);
  const chg = changeCounts(changes);

  const errorEvents = events.filter(e => e.type === 'error');
  const subAgents = previewSubAgentsFromEvents(events, isSubAgentTool);
  const producedArtifacts = inferSessionState(events, { cwd: session.cwd }).artifacts ?? [];
  const images = previewImagesFromEvents(events, changes, session.cwd);
  return {
    schemaVersion: 1,
    firstUser,
    lastAssistant,
    filesRead: filesRead.size,
    toolCalls,
    planFile,
    todos,
    subAgentCount,
    ...(subAgents.length ? { subAgents } : {}),
    ...(images.length ? { images } : {}),
    backgroundShellCount,
    toolTags: [...toolTags],
    changes: chg,
    changedFiles: changes.slice(0, CHANGED_FILES_MAX),
    dirs: directoriesTouched(session, events, changes),
    repos: extractRepos(events, session.cwd),
    artifacts: extractArtifacts(changes),
    ...(producedArtifacts.length ? { producedArtifacts } : {}),
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
