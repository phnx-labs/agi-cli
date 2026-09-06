/**
 * Agent status posts — deliberate progress messages into the activity stream.
 *
 * Surface: `agents feed post --title <subject> <body>` (agent-callable; humans
 * watch via `agents feed` / `agents events --module activity`).
 *
 * Identity is automatic: session id, agent, cwd, launch/pid/tmux provenance
 * are resolved from the process environment and the per-pid launch registry
 * (`lib/session/pid-registry.ts`). The agent authors a short title + body —
 * no domain-specific flags (tickets, URLs, tracks). Phone `{message}` ends with
 * a "Sent from agent/session on host" footer.
 *
 * Storage: append-only activity log as a `status.posted` milestone. Does NOT
 * open a feed block (blocks remain "needs you" state only).
 */
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

/** Soft cap so a runaway agent can't flood the activity lane with essays. */
export const STATUS_POST_MAX_CHARS = 500;
/** Title is a phone subject line - about four or five words, not a paragraph. */
export const STATUS_TITLE_MAX_CHARS = 60;

export interface FeedPostInput {
  /**
   * Short subject (required for new posts). ~4–5 words. Phone broadcasts put
   * this on the first line so a scan names the topic before the body.
   */
  title: string;
  /** Body text (required). Domain-agnostic free text — what happened / the ask. */
  text: string;
  /** Override session id (escape hatch for scripts/tests). Prefer auto-resolve. */
  sessionId?: string;
  /** Generic artifacts to attach: local paths (copied for durability) or URLs. */
  attach?: string[];
  /**
   * The agent is STUCK, not merely reporting. Writes `status.blocked` instead of
   * `status.posted`, and the caller pairs it with an OpenBlock so the ask stays
   * answerable until someone resolves it.
   *
   * This is a state, not a volume: a blocked post is always broadcast at
   * `important`, so an agent never has to decide the level as well. One thing to
   * say is what makes the habit stick.
   */
  blocked?: boolean;
  /** Override activity root (tests). */
  activityRoot?: string;
  /**
   * Override the attachments store root (tests). Local files are copied under
   * `<attachmentsRoot>/<sessionId>/<updateId>/`. Defaults to
   * `~/.agents/.history/attachments`.
   */
  attachmentsRoot?: string;
  /** Override env for identity resolution (tests). */
  env?: NodeJS.ProcessEnv;
  /** Override cwd stamp (defaults to process.cwd() / env). */
  cwd?: string;
  /** Fixed timestamp (tests). */
  ts?: string;
  /**
   * Starting pid for registry ancestor walk (defaults to process.ppid so the
   * walk begins at the parent of this CLI process — usually the agent/shell).
   * Tests inject a fake pid here.
   */
  startPid?: number;
  /** Override parent-pid lookup (tests). */
  getParentPid?: (pid: number) => number | undefined;
  /** Override registry read (tests). */
  readEntry?: (pid: number) => PidSessionEntry | undefined;
  /** Override full registry list for launchId match (tests). */
  listEntries?: () => PidSessionEntry[];
}

export interface FeedPostResult {
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

/**
 * Resolve who is posting. Order:
 *  1. Explicit --session flag
 *  2. Env: AGENT_SESSION_ID / AGENTS_SESSION_ID / basename(AGENTS_MAILBOX_DIR)
 *  3. Env AGENT_LAUNCH_ID → match in pid registry or activity index
 *  4. Walk parent PIDs from startPid (default process.ppid) through by-pid registry
 */
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

  // Prefer env session (explicit + managed run), fill gaps from registry.
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

/** Walk up to 16 ancestors looking for a by-pid registry entry with a session. */
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
  // Entry without sessionId still carries agent/cwd/launchId — usable when
  // session id comes from env.
  return firstHit;
}

/** Best-effort parent pid of `pid` (Linux /proc, else `ps`). */
export function parentPidOf(pid: number): number | undefined {
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
      /* fall through */
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
    /* best-effort */
  }
  return undefined;
}

/** Extension → (kind, mediaType) for attachment classification. */
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

/** True when the token is an http(s) URL (a remote attachment / link). */
function isRemoteUrl(token: string): boolean {
  return /^https?:\/\//i.test(token.trim());
}

function mediaForExt(ext: string): { kind: Attachment['kind']; mediaType?: string } {
  const hit = MEDIA_BY_EXT[ext.toLowerCase()];
  return hit ? { kind: hit.kind, mediaType: hit.mediaType } : { kind: 'file' };
}

/** A short, filesystem-safe id grouping one post's copied attachments. */
function newUpdateId(ts: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const stamp = ts.replace(/[^0-9]/g, '').slice(0, 14) || 'post';
  return `${stamp}-${rand}`;
}

/**
 * Turn one `--attach` token into an {@link Attachment}. Remote URLs become
 * `link` (or a media kind when the extension is unambiguous). Local files are
 * classified by extension and, when `copyRoot` is set, copied under
 * `<copyRoot>/<sessionId>/<updateId>/<basename>` so the link survives a worktree
 * delete — the stored `href` then points at the durable copy. A missing local
 * file is dropped (fail-open) rather than throwing.
 */
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
    return undefined; // dropped: local file does not exist
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
      href = abs; // copy failed: fall back to the original path
    }
  }

  const att: Attachment = { kind: media.kind, href, name, bytes: stat.size };
  if (media.mediaType) att.mediaType = media.mediaType;
  return att;
}

/** Classify + store every `--attach` token; empty/failed tokens are dropped. */
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

/**
 * Collapse whitespace and strip em/en dashes (house rule: no em-dashes in
 * agent-authored outbound copy — phones and plain text render them poorly).
 */
export function scrubDashes(text: string): string {
  return text
    .replace(/\u2014/g, ' - ') // em dash —
    .replace(/\u2013/g, ' - ') // en dash –
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeStatusText(text: string): string {
  const collapsed = scrubDashes(text);
  if (!collapsed) return '';
  if (collapsed.length <= STATUS_POST_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_POST_MAX_CHARS - 1)}…`;
}

/** Normalize a short subject line for a post. */
export function normalizeStatusTitle(title: string): string {
  const collapsed = scrubDashes(title);
  if (!collapsed) return '';
  if (collapsed.length <= STATUS_TITLE_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, STATUS_TITLE_MAX_CHARS - 1)}…`;
}

/**
 * Append a `status.posted` milestone for the calling agent.
 * Throws if title/text is empty or session identity cannot be resolved.
 */
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
  // The post is written where the agent runs, so the cwd is a local path and
  // gets full canonical resolution — a defined project's name wins (a post from
  // any repo of a multi-repo project files under that project), else the repo
  // key, matching how the timeline groups everything else. listProjectDefs is
  // fail-open, so this costs one small readdir + YAML parse per post.
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
