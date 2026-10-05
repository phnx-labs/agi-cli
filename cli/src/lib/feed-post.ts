import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  appendActivityEvent,
  readRecentActivity,
  type ActivityEvent,
  type Attachment,
} from './feed/activity.js';
import { resolveProjectNameForCwd, listProjectDefs } from './projects.js';
import { getHistoryDir } from './state.js';
import { machineId } from './machine-id.js';
import { isValidMailboxId } from './mailbox.js';
import {
  listPidSessionEntries,
  readLivePidSessionEntry as readPidSessionEntry,
  type PidSessionEntry,
} from './session/pid-registry.js';

export const STATUS_POST_MAX_CHARS = 500;
export const STATUS_TITLE_MAX_CHARS = 60;

interface FeedPostInput {
  title: string;
  text: string;
  sessionId?: string;
  attach?: string[];
  blocked?: boolean;
  activityRoot?: string;
  attachmentsRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  ts?: string;
  startPid?: number;
  getParentPid?: (pid: number) => number | undefined;
  readEntry?: (pid: number) => PidSessionEntry | undefined;
  listEntries?: () => PidSessionEntry[];
}

interface FeedPostResult {
  event: ActivityEvent;
}

export interface PostIdentity {
  sessionId: string;
  mailboxId: string;
  host: string;
  runtime: string;
  agent?: string;
  cwd?: string;
  pid?: number;
  launchId?: string;
  terminalId?: string;
  tmuxPane?: string;
}

export function resolvePostIdentity(
  input: Pick<FeedPostInput, 'sessionId' | 'env' | 'cwd' | 'activityRoot' | 'startPid' | 'getParentPid' | 'readEntry' | 'listEntries'>,
): PostIdentity | undefined {

  const env = input.env ?? process.env;
  const readEntry = input.readEntry ?? readPidSessionEntry;
  const listEntries = input.listEntries ?? listPidSessionEntries;
  const getParent = input.getParentPid ?? parentPidOf;

  const envSession = firstValidId([
    input.sessionId,
    env.AGENT_SESSION_ID,
    env.AGENTS_SESSION_ID,
    mailboxIdFromEnv(env),
  ]);

  const launchId = env.AGENT_LAUNCH_ID?.trim() || undefined;
  let registry: PidSessionEntry | undefined;

  if (launchId) {
    registry = listEntries().find((e) => e.launchId === launchId);
  }

  if (!registry) {
    const start = input.startPid ?? (typeof process.ppid === 'number' ? process.ppid : undefined);
    if (start && start > 1) {
      registry = walkPidRegistry(start, getParent, readEntry);
    }
  }

  const activity = launchId && !envSession && !registry?.sessionId
    ? readRecentActivity({ root: input.activityRoot, maxBytesPerSession: 64 * 1024 })
      .find((event) => event.launchId === launchId)
    : undefined;

  const sessionId = envSession ?? registry?.sessionId ?? activity?.sessionId;
  if (!sessionId || !isValidMailboxId(sessionId)) return undefined;

  const mailboxFromEnv = mailboxIdFromEnv(env);
  const mailboxId = mailboxFromEnv && isValidMailboxId(mailboxFromEnv)
    ? mailboxFromEnv
    : sessionId;

  return {
    sessionId,
    mailboxId,
    host: activity?.host ?? machineIdFromEnv(env),
    runtime: env.AGENTS_RUNTIME?.trim() || activity?.runtime || 'headless',
    agent: env.AGENTS_AGENT_NAME?.trim()
      || registry?.agent
      || activity?.agent
      || detectAgentKind(env),
    cwd: input.cwd
      ?? (env.AGENTS_CWD?.trim() || registry?.cwd || activity?.cwd || process.cwd()),
    pid: registry?.pid ?? activity?.pid,
    launchId: launchId || registry?.launchId || activity?.launchId,
    terminalId: env.AGENT_TERMINAL_ID?.trim() || registry?.terminalId || activity?.terminalId,
    tmuxPane: env.TMUX_PANE?.trim() || registry?.tmuxPane || activity?.tmuxPane,
  };
}

