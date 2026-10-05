import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getUserAgentsDir } from '../state.js';
import { indexArtifactSidecars, mergeArtifacts, parseClaudeContent, sanitizeEvents } from '@phnx-labs/sessions-cli/reader';
import type { SessionEvent, SessionSubagent } from '@phnx-labs/sessions-cli/reader';
import type { ActiveSession } from './active.js';

const directoryCache = new Map<string, { mtimeMs: number; files: string[] }>();

interface ChildFold {
  /** Bytes of the child transcript already folded. A growing child is read from here, never from the start. */
  offset: number;
  /** Incomplete trailing line held only in memory, capped so one record cannot pin the process. */
  pending: string;
  size: number;
  metaStamp: string;
  mtimeMs: number;
  toolCount: number;
  startedAtMs?: number;
  endedAtMs?: number;
  resultExcerpt?: string;
  agentType: string;
  description: string;
  toolUseId?: string;
}

const childFolds = new Map<string, ChildFold>();

/** One child read per scan. A multi-megabyte running subagent catches up over scans. */
const MAX_CHILD_BYTES_PER_READ = 256 * 1024;
const MAX_CHILD_PENDING_BYTES = 1024 * 1024;

/** This session's own subagent transcripts win. An empty directory is not a count of zero. */
export function resolvedSubAgentCount(children: readonly string[] | undefined, toolCount: number): number {
  return children && children.length > 0 ? Math.min(30, children.length) : toolCount;
}

/** Directory membership is cached; child mtimes are checked separately because appends do not touch the directory. */
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
    if (event.type === 'message' && event.role === 'assistant' && event.content) {
      fold.resultExcerpt = event.content.slice(0, 200);
    }
  }
}

function advanceChild(file: string, fold: ChildFold, size: number): void {
  if (size < fold.offset) {
    fold.offset = 0;
    fold.pending = '';
    fold.toolCount = 0;
    fold.startedAtMs = undefined;
    fold.endedAtMs = undefined;
    fold.resultExcerpt = undefined;
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
): SessionSubagent[] | undefined {
  const files = claudeSubagentFiles(sessionFile);
  if (!files) return undefined;
  const rows: SessionSubagent[] = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const metaPath = file.replace(/\.jsonl$/, '.meta.json');
      let metaStamp = '';
      try {
        const metaStat = fs.statSync(metaPath);
        metaStamp = `${metaStat.mtimeMs}:${metaStat.size}`;
      } catch { /* meta may follow the transcript */ }
      let fold = childFolds.get(file);
      if (!fold || fold.metaStamp !== metaStamp) {
        let meta: Record<string, unknown> = {};
        if (metaStamp) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* incomplete metadata */ }
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
        transcriptPath: file,
      });
    } catch { /* A child can disappear between the directory scan and the read. */ }
  }
  return rows.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) || a.id.localeCompare(b.id)).slice(0, 30);
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Exclusive creation preserves existing images across ticks and process restarts. */
export function materializeInlineImages(events: SessionEvent[], sessionId: string, root = path.join(getUserAgentsDir(), '.cache', 'attachments')): void {
  const safe = Boolean(sessionId) && path.basename(sessionId) === sessionId && sessionId !== '.' && sessionId !== '..';
  const dir = path.join(root, sessionId);
  let images: Set<string> | undefined;
  for (const event of events) {
    const data = event._imageData;
    delete event._imageData;
    if (!safe || !data || event.path || event.type !== 'attachment') continue;
    const ext = IMAGE_EXTENSIONS[event.mediaType ?? ''];
    if (!ext || Buffer.byteLength(data, 'base64') > 5 * 1024 * 1024) continue;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) continue;
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    try {
      if (!images) {
        fs.mkdirSync(dir, { recursive: true });
        fs.chmodSync(dir, 0o700);
        images = new Set(fs.readdirSync(dir));
      }
      if (!images.has(name)) {
        if (images.size >= 10) continue;
        const file = path.join(dir, name);
        try { fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
        fs.chmodSync(file, 0o600);
        images.add(name);
      }
      event.path = path.join(dir, name);
      event.sizeBytes = bytes.length;
    } catch { /* Cache permissions must not make the session unreadable. */ }
  }
}

/** One artifact walk per active scan, never one per row. */
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
