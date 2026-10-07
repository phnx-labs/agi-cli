import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getUserAgentsDir } from '../state.js';
import { indexArtifactSidecars, mergeArtifacts, parseClaudeContent, sanitizeEvents } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent, SessionSubagent } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession, WatchSubagent } from './active.js';

export const SUBAGENT_PROMPT_MAX_CHARS = 400;

const directoryCache = new Map<string, { mtimeMs: number; files: string[] }>();

interface ChildFold {
  offset: number;
  pending: string;
  size: number;
  metaStamp: string;
  mtimeMs: number;
  toolCount: number;
  startedAtMs?: number;
  endedAtMs?: number;
  resultExcerpt?: string;
  model?: string;
  prompt?: string;
  promptTurnId?: string;
  promptDone?: boolean;
  agentType: string;
  description: string;
  toolUseId?: string;
}

const childFolds = new Map<string, ChildFold>();

const MAX_CHILD_BYTES_PER_READ = 256 * 1024;
const MAX_CHILD_PENDING_BYTES = 1024 * 1024;

export function resolvedSubAgentCount(children: readonly string[] | undefined, toolCount: number): number {
  return children && children.length > 0 ? Math.min(30, children.length) : toolCount;
}

export function claudeSubagentFiles(sessionFile: string): string[] | undefined {
  const dir = path.resolve(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  try {
    const { mtimeMs } = fs.statSync(dir);
    let cached = directoryCache.get(dir);
    if (!cached || cached.mtimeMs !== mtimeMs) {
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name))
        .map(entry => path.join(dir, entry.name));
      cached = { mtimeMs, files };
      if (directoryCache.size >= 512) directoryCache.clear();
      directoryCache.set(dir, cached);
    }
    return cached.files;
  } catch {
    return undefined;
  }
}

function foldChildEvents(fold: ChildFold, events: SessionEvent[]): void {
  for (const event of events) {
    const atMs = Date.parse(event.timestamp);
    if (Number.isFinite(atMs)) {
      fold.startedAtMs = Math.min(fold.startedAtMs ?? atMs, atMs);
      fold.endedAtMs = Math.max(fold.endedAtMs ?? atMs, atMs);
    }
    if (event.type === 'tool_use' && !event._local) fold.toolCount++;
    if (event.role === 'assistant' && event.model && (event.type === 'message' || event.type === 'usage')) fold.model = event.model;
    if (event.type === 'message' && event.role === 'assistant' && event.content) {
      fold.resultExcerpt = event.content.slice(0, 200);
    }
    if (event.type === 'message' && event.role === 'user' && !fold.promptDone) foldPrompt(fold, event);
  }
}

function foldPrompt(fold: ChildFold, event: SessionEvent): void {
  if (fold.prompt !== undefined && event._turnId !== fold.promptTurnId) { fold.promptDone = true; return; }
  if (event._synthetic || event._meta) return;
  const text = (event.content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const joined = fold.prompt ? `${fold.prompt} ${text}` : text;
  fold.prompt = joined.length > SUBAGENT_PROMPT_MAX_CHARS ? joined.slice(0, SUBAGENT_PROMPT_MAX_CHARS) : joined;
  fold.promptTurnId = event._turnId;
  if (event._turnId === undefined || joined.length >= SUBAGENT_PROMPT_MAX_CHARS) fold.promptDone = true;
}

function advanceChild(file: string, fold: ChildFold, size: number): void {
  if (size < fold.offset) {
    fold.offset = 0;
    fold.pending = '';
    fold.toolCount = 0;
    fold.startedAtMs = undefined;
    fold.endedAtMs = undefined;
    fold.resultExcerpt = undefined;
    fold.model = undefined;
    fold.prompt = undefined;
    fold.promptTurnId = undefined;
    fold.promptDone = undefined;
  }
  const end = Math.min(size, fold.offset + MAX_CHILD_BYTES_PER_READ);
  if (end <= fold.offset) return;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(end - fold.offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, fold.offset);
    fold.offset += read;
    const text = fold.pending + buffer.toString('utf8', 0, read);
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
    fold.pending = lastNl >= 0 ? text.slice(lastNl + 1) : text;
    if (Buffer.byteLength(fold.pending) > MAX_CHILD_PENDING_BYTES) fold.pending = '';
    if (!complete) return;
    const events = parseClaudeContent(complete);
    sanitizeEvents(events);
    foldChildEvents(fold, events);
  } finally {
    fs.closeSync(fd);
  }
}

