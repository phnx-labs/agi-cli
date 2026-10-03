import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getUserAgentsDir } from '../state.js';
import { parseClaudeContent, sanitizeEvents } from './parse.js';
import type { SessionEvent, SessionSubagent } from './types.js';
import type { ActiveSession } from './active.js';
import { indexArtifactSidecars, mergeArtifacts } from './highlights.js';

const directoryCache = new Map<string, { mtimeMs: number; files: string[] }>();
const subagentCache = new Map<string, { stamp: string; row: Omit<SessionSubagent, 'status'>; toolUseId?: string; mtimeMs: number }>();

/** Directory membership is cached; child mtimes must also be checked because appends do not touch the directory. */
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
  } catch { return undefined; }
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
      try { const metaStat = fs.statSync(metaPath); metaStamp = `${metaStat.mtimeMs}:${metaStat.size}`; } catch { /* meta may follow the transcript */ }
      const stamp = `${stat.mtimeMs}:${stat.size}:${metaStamp}`;
      let cached = subagentCache.get(file);
      if (!cached || cached.stamp !== stamp) {
        let meta: Record<string, unknown> = {};
        if (metaStamp) { try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* incomplete metadata */ } }
        const events = parseClaudeContent(fs.readFileSync(file, 'utf8'));
        sanitizeEvents(events);
        const stamps = events.map(event => Date.parse(event.timestamp)).filter(Number.isFinite);
        const lastReply = events.filter(event => event.type === 'message' && event.role === 'assistant').at(-1)?.content;
        const row: Omit<SessionSubagent, 'status'> = {
          id: path.basename(file, '.jsonl'),
          agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
          description: typeof meta.description === 'string' ? meta.description : '',
          ...(stamps.length ? { startedAtMs: stamps[0], endedAtMs: stamps[stamps.length - 1] } : {}),
          toolCount: events.filter(event => event.type === 'tool_use').length,
          ...(lastReply ? { resultExcerpt: lastReply.slice(0, 200) } : {}),
          transcriptPath: file,
        };
        cached = { stamp, row, toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : undefined, mtimeMs: stat.mtimeMs };
        if (subagentCache.size >= 512) subagentCache.clear();
        subagentCache.set(file, cached);
      }
      rows.push({ ...cached.row, status: cached.toolUseId && failedCalls.includes(cached.toolUseId)
        ? 'failed' : parentLive && nowMs - cached.mtimeMs < 120_000 ? 'running' : 'done' });
    } catch { /* A child can disappear between the directory scan and read. */ }
  }
  return rows.sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) || a.id.localeCompare(b.id)).slice(0, 30);
}

const IMAGE_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/** Exclusive creation preserves existing images across ticks and process restarts. */
export function materializeInlineImages(events: SessionEvent[], sessionId: string, root = path.join(getUserAgentsDir(), '.cache', 'attachments')): void {
  if (!sessionId || path.basename(sessionId) !== sessionId || sessionId === '.' || sessionId === '..') return;
  const dir = path.join(root, sessionId);
  let images: Set<string> | undefined;
  for (const event of events) {
    const data = event._imageData;
    delete event._imageData;
    if (!data || event.path || event.type !== 'attachment') continue;
    const ext = IMAGE_EXTENSIONS[event.mediaType ?? ''];
    if (!ext || Buffer.byteLength(data, 'base64') > 5 * 1024 * 1024) continue;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length) continue;
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    try {
      if (!images) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        images = new Set(fs.readdirSync(dir));
      }
      if (!images.has(name)) {
        if (images.size >= 10) continue;
        try { fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx', mode: 0o600 }); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
        images.add(name);
      }
      event.path = path.join(dir, name);
      event.sizeBytes = bytes.length;
    } catch { /* Cache permissions must not make the session unreadable. */ }
  }
}

/** One artifact walk per active scan, never one per row. */
export function enrichGlanceFiles(rows: ActiveSession[], nowMs = Date.now()): void {
  const artifacts = indexArtifactSidecars();
  for (const row of rows) {
    if (!row.sessionId) continue;
    row.artifacts = mergeArtifacts(row.artifacts ?? [], artifacts.get(row.sessionId) ?? []);
    if (!row.artifacts.length) delete row.artifacts;
    row.planFile = row.artifacts?.find(artifact => artifact.bucket === 'plans')?.path ?? row.planFile;
    if (row.kind === 'claude' && row.sessionFile) {
      const subagents = readSessionSubagents(row.sessionFile, row.pidAlive === true, [], nowMs);
      if (subagents) {
        // Retain a failure already observed by the parent transcript fold.
        const failed = new Set(row.subagents?.filter(agent => agent.status === 'failed').map(agent => agent.id));
        row.subagents = subagents.map(agent => failed.has(agent.id) ? { ...agent, status: 'failed' } : agent);
        row.subAgentCount = row.subagents.length;
      }
    }
  }
}