function firstValidId(candidates: Array<string | undefined>): string | undefined {
  for (const raw of candidates) {
    const id = (raw ?? '').trim();
    if (id && isValidMailboxId(id)) return id;
  }
  return undefined;
}

function mailboxIdFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.AGENTS_MAILBOX_DIR?.trim();
  if (!dir) return undefined;
  const base = path.basename(dir.replace(/[/\\]+$/, ''));
  return base || undefined;
}

export function walkPidRegistry(
  startPid: number,
  getParent: (pid: number) => number | undefined,
  readEntry: (pid: number) => PidSessionEntry | undefined,
): PidSessionEntry | undefined {

  let pid: number | undefined = startPid;
  const seen = new Set<number>();
  let firstHit: PidSessionEntry | undefined;
  for (let i = 0; i < 16 && pid && pid > 1 && !seen.has(pid); i++) {
    seen.add(pid);
    const entry = readEntry(pid);
    if (entry) {
      if (entry.sessionId && isValidMailboxId(entry.sessionId)) return entry;
      if (!firstHit) firstHit = entry;
    }
    pid = getParent(pid);
  }
  return firstHit;
}

function parentPidOf(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^PPid:\s*(\d+)/m);
      if (m) {
        const pp = Number(m[1]);
        return Number.isInteger(pp) && pp > 0 ? pp : undefined;
      }
    } catch {
    }
  }
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (r.status === 0) {
      const pp = Number((r.stdout || '').trim());
      return Number.isInteger(pp) && pp > 0 ? pp : undefined;
    }
  } catch {
  }
  return undefined;
}

const MEDIA_BY_EXT: Record<string, { kind: Attachment['kind']; mediaType: string }> = {
  '.png': { kind: 'image', mediaType: 'image/png' },
  '.jpg': { kind: 'image', mediaType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mediaType: 'image/jpeg' },
  '.gif': { kind: 'image', mediaType: 'image/gif' },
  '.svg': { kind: 'image', mediaType: 'image/svg+xml' },
  '.webp': { kind: 'image', mediaType: 'image/webp' },
  '.wav': { kind: 'audio', mediaType: 'audio/wav' },
  '.mp3': { kind: 'audio', mediaType: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mediaType: 'audio/mp4' },
  '.aac': { kind: 'audio', mediaType: 'audio/aac' },
  '.ogg': { kind: 'audio', mediaType: 'audio/ogg' },
  '.flac': { kind: 'audio', mediaType: 'audio/flac' },
  '.mp4': { kind: 'video', mediaType: 'video/mp4' },
  '.mov': { kind: 'video', mediaType: 'video/quicktime' },
  '.webm': { kind: 'video', mediaType: 'video/webm' },
  '.mkv': { kind: 'video', mediaType: 'video/x-matroska' },
};

function isRemoteUrl(token: string): boolean {
  return /^https?:\/\//i.test(token.trim());
}

function mediaForExt(ext: string): { kind: Attachment['kind']; mediaType?: string } {
  const hit = MEDIA_BY_EXT[ext.toLowerCase()];
  return hit ? { kind: hit.kind, mediaType: hit.mediaType } : { kind: 'file' };
}

function newUpdateId(ts: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = ts.replace(/[^0-9]/g, '').slice(0, 14) || 'post';
  return `${stamp}-${rand}`;
}

export function buildAttachment(
  token: string,
  ctx: { copyRoot?: string; sessionId: string; updateId: string },
): Attachment | undefined {
  const value = token.trim();
  if (!value) return undefined;

  if (isRemoteUrl(value)) {
    const ext = path.extname(new URL(value).pathname);
    const media = mediaForExt(ext);
    const att: Attachment = { kind: media.kind === 'file' ? 'link' : media.kind, href: value };
    const name = path.basename(new URL(value).pathname);
    if (name) att.name = name;
    if (media.mediaType) att.mediaType = media.mediaType;
    return att;
  }

  const abs = path.resolve(value);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;

  const media = mediaForExt(path.extname(abs));
  const name = path.basename(abs);
  let href = abs;

  if (ctx.copyRoot) {

    try {
      const destDir = path.join(ctx.copyRoot, ctx.sessionId, ctx.updateId);
      fs.mkdirSync(destDir, { recursive: true });
      const dest = path.join(destDir, name);
      fs.copyFileSync(abs, dest);
      href = dest;
    } catch {
      href = abs;
    }
  }

  const att: Attachment = { kind: media.kind, href, name, bytes: stat.size };
  if (media.mediaType) att.mediaType = media.mediaType;
  return att;
}