export function readSessionSubagents(
  sessionFile: string,
  parentLive: boolean,
  failedCalls: readonly string[] = [],
  nowMs = Date.now(),
): WatchSubagent[] | undefined {
  const files = claudeSubagentFiles(sessionFile);
  if (!files) return undefined;
  const rows: WatchSubagent[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const metaPath = file.replace(/\.jsonl$/, '.meta.json');
      let metaStamp = '';
      try {
        const metaStat = fs.statSync(metaPath);
        metaStamp = `${metaStat.mtimeMs}:${metaStat.size}`;
      } catch {  }
      let fold = childFolds.get(file);
      if (!fold || fold.metaStamp !== metaStamp) {
        let meta: Record<string, unknown> = {};
        if (metaStamp) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {  }
        }
        fold = {
          offset: fold?.offset ?? 0,
          pending: fold?.pending ?? '',
          size: fold?.size ?? 0,
          metaStamp,
          mtimeMs: stat.mtimeMs,
          toolCount: fold?.toolCount ?? 0,
          startedAtMs: fold?.startedAtMs,
          endedAtMs: fold?.endedAtMs,
          resultExcerpt: fold?.resultExcerpt,
          model: fold?.model,
          prompt: fold?.prompt,
          promptTurnId: fold?.promptTurnId,
          promptDone: fold?.promptDone,
          agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
          description: typeof meta.description === 'string' ? meta.description : '',
          toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined,
        };
        if (childFolds.size >= 512) childFolds.clear();
        childFolds.set(file, fold);
      }
      if (fold.size !== stat.size || fold.offset < stat.size) {
        advanceChild(file, fold, stat.size);
        fold.size = stat.size;
        fold.mtimeMs = stat.mtimeMs;
      }
      const status: SessionSubagent['status'] = fold.toolUseId && failedCalls.includes(fold.toolUseId)
        ? 'failed'
        : parentLive && nowMs - fold.mtimeMs < 120_000 ? 'running' : 'done';
      rows.push({
        id: path.basename(file, '.jsonl'),
        agentType: fold.agentType,
        description: fold.description,
        status,
        ...(fold.startedAtMs !== undefined ? { startedAtMs: fold.startedAtMs, endedAtMs: fold.endedAtMs } : {}),
        toolCount: fold.toolCount,
        ...(fold.resultExcerpt ? { resultExcerpt: fold.resultExcerpt } : {}),
        ...(fold.model ? { model: fold.model } : {}),
        ...(fold.prompt ? { prompt: fold.prompt } : {}),
        transcriptPath: file,
      });
    } catch {  }
  }
  return rows.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) || a.id.localeCompare(b.id)).slice(0, 30);
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BASE64 = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4;

const openInlineImages = new Map<string, { base64: string; mediaType: string; dropped: boolean }>();
const pendingImagePaths = new Map<string, { path: string; size: number }[]>();

export function hasOpenInlineImage(sessionId: string): boolean {
  return openInlineImages.has(sessionId);
}

export function dropOpenInlineImage(sessionId: string): void {
  openInlineImages.delete(sessionId);
  pendingImagePaths.delete(sessionId);
}

export function appendInlineImage(sessionId: string, chunk: string, mediaType: string): void {
  if (!chunk) return;
  let open = openInlineImages.get(sessionId);
  if (!open) {
    open = { base64: '', mediaType, dropped: false };
    openInlineImages.set(sessionId, open);
  }
  if (open.dropped || open.base64.length + chunk.length > MAX_IMAGE_BASE64) {
    open.dropped = true;
    open.base64 = '';
    return;
  }
  open.base64 += chunk;
}

export function finishInlineImage(sessionId: string, root?: string): void {
  const open = openInlineImages.get(sessionId);
  openInlineImages.delete(sessionId);
  if (!open || open.dropped || !open.base64) return;
  const cached = cacheInlineImage(sessionId, open.base64, open.mediaType, root);
  if (!cached) return;
  const list = pendingImagePaths.get(sessionId) ?? [];
  list.push(cached);
  pendingImagePaths.set(sessionId, list);
}

export function takePendingImagePaths(sessionId: string): { path: string; size: number }[] {
  const list = pendingImagePaths.get(sessionId) ?? [];
  pendingImagePaths.delete(sessionId);
  return list;
}

export function cacheInlineImage(sessionId: string, data: string, mediaType: string, root = path.join(getUserAgentsDir(), '.cache', 'attachments')): { path: string; size: number } | undefined {
  const safe = Boolean(sessionId) && path.basename(sessionId) === sessionId && sessionId !== '.' && sessionId !== '..';
  const ext = IMAGE_EXTENSIONS[mediaType];
  if (!safe || !data || !ext || Buffer.byteLength(data, 'base64') > MAX_IMAGE_BYTES) return undefined;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) return undefined;
  const dir = path.join(root, sessionId);
  const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
  const file = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const images = new Set(fs.readdirSync(dir));
    if (!images.has(name)) {
      if (images.size >= 10) return undefined;
      try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
      fs.chmodSync(file, 0o600);
    }
    return { path: file, size: bytes.length };
  } catch {
    return undefined;
  }
}

export function materializeInlineImages(events: SessionEvent[], sessionId: string, root = path.join(getUserAgentsDir(), '.cache', 'attachments')): void {
  for (const event of events) {
    const data = event._imageData;
    delete event._imageData;
    if (!data || event.path || event.type !== 'attachment') continue;
    const cached = cacheInlineImage(sessionId, data, event.mediaType ?? '', root);
    if (!cached) continue;
    event.path = cached.path;
    event.sizeBytes = cached.size;
  }
}

export function enrichGlanceFiles(rows: ActiveSession[], nowMs = Date.now()): void {
  const artifacts = indexArtifactSidecars(path.join(getUserAgentsDir(), 'artifacts'), nowMs);
  for (const row of rows) {
    if (!row.sessionId) continue;
    row.artifacts = mergeArtifacts(row.artifacts ?? [], artifacts.get(row.sessionId) ?? []);
    if (!row.artifacts.length) delete row.artifacts;
    const plan = row.artifacts?.find(artifact => artifact.bucket === 'plans')?.path;
    if (plan) row.planFile = plan;
    if (row.kind === 'claude' && row.sessionFile) {
      const files = claudeSubagentFiles(row.sessionFile);
      if (!files || files.length === 0) continue;
      const subagents = readSessionSubagents(row.sessionFile, row.pidAlive === true, [], nowMs);
      if (!subagents?.length) continue;
      const failed = new Set(row.subagents?.filter(agent => agent.status === 'failed').map(agent => agent.id));
      row.subagents = subagents.map(agent => failed.has(agent.id) ? { ...agent, status: 'failed' as const } : agent);
      row.subAgentCount = row.subagents.length;
    }
  }
}