export function buildAttachments(
  tokens: string[] | undefined,
  ctx: { copyRoot?: string; sessionId: string; updateId: string },
): Attachment[] {
  if (!tokens?.length) return [];
  const out: Attachment[] = [];
  for (const token of tokens) {
    const att = buildAttachment(token, ctx);
    if (att) out.push(att);
  }
  return out;
}

export function scrubDashes(text: string): string {
  return text
    .replace(/\u2014/g, ' - ')
    .replace(/\u2013/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeStatusText(text: string): string {
  const collapsed = scrubDashes(text);
  if (!collapsed) return '';
  if (collapsed.length <= STATUS_POST_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_POST_MAX_CHARS - 1)}…`;
}

export function normalizeStatusTitle(title: string): string {
  const collapsed = scrubDashes(title);
  if (!collapsed) return '';
  if (collapsed.length <= STATUS_TITLE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_TITLE_MAX_CHARS - 1)}…`;
}

export function postFeedStatus(input: FeedPostInput): FeedPostResult {
  const title = normalizeStatusTitle(input.title ?? '');
  const detail = normalizeStatusText(input.text);
  if (!title) {
    throw new Error(
      'Title is empty. Usage: agents feed post --title "Short subject" "what just happened"',
    );
  }
  if (!detail) {
    throw new Error(
      'Status text is empty. Usage: agents feed post --title "Short subject" "what just happened"',
    );
  }

  const identity = resolvePostIdentity(input);
  if (!identity) {
    throw new Error(
      'No session id. Run from an agents-cli session '
      + '(AGENT_SESSION_ID / AGENTS_MAILBOX_DIR / pid registry), or pass --session <id>.',
    );
  }

  const ts = input.ts ?? new Date().toISOString();
  const project = resolveProjectNameForCwd(identity.cwd, listProjectDefs());
  const attachments = buildAttachments(input.attach, {
    copyRoot: input.attachmentsRoot ?? path.join(getHistoryDir(), 'attachments'),
    sessionId: identity.sessionId,
    updateId: newUpdateId(ts),
  });

  const event: Omit<ActivityEvent, 'v' | 'tier'> = {
    ts,

    event: input.blocked ? 'status.blocked' : 'status.posted',
    sessionId: identity.sessionId,
    mailboxId: identity.mailboxId,
    host: identity.host,
    runtime: identity.runtime,
    cwd: identity.cwd,
    agent: identity.agent,
    tool: 'feed.post',
    title,
    detail,
    ...(project ? { project } : {}),
    ...(identity.pid !== undefined ? { pid: identity.pid } : {}),
    ...(identity.launchId ? { launchId: identity.launchId } : {}),
    ...(identity.terminalId ? { terminalId: identity.terminalId } : {}),
    ...(identity.tmuxPane ? { tmuxPane: identity.tmuxPane } : {}),
    ...(attachments.length ? { attachments } : {}),
  };

  appendActivityEvent(event, input.activityRoot);
  return {
    event: {
      v: 1,
      tier: 'milestone',
      ...event,
    },
  };
}

function machineIdFromEnv(env: NodeJS.ProcessEnv): string {
  const raw = env.AGENTS_SYNC_MACHINE_ID || undefined;
  if (raw) {
    return raw.split('.')[0].trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'unknown';
  }
  return machineId();
}

function detectAgentKind(env: NodeJS.ProcessEnv): string {
  if (env.CLAUDECODE === '1') return 'claude';
  if (env.CODEX_CI || env.CODEX_HOME) return 'codex';
  return 'agent';
}
