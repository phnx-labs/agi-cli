import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BrowserCdpConnectionError,
  CDPClient,
  discoverBrowserWsUrl,
  verifyBrowserIdentity,
} from './cdp.js';
import {
  getProfile,
  getProfileRuntimeDir,
  getProfileDownloadsDir,
  getProfileSessionsDir,
  getBrowserRuntimeDir,
  listProfiles,
  extractConfiguredPort,
  resolveEndpoint,
  parseEndpointUrl,
} from './profiles.js';
import { killChrome, getRunningChromeInfo, launchBrowser, allocatePort } from './chrome.js';
import { assertRemoteControlAllowedForRequest } from './remote-control.js';
import { connectLocal } from './drivers/local.js';
import { connectSSH, shellQuote } from './drivers/ssh.js';
import {
  adoptLegacyRuntimeIfLocal,
  isLegacyEndpointKey,
  resolveBrowserTarget,
  shouldForkProfile,
  type DeviceProbe,
} from './resolve-target.js';
import { clearProfileRuntime, listProfileCacheDirs, readProfileRuntimeMeta, isProcessAlive } from './runtime-state.js';
import { resolveDomainSkill, type ResolvedDomainSkill } from './domain-skills.js';
import {
  generateTaskId,
  generateShortId,
  isValidTaskId,
  type Task,
  type TabInfo,
  type ProfileStatus,
  type TaskStatus,
  type BrowserProfile,
  type BrowserType,
  type HistoricalTask,
  type ReapResult,
  type ProfileName,
  type ConnectionKey,
  asConnectionKey,
  parseConnectionKey,
  keyBelongsToProfile,
} from './types.js';
import {
  reapAbandonedTasks,
  resolveLiveIdentities,
  taskOwnerIsGone,
  type ReapOptions,
} from './hygiene.js';
import { taskMatchesCaller } from './caller-identity.js';
import { getRefs, resolveRefToCoords, describeRefs, healRef, type RefOpts, type RefNode, type RefSnapshot } from './refs.js';
import { clickAtCoords, hoverAtCoords, scrollAtCoords, typeText, pressKey, focusNode } from './input.js';
import { typeEditorText } from './editor.js';
import {
  arcClickExpression,
  arcFillExpression,
  arcRefsExpression,
  arcScrollExpression,
  parseArcRefsResult,
} from './arc-dom.js';
import {
  detectUploadPattern,
  stageUploadFile,
  uploadToDropTarget,
  uploadToFileInput,
  uploadViaFileChooser,
} from './upload.js';
import { emit } from '../feed/events.js';
import { resolveActor } from '../actor.js';
import { recordBrowserSession } from '../session/db.js';
import { sshExecAsync } from '../ssh-exec.js';
import type {
  TargetFilter,
  PageOpenResult,
  ArcNativeProfileIdentity,
  ArcNativeTabRef,
} from './types.js';
import { resolveFfmpeg } from './ffmpeg.js';
import {
  ArcNativeCapabilityError,
  executeJavaScript,
  navigateArcTab,
  closeArcTab,
  createArcTab,
  enumerateArcSpaces,
  isArcRunning,
  resolveArcTab,
  restoreArcSelection,
  selectWindowTab,
  selectArcTab,
} from './drivers/arc.js';

export type UploadMode = 'auto' | 'input' | 'drop' | 'chooser';

/**
 * Canonical form for comparing a requested URL against what CDP reports for a
 * live target. `new URL('https://example.com').href` is `https://example.com/`,
 * which is exactly what Chrome reports — comparing the raw strings would miss
 * every bare-origin match. Unparseable input compares as itself.
 */
function canonicalTabUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

function isPathInside(candidate: string, dir: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveScreenshotOutputPath(outputPath: string | undefined, automaticPath: string): string {
  if (!outputPath) return automaticPath;

  const runtimeDir = getBrowserRuntimeDir();
  fs.mkdirSync(runtimeDir, { recursive: true });
  const runtimeReal = fs.realpathSync(runtimeDir);
  const requested = path.resolve(outputPath);
  const parent = path.dirname(requested);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  const resolved = path.join(parentReal, path.basename(requested));
  if (!isPathInside(resolved, runtimeReal)) {
    return automaticPath;
  }
  return resolved;
}

/**
 * Read width/height from a JPEG buffer by walking SOF markers. Returns null
 * if the buffer doesn't start with the JPEG SOI marker or no SOF segment is
 * found. We use this on every screenshot so the CLI can surface the actual
 * captured pixel dimensions (which differ from viewport size at non-1x DPR).
 */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // PNG signature (8 bytes) + IHDR chunk: length (4) + 'IHDR' (4) + width (4) + height (4)
  if (buf.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    // SOF0–SOFn carry dimensions, except DHT (0xC4), JPG (0xC8), DAC (0xCC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Parse a `targetFilter` string into its kind + value, or return `null`
 * when the input is missing or malformed. Filter syntax:
 *   - `url:<substring>`   — picks the first page target whose URL contains the substring
 *   - `title:<substring>` — picks the first page target whose title contains the substring
 *
 * The match is case-insensitive on both sides because Electron apps
 * frequently lowercase or title-case their target metadata in unpredictable ways.
 */
export function parseTargetFilter(filter: string | undefined): TargetFilter | null {
  if (!filter) return null;
  const idx = filter.indexOf(':');
  if (idx <= 0) return null;
  const kind = filter.slice(0, idx).trim().toLowerCase();
  // Strip whitespace around the value so `url: https://x` (with a copy-pasted
  // space after the colon) doesn't silently fail to match — `.includes(' x')`
  // never hits a URL because URLs don't contain spaces.
  const value = filter.slice(idx + 1).trim();
  if (kind !== 'url' && kind !== 'title') return null;
  if (!value) return null;
  return { kind, value };
}

/**
 * URLs that the skip-invisible heuristic excludes when no explicit filter
 * matches. These are page targets Electron apps ship for housekeeping;
 * picking one means screenshots come back blank.
 */
const INVISIBLE_URL_PATTERNS: RegExp[] = [
  /^about:blank$/i,
  /^file:\/\//i,
  /\/_desktop-background-service(\?|$|\/)/i,
  /\/_internal(\?|$|\/)/i,
  /\/_background(\?|$|\/)/i,
];

function isLikelyInvisible(url: string | undefined): boolean {
  if (!url) return true;
  return INVISIBLE_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Choose the CDP page target that represents the visible UI.
 *
 * Order:
 *   1. If `filter` is set and parseable, narrow to page targets matching it
 *      (case-insensitive substring). Among matches, prefer one that is not in
 *      `INVISIBLE_URL_PATTERNS` — this is the tiebreaker that makes a coarse
 *      filter like `url:https://www.canva.com/` skip the background service
 *      (`https://www.canva.com/_desktop-background-service` *also* matches the
 *      substring). If every match is invisible, return the first match so the
 *      caller still gets something rather than silently falling through.
 *      An explicit filter that finds *no* match returns `undefined` — callers
 *      should surface this as an error rather than create an orphan window.
 *   2. If `filter` is unset (or unparseable), apply the skip-invisible heuristic
 *      across all page targets.
 *   3. As a last resort, return the first page target.
 */
export function pickWindowTarget<T extends { type: string; url?: string; title?: string }>(
  targets: T[],
  filter: string | undefined
): T | undefined {
  const pages = targets.filter((t) => t.type === 'page');
  if (pages.length === 0) return undefined;

  const parsed = parseTargetFilter(filter);
  if (parsed) {
    const needle = parsed.value.toLowerCase();
    const matches = pages.filter((t) => {
      const hay = (parsed.kind === 'url' ? t.url : t.title) ?? '';
      return hay.toLowerCase().includes(needle);
    });
    if (matches.length === 0) return undefined;
    const visible = matches.find((t) => !isLikelyInvisible(t.url));
    return visible ?? matches[0];
  }

  const visible = pages.find((t) => !isLikelyInvisible(t.url));
  if (visible) return visible;

  return pages[0];
}

/**
 * Parse a `--since`/`--until` value. Accepts ISO-8601 absolute timestamps
 * or relative offsets like `30s`, `5m`, `2h`, `1d`.
 */
export function parseSinceUntil(s: string): Date {
  const ms = Date.parse(s);
  if (!isNaN(ms)) return new Date(ms);
  const m = s.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`Invalid since/until: ${s}`);
  const n = parseInt(m[1], 10);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() - n * unitMs[m[2]]);
}

async function execSSH(host: string, cmd: string): Promise<string> {
  const res = await sshExecAsync(host, cmd, { timeoutMs: 10_000 });
  if (res.code !== 0) {
    throw new Error(`ssh ${host} failed${res.stderr.trim() ? `: ${res.stderr.trim()}` : ''}`);
  }
  return res.stdout;
}

export function readNewestMatchingRemoteFileCommand(
  dir: string,
  prefix: string,
  tailLines: number
): string {
  const glob = `${shellQuote(dir)}/${prefix}*.jsonl`;
  return `latest=$(ls -1t ${glob} 2>/dev/null | head -1); if [ -n "$latest" ]; then tail -n ${tailLines} "$latest"; fi`;
}

export function readNewestMatchingFile(dir: string, prefix: string, tailLines: number): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const candidates = entries
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return '';
  const lines = fs
    .readFileSync(path.join(dir, candidates[0].f), 'utf8')
    .split('\n')
    .filter(Boolean);
  return lines.slice(-tailLines).join('\n');
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}


/**
 * Probe a cached connection before reuse. A WebSocket can quietly transition
 * to CLOSED without anyone noticing — most commonly when the user kills the
 * browser process by hand. `Browser.getVersion` is the lightest CDP call we
 * can make; if it doesn't round-trip within 1s the connection is dead.
 */
async function isConnHealthy(conn: ProfileConnection, timeoutMs = 1000): Promise<boolean> {
  // Native Arc connections: healthy if Arc is still running (no CDP socket to probe).
  if (conn.backend === 'arc-native') {
    return isArcRunning();
  }
  if (!conn.cdp.isOpen) return false;
  try {
    await Promise.race([
      conn.cdp.send('Browser.getVersion'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('healthcheck timeout')), timeoutMs)
      ),
    ]);
    return true;
  } catch {
    return false;
  }
}

interface BaseProfileConnection {
  port: number;
  pid: number;
  electron?: boolean;
  /**
   * The profile's declared browser family. Load-bearing for Arc: Arc answers
   * `Browser.getVersion` and DOES expose CDP page targets it honors `Page.navigate`
   * on, but CRASHES on `Target.createTarget` (verified live, PR #2778), so any
   * tab-CREATING path must refuse and drive an EXISTING tab instead rather than
   * crash the user's Arc. See `createPageTarget` / `pickReusableTargetWithoutCreate`.
   */
  browserType?: BrowserType;
  /** Raw `url:<v>` / `title:<v>` filter copied from the profile config. */
  targetFilter?: string;
  /**
   * The runtime key this connection is registered under in `this.connections`
   * (`<profile>@<endpoint>`, plus `.<fork>` for an Electron fork; a bare name
   * for a legacy pre-composite dir). Also keys the profile's runtime dir, so
   * downloads and session captures land under `.cache/browser/<key>/`.
   */
  key?: ConnectionKey;
  /** The bare, user-facing profile name this connection belongs to. */
  profile?: ProfileName;
  forkedFrom?: ConnectionKey;
  tasks: Map<string, Task>;
  windowId?: string; // single window shared by all tasks
  targetCache?: { targets: TargetInfo[]; ts: number };
  sessionCache: Map<string, string>;
  /**
   * Connection-specific teardown (e.g. killing the SSH tunnel for an ssh://
   * profile). Must be called whenever the connection is removed from
   * `this.connections`, otherwise the tunnel leaks across daemon restarts
   * and hijacks future `cdp://127.0.0.1:N` profiles on the same local port.
   */
  cleanup?: () => void;
  /**
   * Transport backend (PHNX-2399). `cdp` (default when absent) uses CDP;
   * `arc-native` uses Apple Events via the native Arc driver. Every action
   * method must check this before calling `conn.cdp.send()`.
   */
}

interface CdpProfileConnection extends BaseProfileConnection {
  /** Omitted only by legacy/in-process callers; absence means the CDP path. */
  backend?: 'cdp';
  cdp: CDPClient;
}

interface ArcProfileConnection extends BaseProfileConnection {
  backend: 'arc-native';
  browserType: 'arc';
  arcProfile: ArcNativeProfileIdentity;
}

type ProfileConnection = CdpProfileConnection | ArcProfileConnection;

function requireCdp(
  conn: ProfileConnection,
  capability: string,
): asserts conn is CdpProfileConnection {
  if (conn.backend === 'arc-native') throw new ArcNativeCapabilityError(capability);
}

/** Join error lines so callers get a next command, not a dead-end message. */
export function actionable(...lines: string[]): string {
  return lines.filter((l) => l != null && l !== '').join('\n');
}

/**
 * Arc DOES expose CDP page targets and honors `Page.navigate` on the ones the
 * user already has open (measured live against Arc: 33 targets, PR #2786), so
 * agents browser drives an attached Arc by reusing existing tabs. What it CANNOT
 * survive is `Target.createTarget` — opening a brand-new tab crashes the user's
 * Arc window (verified live, PR #2778). Tab creation is the one CDP-only op that
 * fails clearly here (PHNX-2399): every tab-creating path throws this actionable
 * error instead of crashing Arc, and steers the caller to reuse an existing
 * tab/Space (via `--target-filter`) or to a Chromium-family browser for new tabs.
 */
export function arcNotDrivableError(profileName?: string): Error {
  const scope = profileName ? ` (profile "${profileName}")` : '';
  return new Error(
    actionable(
      `Browser "arc"${scope} cannot open a NEW tab: Arc crashes when a tab is created`,
      'over CDP (Target.createTarget). agents browser drives Arc by attaching to your',
      'running window and reusing an EXISTING tab — bind the profile to the tab/Space you',
      'want with --target-filter (url:<substring> or title:<substring>), or navigate to a',
      'URL that is already open. To open brand-new tabs, use a Chromium-family browser:',
      '  agents browser profiles create <name> --browser comet',
    ),
  );
}

/** Derive a human label from an explicit title or a navigated URL. */
export function deriveTaskLabel(opts: { title?: string; url?: string; existing?: string }): string {
  if (opts.title?.trim()) return opts.title.trim();
  if (opts.existing && opts.existing !== 'untitled') return opts.existing;
  if (opts.url) {
    try {
      const host = new URL(opts.url).hostname.replace(/^www\./, '');
      if (host) return host;
    } catch {
      /* unparseable */
    }
  }
  return opts.existing ?? 'untitled';
}

type TargetInfo = {
  targetId: string;
  url?: string;
  title?: string;
};

/** Describes a ref that was re-resolved from a drifted integer via its cached descriptor. */
export interface HealInfo {
  from: number;
  to: number;
  role: string;
  name: string;
}

/**
 * Resolve the identity stamped on a task at start: WHO (`owner`) and WHICH run
 * (`launchId`). The forwarded values come from the caller's own CLI process and
 * are authoritative — the browser daemon is shared and long-lived, so resolving
 * the actor daemon-side (the RUSH-2020 bug) mis-attributes every task to the
 * daemon's owner. `resolveLocalActor` is consulted ONLY when no actor was
 * forwarded (a CLI that predates the field, mid-rollout) — never to override a
 * forwarded one.
 */
export function resolveTaskIdentity(
  forwarded: { actor?: string; launchId?: string; sessionId?: string },
  resolveLocalActor: () => string
): { owner: string; launchId?: string; sessionId?: string } {
  return {
    owner: forwarded.actor ?? resolveLocalActor(),
    launchId: forwarded.launchId,
    sessionId: forwarded.sessionId,
  };
}

export interface StartOptions {
  taskName?: string;
  url?: string;
  endpointName?: string;
  skipDomainSkill?: boolean;
  /** Always open a new tab, skipping the abandoned-task reclaim. */
  fresh?: boolean;
  /** Caller identity, forwarded from the CLI (see IPCRequest.actor/launchId). */
  actor?: string;
  launchId?: string;
  /** Calling agent session, forwarded from the CLI (see IPCRequest.sessionId). */
  sessionId?: string;
  /** Whether the CALLER was dispatched here by a fleet `--device` hop. */
  fleetRemote?: boolean;
  /** Explicit human label (`--title`). */
  title?: string;
  /** Injected reachability probe — production uses ssh; tests pass a fake. */
  probe?: DeviceProbe;
}

export interface StartResult {
  task: string;
  name: string;
  tabId?: string;
  windowId?: string;
  /** BARE profile name — what the caller asked for, never the runtime key. */
  profile: ProfileName;
  /** Runtime key the task actually landed on (`<profile>@<device>`). */
  key: ConnectionKey;
  /** Device the daemon connected to. */
  device: string;
  /** Set when the daemon picked a remote declaring device. */
  picked?: string;
  skill?: ResolvedDomainSkill;
  /** A same-name start that matched an existing task and reused it (PHNX-2399). */
  reused?: boolean;
  /**
   * The actual page operation the URL open performed (PHNX-2399), or undefined
   * when start opened no URL. Carries created/refreshed/message truthfully:
   * a fresh tab is `created`, a same-URL owned-tab reopen is `refreshed`, an
   * adopted abandoned tab or a no-op reuse is neither.
   */
  firstOpen?: PageOpenResult;
}

/**
 * The unique URL a native Arc tab is created at before it is navigated to its
 * real target (PHNX-2399). Arc's `make new tab` accepts only http(s) URLs (it
 * rejects `data:` and `about:` outright), so the marker is an https URL on the
 * reserved `.invalid` TLD: DNS fails locally, no request leaves the machine,
 * and the tab keeps the exact URL for the enumerate-and-match that follows.
 */
const ARC_CREATE_MARKER_PREFIX = 'https://agents-browser.invalid/';
export function arcCreateMarker(): string {
  return `${ARC_CREATE_MARKER_PREFIX}${crypto.randomUUID()}`;
}
export function isArcCreateMarker(url: string): boolean {
  return url.startsWith(ARC_CREATE_MARKER_PREFIX);
}

export class BrowserService {
  private static readonly SOURCE_PREFIX: Record<string, string> = {
    'rush-app': 'rush-app-',
    'rush-cli': 'rush-cli-',
  };

  /**
   * Live browsers, keyed by {@link ConnectionKey} — NOT by profile name. The
   * branded key type is what makes `connections.get(someProfileName)` (the
   * RUSH-2709 miss that made `status --profile <name>` return empty for a
   * running `<name>@<device>`) fail to compile. Keys are `<profile>@<device>`
   * (legacy leftover `<profile>@endpoint-N` dirs are still recognized).
   */
  private connections = new Map<ConnectionKey, ProfileConnection>();
  private forkingProfiles = new Set<string>();

  // Per-task storage for console, errors, network, downloads
  private consoleLogs = new Map<string, import('./types.js').ConsoleEntry[]>();
  private pageErrors = new Map<string, import('./types.js').ErrorEntry[]>();
  private networkRequests = new Map<string, import('./types.js').NetworkRequest[]>();
  private pendingDownloads = new Map<string, { path: string; filename?: string; completed: boolean }>();
  private enabledSessions = new Map<string, Set<string>>(); // sessionId -> enabled domains

  /** Profile -> when a `touchTask` last persisted tasks.json for it. */
  private lastTouchPersist = new Map<string, number>();
  /** Coalescing window for the `touchTask` write. See {@link touchTask}. */
  private static readonly TOUCH_PERSIST_INTERVAL_MS = 60_000;

  /**
   * Serialization chains for the reopen/create critical section (PHNX-2399).
   * Nothing else serializes IPC requests — `BrowserIPCServer` registers a
   * per-connection `socket.on('data', async …)` that Node never awaits — so two
   * concurrent `navigate`/`tab-add` requests, or two concurrent first-use
   * creates for one caller, race the "is this URL already open?" lookup and each
   * open a duplicate tab. Each key funnels its section through a promise chain so
   * the second request sees the first's tab and refreshes it in place.
   *
   * Keys are DISJOINT by concern so a nested call can never wait on a lock its
   * own outer frame holds: task-scoped work keys on `task:<key>:<name>`, first-
   * use creation keys on `create:<callerId>`. `start()`'s Arc/Electron branch
   * calls `navigate()` (a `task:` key) while the create path holds a `create:`
   * key — different namespaces, so no re-entrant deadlock.
   */
  private critical = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` mutually exclusive against every other call sharing `key`. The
   * chain never rejects (each link swallows its own settlement) so one failed
   * section cannot wedge the queue; `fn`'s own result/throw is returned to THIS
   * caller unchanged. The map entry is dropped once its tail settles with no
   * newer waiter, so idle tasks/callers don't accumulate.
   */
  private async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.critical.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.critical.set(key, tail);
    try {
      return await run;
    } finally {
      // Only the last link clears the entry; a newer waiter has replaced it.
      if (this.critical.get(key) === tail) this.critical.delete(key);
    }
  }

  /**
   * The task's OWN tabs (excluding borrowed ones — a borrowed tab predates the
   * task, see {@link Task.borrowedTabs}) that are still live in the browser AND
   * whose current document canonically equals `url`. Deliberately scoped to THIS
   * task: it is neither {@link adoptTabShowing} (reclaims OTHER abandoned tasks'
   * tabs) nor {@link pickReusableTargetWithoutCreate} (borrows a USER tab on Arc)
   * — the same-task reopen contract only ever touches a tab the task itself owns.
   * A registered id with no live target (a tab closed out from under us) is
   * skipped, so a stale mapping never masquerades as a reopenable tab.
   */
  private findOwnedTabShowing(
    task: Task,
    url: string,
    liveTargets: Array<{ targetId: string; type: string; url: string }>,
  ): { shortId: string; targetId: string } | undefined {
    const borrowed = new Set(task.borrowedTabs ?? []);
    const wanted = canonicalTabUrl(url);
    const liveById = new Map(
      liveTargets.filter((t) => t.type === 'page').map((t) => [t.targetId, t]),
    );
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      if (borrowed.has(shortId)) continue;
      const live = liveById.get(cdpId);
      if (!live) continue; // registered but gone from the browser — not reopenable
      if (canonicalTabUrl(live.url) === wanted) return { shortId, targetId: cdpId };
    }
    return undefined;
  }

  /**
   * Same-task reopen (PHNX-2399): the requested URL is already live in a tab this
   * task owns, so RELOAD that same tab and keep its ids rather than opening a
   * duplicate. Returns the retained short id, or undefined when no owned tab
   * shows the URL (the caller then falls through to its normal navigate/create
   * semantics — that no-match split is intentional and preserved).
   *
   * A real `Page.reload` is issued; a failed reload THROWS rather than reporting
   * a phantom refresh (a stale target was already excluded by
   * {@link findOwnedTabShowing}). The tab is marked current WITHOUT
   * `Target.activateTarget` — reopen must not steal window focus.
   */
  private async reopenOwnedTab(
    conn: CdpProfileConnection,
    task: Task,
    url: string,
  ): Promise<{ tabId: string } | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };
    const match = this.findOwnedTabShowing(task, url, targetInfos);
    if (!match) return undefined;

    const sessionId = await this.getSessionId(conn, match.targetId);
    // Real reload of the SAME document. If it throws, the ids are left exactly as
    // they were and the error surfaces — never a success that didn't happen.
    await conn.cdp.send('Page.reload', {}, sessionId);
    // Mark current without foreground activation (no Target.activateTarget).
    task.currentTabId = match.shortId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: match.shortId };
  }

  async start(profileName: string, opts: StartOptions = {}): Promise<StartResult> {
    // A NAMED start is serialized on the task NAME so two concurrent
    // `start --task <name>` requests can't both pass the existence check and
    // both create — the second observes the first's task and takes the retry (or
    // conflict) path. The key is the bare name, NOT `profile:name`: the existence
    // check (`findTaskByHandle`) is global by name, so two starts of the same
    // name under DIFFERENT profiles must share one lock or they'd both pass.
    // Disjoint `namedstart:` namespace, so the nested navigate()/create locks
    // below never deadlock against it (PHNX-2399). An unnamed start needs no such
    // guard: it always mints a fresh id.
    if (opts.taskName) {
      return this.runExclusive(`namedstart:${opts.taskName}`, () =>
        this.startBody(profileName, opts),
      );
    }
    return this.startBody(profileName, opts);
  }

  private async startBody(profileName: string, opts: StartOptions): Promise<StartResult> {
    // Consent gate, before anything is resolved or launched. This is the
    // authoritative one: gating only the `browser start` COMMAND left the ~18
    // page verbs that create a browser implicitly (navigate, click, screenshot,
    // …) able to open a browser on a machine whose owner never opted in.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });

    // Registry decides WHERE. Three outcomes, no fourth: local if this
    // device declares the name; tunnel to a declaring device otherwise;
    // fail loud if nobody does. Never auto-create a local browser under a
    // name that means a logged-in browser somewhere else.
    const routed = resolveBrowserTarget(profileName, {
      endpointName: opts.endpointName,
      probe: opts.probe,
    });
    if (!routed.local && routed.commandDispatch) {
      throw new Error(
        `Native Arc profile "${profileName}" is owned by ${routed.device}; dispatch the complete browser command there.`,
      );
    }
    const composite = routed.key;
    const effectiveProfile: BrowserProfile = routed.profile;

    const taskId = generateTaskId();
    let taskName: string;
    if (opts.taskName) {
      const existing = this.findTaskByHandle(opts.taskName);
      if (existing) {
        // Same-name start RETRY (PHNX-2399): reuse the existing task rather than
        // erroring — but only when it is genuinely the same task. A different
        // profile, endpoint, or caller identity is a real conflict and must NOT
        // silently acquire someone else's task.
        return this.retryNamedStart(existing, profileName, routed, opts);
      }
      taskName = opts.taskName;
    } else {
      // Address by the short machine id — no word-salad. Status shows `label`.
      taskName = taskId;
    }
    const taskLabel = deriveTaskLabel({ title: opts.title, url: opts.url });

    const reused = await this.reuseProfileConnection(profileName, composite, routed.local);
    let conn = reused?.conn;
    let effectiveKey: ConnectionKey = reused?.key ?? composite;

    // Fork is a local Electron chrome-data mint. Never fork a tunnelled
    // connection — that would launch a logged-out browser on THIS box.
    if (conn && routed.local && shouldForkProfile(routed.kind, conn)) {
      if (this.forkingProfiles.has(composite)) {
        while (this.forkingProfiles.has(composite)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        const existingFork = this.findAvailableFork(composite);
        if (existingFork) {
          conn = existingFork.conn;
          effectiveKey = existingFork.name;
        } else {
          throw new Error(`Fork in progress but no available fork found for "${composite}"`);
        }
      } else {
        this.forkingProfiles.add(composite);
        try {
          const { forkName, connection } = await this.forkElectronProfile(effectiveProfile, composite);
          conn = connection;
          effectiveKey = forkName;
        } finally {
          this.forkingProfiles.delete(composite);
        }
      }
    } else if (!conn) {
      adoptLegacyRuntimeIfLocal(
        routed.local,
        profileName,
        composite,
        getBrowserRuntimeDir(),
      );
      conn = await this.openConnection(
        effectiveProfile,
        routed.target,
        composite,
        profileName,
        { persistRemote: !routed.local },
      );
      effectiveKey = composite;
    }
    if (!conn) {
      throw new Error(`Could not connect to profile "${profileName}"`);
    }
    if (!conn.profile) conn.profile = profileName;

    // Browsers launch with --no-startup-window (session-cookie persistence,
    // see launchBrowser), so a bare `start` with no --url would otherwise
    // leave the user staring at a process with zero windows. Recreate the
    // old startup-window affordance: if no page target exists, open a blank one.
    //
    // This tab IS registered on the task below. It used to be deliberately
    // unregistered ("tasks track only tabs they created") — but this daemon did
    // create it, and an unregistered tab is one `done`/`stop` can never close:
    // `stop` closes exactly the entries in `task.tabs`. So every bare `start`
    // left a blank globe tab behind forever, which is a large share of the
    // pile-up in RUSH-2622. Tabs the daemon did NOT open are still left alone —
    // the branch only fires when the profile has no page target at all.
    let startupBlankTargetId: string | undefined;
    if (!opts.url && !conn.electron && conn.backend !== 'arc-native') {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ type: string }>;
      };
      if (!targetInfos.some((t) => t.type === 'page')) {
        const created = await this.createPageTarget(conn, {
          url: 'about:blank',
        });
        startupBlankTargetId = created.targetId;
        this.invalidateTargetCache(conn);
      }
    }

    const now = Date.now();
    const task: Task = {
      id: taskId,
      name: taskName,
      label: taskLabel,
      profile: effectiveKey,
      tabs: {},
      currentTabId: undefined,
      createdAt: now,
      // A brand-new task has done exactly one thing — start — so its last
      // action is its creation. The reaper's idle window runs from here.
      lastActionAt: now,
      pid: conn.pid,
      // Identity is forwarded from the caller (see resolveTaskIdentity): WHO
      // (owner), WHICH run (launchId), and WHICH agent session (sessionId).
      // Resolving daemon-side would attribute every task to the shared daemon's
      // actor (the RUSH-2020 bug).
      ...resolveTaskIdentity(
        { actor: opts.actor, launchId: opts.launchId, sessionId: opts.sessionId },
        () => resolveActor().id,
      ),
    };

    if (conn.backend === 'arc-native') {
      const selected = await this.resolveArcSpace(conn.arcProfile);
      task.arcNative = {
        profileId: conn.arcProfile.profileId,
        windowId: selected.windowId,
        spaceId: selected.spaceId,
        spaceTitle: selected.spaceTitle,
        tabs: {},
      };
    }

    if (startupBlankTargetId) {
      const shortId = generateShortId();
      task.tabs[shortId] = startupBlankTargetId;
      task.currentTabId = shortId;
    }

    // For Electron, get the existing window as the tab
    if (conn.electron && conn.backend !== 'arc-native') {
      const windowId = await this.getOrCreateWindow(conn);
      if (windowId) {
        const shortId = generateShortId();
        task.tabs[shortId] = windowId;
        task.currentTabId = shortId;
      }
    }

    conn.tasks.set(taskName, task);
    await this.saveTaskState(effectiveKey, conn.tasks);

    // Durable identity, written ONCE at start and never deleted (RUSH-2549).
    // tasks.json above stays live state: `stop` drops the task from that map, so
    // anything recorded only there is gone the moment the task ends -- which is
    // why every finished task used to list as "unlinked". This row outlives the
    // task, the daemon, and a reboot. Metadata only: the capture bytes stay on
    // disk under capture_dir.
    // Guarded like `emit` below ("logging should never break the CLI",
    // events.ts): the browser task is already started and registered. An
    // unwritable session DB must not turn a working `agents browser start` into
    // a failure -- the cost of a miss is one unlinked row, not a dead browser.
    try {
      recordBrowserSession({
        task: taskName,
        profile: effectiveKey,
        sessionId: task.sessionId,
        launchId: task.launchId,
        actor: task.owner,
        startedAt: task.createdAt,
        captureDir: getProfileSessionsDir(effectiveKey, taskName),
      });
    } catch {
      // Recording is best-effort; the task itself is live either way.
    }

    // Feed events and the usage rollup are read by humans: bare name only.
    emit('browser.launch', { profile: profileName, task: taskName, pid: conn.pid });
    void import('../analytics/usage-db.js').then(({ recordUsage }) => {
      recordUsage({
        kind: 'browser',
        name: profileName,
        event: 'launch',
        source: 'browser',
        meta: { task: taskName },
      });
    }).catch(() => { /* fail soft */ });

    // If URL provided, reclaim a tab an abandoned task is holding on it, else
    // create one directly (no about:blank). `firstOpen` records what actually
    // happened so the owning IPC handler reports it truthfully rather than
    // assuming a create (PHNX-2399): ADOPTING an abandoned tab is created:false,
    // opening a fresh target is created:true.
    let tabId: string | undefined;
    let firstOpen: PageOpenResult | undefined;
    if (opts.url && conn.backend !== 'arc-native' && !conn.electron && conn.browserType !== 'arc') {
      const adopted = opts.fresh ? undefined : await this.adoptTabShowing(conn, opts.url);
      const targetId =
        adopted ?? (await this.createPageTarget(conn, { url: opts.url })).targetId;
      const shortId = generateShortId();
      task.tabs[shortId] = targetId;
      task.currentTabId = shortId;
      this.invalidateTargetCache(conn);
      await this.saveTaskState(effectiveKey, conn.tasks);
      tabId = shortId;
      firstOpen = { tabId: shortId, created: !adopted, refreshed: false };
    } else if (opts.url && (conn.backend === 'arc-native' || conn.electron || conn.browserType === 'arc')) {
      // Electron and Arc share the reuse-in-place path: neither may open a fresh
      // tab here (Electron drives its one window; Arc crashes on Target.createTarget),
      // so the implicit first navigate attaches to an existing tab — honoring the
      // profile's --target-filter — instead of throwing. This is what makes the
      // documented `navigate --profile arc --url …` first-use workflow attach rather
      // than refuse on a task-less profile (PHNX-2399 review). Carry navigate's
      // real result — Arc borrow is created:false, not a fabricated create.
      const result = await this.navigate(taskName, opts.url, effectiveKey);
      tabId = result.tabId;
      firstOpen = { tabId: result.tabId, created: result.created, refreshed: result.refreshed, message: result.message };
    }

    // Domain-skill discovery: when a URL is supplied, look up site-specific
    // operating instructions and pass them back so the calling agent can pick
    // them up alongside the task id. Failures swallowed by resolveDomainSkill.
    let skill: ResolvedDomainSkill | undefined;
    if (opts.url && !opts.skipDomainSkill) {
      const resolved = resolveDomainSkill(opts.url);
      if (resolved) skill = resolved;
    }

    return {
      task: taskId,
      name: taskName,
      tabId,
      profile: profileName,
      key: effectiveKey,
      device: routed.device,
      picked: routed.picked,
      skill,
      firstOpen,
    };
  }

  /**
   * Reclaim a live page already showing `url` from an ABANDONED task, instead
   * of opening a second copy of the same page (RUSH-2622). Returns its CDP
   * targetId, or undefined when there is nothing safe to reclaim.
   *
   * "Safe" is narrow on purpose, because both of the wider readings close a tab
   * somebody is using:
   *
   *   - An UNOWNED matching page is NOT taken. No task claims it, which most
   *     often means the user opened it themselves — and adopting it would make
   *     this task's `done` close the user's tab.
   *   - A page owned by a LIVE task is NOT taken. Stealing it would leave that
   *     agent's `screenshot`/`click` throwing "No tabs open for this task", its
   *     `navigate` silently opening the duplicate this feature exists to
   *     prevent, and any in-flight recording truncated when the new owner calls
   *     `done`.
   *
   * What is left is exactly the pile-up case: a page held by a task whose owner
   * is provably gone. Liveness uses the reaper's own predicate
   * (`taskOwnerIsGone`), so "dead" has one definition in this codebase rather
   * than two that can drift. A task the reaper cannot prove dead keeps its tab
   * and is closed later by the idle rule instead.
   *
   * Reclaiming transfers rather than shares: two tasks holding one targetId
   * means the first `done` closes the other's tab. `start --fresh` skips this
   * path entirely.
   *
   * URLs are compared canonically (`new URL(...).href`), so a requested
   * `https://example.com` matches the `https://example.com/` Chrome reports. A
   * page that has since redirected elsewhere simply does not match, and the
   * caller opens a tab as before.
   */
  /** Is this CDP target already registered to any task on the connection? */
  private targetIsClaimed(conn: ProfileConnection, targetId: string): boolean {
    for (const t of conn.tasks.values()) {
      if (Object.values(t.tabs).includes(targetId)) return true;
    }
    return false;
  }

  /**
   * The CDP targets a task may CLOSE — its own tabs minus any it merely
   * borrowed. A borrowed tab existed before the task did (see `Task.borrowedTabs`),
   * so closing it would remove something the task never opened.
   */
  private closeableTargetIds(task: Task): string[] {
    const borrowed = new Set(task.borrowedTabs ?? []);
    return Object.entries(task.tabs)
      .filter(([shortId]) => !borrowed.has(shortId))
      .map(([, cdpId]) => cdpId);
  }

  /**
   * A page target that `navigate` may take over on a browser which cannot create
   * tabs (Arc). Deliberately narrow: only a tab ALREADY showing the requested URL
   * -- re-showing that document there is what the caller asked for -- or an empty
   * new-tab page. A target any task already owns is left alone. Note the honest
   * limit: reusing a matching tab still RELOADS it, discarding scroll position and
   * unsaved form state. Arc cannot open a tab at all, so some intrusion is
   * unavoidable to show the document; a reload is the smallest one, and the tab is
   * borrowed rather than owned so it is never closed.
   */
  private async pickReusableTargetWithoutCreate(
    conn: CdpProfileConnection,
    url: string,
  ): Promise<string | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
    };
    const owned = new Set<string>();
    for (const t of conn.tasks.values()) {
      for (const id of Object.values(t.tabs)) owned.add(id);
    }
    let free = targetInfos.filter((t) => t.type === 'page' && !owned.has(t.targetId));

    // A bound --target-filter (url:/title:<substring>) is how the profile names the
    // tab/Space it drives — e.g. an Arc Space pinned with `--target-filter url:notion.so`.
    // Scope the reusable set to tabs matching it; an explicit filter that matches nothing
    // returns undefined so the caller refuses rather than borrowing an unrelated tab (the
    // same contract pickWindowTarget holds for the tab-creating path). Without this the
    // filter was accepted and stored but never consulted when driving Arc (PHNX-2399 review).
    const parsed = parseTargetFilter(conn.targetFilter);
    if (parsed) {
      const needle = parsed.value.toLowerCase();
      free = free.filter((t) =>
        ((parsed.kind === 'url' ? t.url : t.title) ?? '').toLowerCase().includes(needle)
      );
      if (free.length === 0) return undefined;
    }

    const wanted = canonicalTabUrl(url);
    const sameUrl = free.find((t) => canonicalTabUrl(t.url) === wanted);
    if (sameUrl) return sameUrl.targetId;
    const BLANK = new Set(['', 'about:blank', 'about:newtab', 'chrome://newtab/', 'chrome://new-tab-page/']);
    const blank = free.find((t) => BLANK.has(t.url));
    if (blank) return blank.targetId;
    // With a filter set, every remaining tab already IS the bound Space, so reuse the
    // first even when it is neither the exact URL nor blank — that is the target the
    // operator pinned. With no filter, only an exact-URL or blank tab is safe to borrow.
    return parsed ? free[0]?.targetId : undefined;
  }

  private async adoptTabShowing(
    conn: CdpProfileConnection,
    url: string
  ): Promise<string | undefined> {
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };

    const wanted = canonicalTabUrl(url);
    const matching = new Set(
      targetInfos
        .filter((t) => t.type === 'page' && canonicalTabUrl(t.url) === wanted)
        .map((t) => t.targetId)
    );
    if (matching.size === 0) return undefined;

    const candidates: Array<{ task: Task; shortId: string; targetId: string }> = [];
    for (const task of conn.tasks.values()) {
      const borrowed = new Set(task.borrowedTabs ?? []);
      for (const [shortId, cdpId] of Object.entries(task.tabs)) {
        // A BORROWED tab is not ours to hand on. The dead task never opened it
        // (Task.borrowedTabs) -- reclaiming it would register a pre-existing tab
        // as a fresh task's own, and that task's `done` would close it. Exactly
        // the "adopting it would make this task's `done` close the user's tab"
        // case above, arriving one hop later via reclaim instead of directly.
        if (borrowed.has(shortId)) continue;
        if (matching.has(cdpId)) candidates.push({ task, shortId, targetId: cdpId });
      }
    }
    if (candidates.length === 0) return undefined;

    const live = resolveLiveIdentities();
    for (const { task, shortId, targetId } of candidates) {
      // An in-flight capture means the task is in use whatever its owner looks
      // like — same guard the reaper applies before stopping anything.
      if (this.recordings.has(task.name)) continue;
      if (!(await taskOwnerIsGone(task, live))) continue;
      // Re-check the claim after the await. Nothing serializes IPC requests —
      // `BrowserIPCServer` registers a per-connection `socket.on('data', async …)`
      // that Node never awaits — so two concurrent `start`s can both pass the
      // liveness check on one candidate and both return the same targetId,
      // putting two live tasks on one tab and re-opening the double-owner bug
      // this reclaim is careful to avoid. Whoever deletes it first owns it.
      if (task.tabs[shortId] !== targetId) continue;

      delete task.tabs[shortId];
      delete task.refDescriptors?.[shortId];
      if (task.currentTabId === shortId) {
        const remaining = Object.keys(task.tabs);
        task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
      }

      try {
        await conn.cdp.send('Target.activateTarget', { targetId });
      } catch {
        // Bringing the tab to the front is cosmetic and not every endpoint
        // implements activateTarget; the tab is reclaimed either way.
      }
      return targetId;
    }

    return undefined;
  }

  /**
   * Every live task across every connected profile — the reaper's input
   * (`hygiene.ts`). A read-only view: mutating a returned `Task` mutates the
   * daemon's live state, so callers only read it and act through `stop`.
   */
  listTasks(): Array<{ profile: ConnectionKey; task: Task }> {
    const out: Array<{ profile: ConnectionKey; task: Task }> = [];
    for (const [key, conn] of this.connections) {
      for (const task of conn.tasks.values()) {
        out.push({ profile: conn.key ?? key, task });
      }
    }
    return out;
  }

  /**
   * Close tasks whose owning agent session is gone, or that have sat untouched
   * past the idle window. The entry point the daemon's periodic tick and
   * `agents browser prune` both call; the policy lives in `hygiene.ts`.
   */
  async reapAbandoned(opts: ReapOptions = {}): Promise<ReapResult> {
    return reapAbandonedTasks(this, opts);
  }

  async stop(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    // Rehydrate from tasks.json when the daemon restarted and lost RAM state.
    try {
      await this.findTask(taskName);
    } catch {
      // findTask throws when truly gone; fall through to the miss return.
    }
    for (const [key, conn] of this.connections) {
      const task = this.lookupTaskOnConn(conn, taskName);
      if (task) {
        // Map key may be task.name, not the caller-supplied handle.
        const mapKey = this.taskMapKey(conn, task) ?? taskName;
        // Get domains from tabs before closing (for history)
        const domains = new Set<string>();

        if (conn.backend === 'arc-native') {
          // Resolve exact durable refs for history. Missing/moved tabs are not
          // adopted and never become candidates for a best-effort close.
          for (const ref of Object.values(this.requireArcTask(task).tabs)) {
            const live = await resolveArcTab(ref);
            if (live?.url) {
              try {
                const domain = new URL(live.url).hostname.replace(/^www\./, '');
                if (domain && domain !== 'blank') domains.add(domain);
              } catch { /* invalid URL */ }
            }
          }
          await this.saveToHistory(task, Array.from(domains));
          await this.closeArcNativeTabs(conn, task);
        } else {
          try {
            const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
              targetInfos: Array<{ targetId: string; url: string }>;
            };
            for (const cdpId of Object.values(task.tabs)) {
              const target = targetInfos.find((t) => t.targetId === cdpId);
              if (target?.url) {
                try {
                  const domain = new URL(target.url).hostname.replace(/^www\./, '');
                  if (domain && domain !== 'blank') domains.add(domain);
                } catch {
                  // invalid URL
                }
              }
            }
          } catch {
            // CDP not responding
          }

          // Save to history before closing
          await this.saveToHistory(task, Array.from(domains));

          // Close task's tabs (not the window - it's shared, and not a tab the
          // task merely borrowed - that one was open before the task existed).
          await Promise.all(
            this.closeableTargetIds(task).map((cdpId) =>
              conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {
                // Tab already closed
              })
            )
          );
          for (const cdpId of Object.values(task.tabs)) {
            conn.sessionCache.delete(cdpId);
          }
          this.invalidateTargetCache(conn);
        }

        conn.tasks.delete(mapKey);
        await this.saveTaskState(key, conn.tasks);

        // Feed + usage rows are read by humans: bare profile name (RUSH-2709).
        const bareProfile = conn.profile ?? parseConnectionKey(key).profile;
        emit('browser.close', { profile: bareProfile, task: task.name });
        void import('../analytics/usage-db.js').then(({ recordUsage }) => {
          recordUsage({
            kind: 'browser',
            name: bareProfile,
            event: 'close',
            source: 'browser',
            meta: { task: task.name },
          });
        }).catch(() => { /* fail soft */ });

        if (conn.forkedFrom && conn.tasks.size === 0) {
          if (conn.backend !== 'arc-native') {
            conn.cdp.close();
            killChrome(conn.pid);
          }
          conn.cleanup?.();
          this.connections.delete(key);
          clearProfileRuntime(key);
        }

        return { ok: true, profile: bareProfile };
      }
    }

    return { ok: false };
  }

  async done(taskName: string): Promise<{ ok: boolean; profile?: string }> {
    return this.stop(taskName);
  }

  async stopProfile(
    profileRef: ProfileName | ConnectionKey,
    opts: { fleetRemote?: boolean; actor?: string } = {},
  ): Promise<void> {
    // Consent gate — this is a fleet-remote destructive path (kills the
    // profile's browser process and clears its runtime dir) that reached the
    // daemon without ever hitting resolveOrCreateTask's gate, since it is a
    // task-less stop. Same per-request marker rule as every other gated verb —
    // see remote-control.ts.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });

    // Connections are keyed by the runtime key `<profile>@<device>` (see
    // start()) while callers pass the bare profile name (or, occasionally, an
    // exact key). A plain `connections.get(profileRef)` therefore missed every
    // real remote connection, so `cleanup()` never ran — leaving the SSH tunnel
    // and, on Windows, the WMI-spawned browser orphaned on the remote host after
    // every `browser stop --profile` (#559). Same single rule as findTask and
    // status: exact key, else every key belonging to that profile.
    const keys = [...this.connections.keys()].filter(
      (k) => k === profileRef || keyBelongsToProfile(k, profileRef),
    );
    for (const key of keys) {
      const conn = this.connections.get(key);
      if (!conn) continue;
      // Native Arc connections: close owned tabs but NEVER kill the Arc process.
      // The CLI does not own the Arc process — the user started it.
      if (conn.backend === 'arc-native') {
        for (const task of conn.tasks.values()) {
          await this.closeArcNativeTabs(conn, task);
        }
        this.connections.delete(key);
        clearProfileRuntime(key);
        continue;
      }
      conn.cdp.close();
      killChrome(conn.pid);
      conn.cleanup?.();
      this.connections.delete(key);
      clearProfileRuntime(key);
    }

    // Kill stale processes and clean runtime dirs for every composite and
    // fork entry belonging to this profile (including `.N` forks left by
    // earlier daemon sessions that the connection loop above didn't cover).
    for (const dir of listProfileCacheDirs(parseConnectionKey(profileRef).profile)) {
      const dirName = path.basename(dir);
      const meta = readProfileRuntimeMeta(dirName);
      if (meta?.pid && meta.pid !== 0 && isProcessAlive(meta.pid, meta.command)) {
        killChrome(meta.pid);
      }
      clearProfileRuntime(dirName);
    }
  }

  async navigate(
    taskId: string,
    url: string,
    profileRef?: ProfileName | ConnectionKey,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    const { conn, task } = await this.findTask(taskId, profileRef);
    // Serialize the reopen/create section so two concurrent navigates for one
    // task don't both miss the "already open?" check and open duplicates.
    return this.runExclusive(`task:${task.profile}:${task.name}`, () =>
      this.navigateLocked(conn, task, url),
    );
  }

  private async navigateLocked(
    conn: ProfileConnection,
    task: Task,
    url: string,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    this.maybeUpdateLabelFromUrl(conn, task, url);

    // Native Arc backend (PHNX-2399): route through the native driver instead of CDP.
    if (conn.backend === 'arc-native') {
      return this.navigateArcNative(conn, task, url);
    }
    requireCdp(conn, 'navigate');

    // Same-task reopen (PHNX-2399): the URL is already live in a tab this task
    // owns → reload THAT tab in place and keep its id, before the create/reuse
    // paths below. Chrome and Arc alike; Electron drives one window and never
    // has a second owned tab to match, so this is a no-op there.
    const reopened = await this.reopenOwnedTab(conn, task, url);
    if (reopened) {
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: reopened.tabId, created: false });
      return { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
    }

    // If we have a current tab, navigate in it (reuse)
    const currentShortId = task.currentTabId;
    if (currentShortId && task.tabs[currentShortId]) {
      const cdpTargetId = task.tabs[currentShortId];
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      await this.saveTaskState(task.profile, conn.tasks);
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: currentShortId, created: false });
      return { tabId: currentShortId, url, created: false, refreshed: false };
    }

    // No current tab - create one
    if (conn.electron) {
      const cdpTargetId = conn.windowId;
      if (!cdpTargetId) {
        throw new Error('No existing tab to navigate in Electron app');
      }
      const shortId = generateShortId();
      const sessionId = await this.getSessionId(conn, cdpTargetId);
      await conn.cdp.send('Page.navigate', { url }, sessionId);
      task.tabs[shortId] = cdpTargetId;
      task.currentTabId = shortId;
      await this.saveTaskState(task.profile, conn.tasks);
      emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: shortId, created: true });
      return { tabId: shortId, url, created: true, refreshed: false };
    }

    // Arc exposes page targets and honors Page.navigate on them; what it cannot
    // survive is Target.createTarget (#2778). createPageTarget below therefore
    // refuses outright, so the document never gets shown AT ALL and callers fall
    // back to a raw `open` -- a new tab every call, which is the tab-spam #2779
    // set out to end. Reuse in place instead, the same shape as the Electron
    // branch above. Measured against a live Arc (#2786): 33 page targets,
    // Page.navigate reused one, tab count unchanged, no crash.
    if (conn.browserType === 'arc') {
      const reusable = await this.pickReusableTargetWithoutCreate(conn, url);
      if (reusable) {
        const shortId = generateShortId();
        const sessionId = await this.getSessionId(conn, reusable);
        // Check and CLAIM in one synchronous tick, with no await between them --
        // the ordering `adoptTabShowing` uses (service.ts: the `task.tabs[shortId]
        // !== targetId` re-check sits immediately before its `delete`). Checking
        // and then awaiting `Page.navigate` before writing leaves exactly the gap
        // the check exists to close: a concurrent navigate passes its own check in
        // that window and both tasks end up driving one tab.
        if (this.targetIsClaimed(conn, reusable)) {
          throw arcNotDrivableError(conn.profile);
        }
        task.tabs[shortId] = reusable;
        // Borrowed, not opened: this tab was in the browser before the task and
        // must survive `done`. See Task.borrowedTabs.
        task.borrowedTabs = [...(task.borrowedTabs ?? []), shortId];
        task.currentTabId = shortId;
        try {
          await conn.cdp.send('Page.navigate', { url }, sessionId);
        } catch (err) {
          // Release the claim we took optimistically, so a failed navigate does
          // not leave the task holding a tab it never drove.
          delete task.tabs[shortId];
          task.borrowedTabs = (task.borrowedTabs ?? []).filter((id) => id !== shortId);
          if (task.currentTabId === shortId) task.currentTabId = undefined;
          throw err;
        }
        this.invalidateTargetCache(conn);
        await this.saveTaskState(task.profile, conn.tasks);
        emit('browser.navigate', {
          profile: task.profile,
          task: task.name,
          url,
          tabId: shortId,
          created: false,
        });
        return { tabId: shortId, url, created: false, refreshed: false };
      }
      // Nothing safe to reuse -- fall through to the actionable refusal rather
      // than taking over a page the user is reading.
    }

    // Chrome: create new tab
    const result = await this.createPageTarget(conn, { url });

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId;
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    emit('browser.navigate', { profile: parseConnectionKey(task.profile).profile, task: task.name, url, tabId: shortId, created: true });
    return { tabId: shortId, url, created: true, refreshed: false };
  }

  async tabAdd(
    taskId: string,
    url: string,
    profileRef?: ProfileName | ConnectionKey,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    const { conn, task } = await this.findTask(taskId, profileRef);
    return this.runExclusive(`task:${task.profile}:${task.name}`, () =>
      this.tabAddLocked(conn, task, url),
    );
  }

  private async tabAddLocked(
    conn: ProfileConnection,
    task: Task,
    url: string,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    if (conn.backend === 'arc-native') {
      return this.navigateArcNative(conn, task, url, true);
    }
    requireCdp(conn, 'createTab');
    if (conn.electron) {
      throw new Error('Electron apps do not support opening additional tabs');
    }

    // Same-task reopen (PHNX-2399): reopening a URL already live in one of this
    // task's own tabs refreshes THAT tab rather than opening a duplicate. The
    // no-match case below stays `tab add`'s intentional create-a-new-tab
    // semantics — distinct from `navigate`, which reuses the current tab.
    const reopened = await this.reopenOwnedTab(conn, task, url);
    if (reopened) {
      return { tabId: reopened.tabId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
    }

    const result = await this.createPageTarget(conn, { url });

    const shortId = generateShortId();
    task.tabs[shortId] = result.targetId;
    task.currentTabId = shortId; // new tab becomes current
    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);

    return { tabId: shortId, url, created: true, refreshed: false };
  }

  async tabFocus(taskId: string, tabHint: string): Promise<{ tabId: string }> {
    const { conn, task } = await this.findTask(taskId);
    const resolvedTabId = await this.resolveTabHint(conn, task, tabHint);
    if (conn.backend === 'arc-native') {
      await this.runExclusive('arc-native:host-app', async () => {
        const ref = this.requireArcTask(task).tabs[resolvedTabId];
        if (!ref) throw new Error(`Tab ${resolvedTabId} not found`);
        await selectArcTab(ref);
        task.currentTabId = resolvedTabId;
        await this.saveTaskState(task.profile, conn.tasks);
      });
      return { tabId: resolvedTabId };
    }
    task.currentTabId = resolvedTabId;
    await this.saveTaskState(task.profile, conn.tasks);
    return { tabId: resolvedTabId };
  }

  async tabList(taskId: string): Promise<Array<{ id: string; url: string; title: string; current: boolean }>> {
    const { conn, task } = await this.findTask(taskId);
    if (conn.backend === 'arc-native') {
      return (await this.listArcTaskTabs(task)).map((tab) => ({ ...tab, current: tab.current === true }));
    }
    requireCdp(conn, 'enumerate');
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: Array<{ id: string; url: string; title: string; current: boolean }> = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          current: shortId === task.currentTabId,
        });
      }
    }
    return tabs;
  }

  private async resolveTabHint(conn: ProfileConnection, task: Task, hint: string): Promise<string> {
    // Exact match
    if (task.tabs[hint]) return hint;

    // Prefix match
    const byPrefix = Object.keys(task.tabs).filter((id) => id.startsWith(hint));
    if (byPrefix.length === 1) return byPrefix[0];
    if (byPrefix.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${byPrefix.length} tabs`);
    }

    // Native Arc addresses owned tabs only by the task's stable short id. URL
    // and title are display data and must never become fallback identities.
    if (conn.backend === 'arc-native') throw new Error(`Tab "${hint}" not found`);

    // URL substring match
    const targets = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string }>;
    };
    const matches: string[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target && target.url.includes(hint)) {
        matches.push(shortId);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous tab hint "${hint}" — matches ${matches.length} tabs by URL`);
    }

    throw new Error(`Tab "${hint}" not found`);
  }

  private resolveCurrentTab(task: Task): string {
    const tabIds = Object.keys(task.tabs);
    const id = task.currentTabId ?? tabIds[tabIds.length - 1];
    if (!id) throw new Error('No tabs open for this task');
    return id;
  }

  private getCdpTargetId(task: Task, shortId: string): string {
    const cdpId = task.tabs[shortId];
    if (!cdpId) throw new Error(`Tab ${shortId} not found`);
    return cdpId;
  }

  async tabs(taskId?: string, profileRef?: ProfileName | ConnectionKey): Promise<TabInfo[]> {
    if (taskId) {
      const { conn, task } = await this.findTask(taskId, profileRef);
      if (conn.backend === 'arc-native') return this.listArcTaskTabs(task);
      return this.getTabsForTask(conn.cdp, task);
    }

    const allTabs: TabInfo[] = [];
    for (const [, conn] of this.connections) {
      for (const [, task] of conn.tasks) {
        const tabs = conn.backend === 'arc-native'
          ? await this.listArcTaskTabs(task)
          : await this.getTabsForTask(conn.cdp, task);
        allTabs.push(...tabs);
      }
    }
    return allTabs;
  }

  async tabClose(taskId: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);

    if (conn.backend === 'arc-native') {
      await this.runExclusive('arc-native:host-app', async () => {
        await this.reconcileArcCreateIntents(conn, task);
        const native = this.requireArcTask(task);
        const ids = tabHint === undefined
          ? Object.keys(native.tabs)
          : [await this.resolveTabHint(conn, task, tabHint)];
        for (const shortId of ids) {
          const ref = native.tabs[shortId];
          if (ref) await closeArcTab(ref);
          delete native.tabs[shortId];
          delete task.tabs[shortId];
          delete task.refDescriptors?.[shortId];
        }
        if (!task.currentTabId || ids.includes(task.currentTabId)) {
          const remaining = Object.keys(native.tabs);
          task.currentTabId = remaining.at(-1);
        }
        await this.saveTaskState(task.profile, conn.tasks);
      });
      return;
    }
    requireCdp(conn, 'closeTab');

    if (tabHint !== undefined) {
      const shortId = await this.resolveTabHint(conn, task, tabHint);
      const cdpId = task.tabs[shortId];
      if (cdpId) {
        // A borrowed tab is released, not closed — it outlives this task.
        if (!(task.borrowedTabs ?? []).includes(shortId)) {
          await conn.cdp.send('Target.closeTarget', { targetId: cdpId });
        }
        conn.sessionCache.delete(cdpId);
        delete task.tabs[shortId];
        // Drop the borrow record with the tab it names, or it outlives every tab
        // it ever described and grows unbounded in the persisted task state.
        task.borrowedTabs = (task.borrowedTabs ?? []).filter((id) => id !== shortId);
        // Update currentTabId if we closed the current tab
        if (task.currentTabId === shortId) {
          const remaining = Object.keys(task.tabs);
          task.currentTabId = remaining.length > 0 ? remaining[remaining.length - 1] : undefined;
        }
      }
    } else {
      // Close all tabs the task opened; borrowed ones are only released.
      await Promise.all(
        this.closeableTargetIds(task).map((cdpId) =>
          conn.cdp.send('Target.closeTarget', { targetId: cdpId }).catch(() => {})
        )
      );
      for (const cdpId of Object.values(task.tabs)) {
        conn.sessionCache.delete(cdpId);
      }
      task.tabs = {};
      task.borrowedTabs = [];
      task.currentTabId = undefined;
    }

    this.invalidateTargetCache(conn);
    await this.saveTaskState(task.profile, conn.tasks);
  }

  async evaluate(
    taskId: string,
    tabHint: string | undefined,
    expression: string
  ): Promise<unknown> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);

    // Native Arc backend (PHNX-2399): synchronous JS only, isolated world.
    if (conn.backend === 'arc-native') {
      return this.evaluateArcNative(conn, task, shortId, expression);
    }

    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    // `awaitPromise: true` lets callers write `evaluate '(async () => {...})()'`
    // and get the resolved value back instead of a stringified Promise. This
    // is essential for any flow that needs sub-step waits inside the page
    // (e.g. driving a multi-step modal where each step needs React to settle
    // before the next call). Without it, the shell-side workaround is to
    // chain N separate `evaluate` calls with `sleep` between them, which
    // races against the page's own state machine.
    //
    // `exceptionDetails` is surfaced as a thrown error so a rejected promise
    // or a thrown error inside the expression doesn't silently return `undefined`.
    const result = (await conn.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )) as {
      result: { value: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
    };

    if (result.exceptionDetails) {
      const ex = result.exceptionDetails;
      const msg =
        ex.exception?.description ??
        (typeof ex.exception?.value === 'string' ? ex.exception.value : undefined) ??
        ex.text ??
        'evaluate failed';
      throw new Error(msg);
    }

    return result.result.value;
  }

  async screenshot(
    taskId: string,
    tabHint?: string,
    outputPath?: string,
    quality: 'compressed' | 'raw' = 'compressed'
  ): Promise<{ path: string; bytes: number; width: number; height: number }> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);

    // Native Arc backend: screenshots cannot select/activate the user's tab.
    if (conn.backend === 'arc-native') {
      throw new ArcNativeCapabilityError(
        'screenshot',
        'Screenshot is unavailable for native Arc automation. ' +
          'Screenshots require activating the tab, which would disrupt user selection. ' +
          'This task still belongs to the Arc profile. ' +
          'Use a Chromium-family browser for screenshot capability.',
      );
    }

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);

    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    let buffer: Buffer;
    let extension: string;

    if (quality === 'raw') {
      // Pixel-faithful PNG, no downscale. For archived QA evidence where
      // lossy JPEG would hide rendering bugs. Files run 0.5–3 MB.
      const { data } = (await conn.cdp.send(
        'Page.captureScreenshot',
        { format: 'png' },
        sessionId
      )) as { data: string };
      buffer = Buffer.from(data, 'base64');
      extension = 'png';
    } else {
      // Default: JPEG quality 70, then iteratively downscale to keep the
      // file under 100 KB so chat-injected screenshots stay token-cheap.
      const { data } = (await conn.cdp.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 70 },
        sessionId
      )) as { data: string };
      buffer = Buffer.from(data, 'base64');

      const MAX_SIZE = 100 * 1024;
      if (buffer.length > MAX_SIZE) {
        let q = 50;
        while (buffer.length > MAX_SIZE && q > 10) {
          const { data: resized } = (await conn.cdp.send(
            'Page.captureScreenshot',
            { format: 'jpeg', quality: q },
            sessionId
          )) as { data: string };
          buffer = Buffer.from(resized, 'base64');
          q -= 10;
        }
      }
      extension = 'jpg';
    }

    const sessionsDir = getProfileSessionsDir(runtimeKey, task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.${extension}`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    const dims =
      (extension === 'png' ? readPngDimensions(buffer) : readJpegDimensions(buffer)) ??
      { width: 0, height: 0 };
    emit('browser.screenshot', {
      profile: parseConnectionKey(runtimeKey).profile,
      task: task.name,
      tabId: shortId,
      path: finalPath,
      bytes: buffer.length,
      width: dims.width,
      height: dims.height,
      quality,
    });
    return { path: finalPath, bytes: buffer.length, width: dims.width, height: dims.height };
  }

  /**
   * Export the current tab as a PDF via CDP `Page.printToPDF`. Reuses the
   * screenshot session + tab resolution so `--tab`, path sandboxing, and the
   * auto-path (`sessions/<task>/<ts>.pdf`) all behave identically to
   * `screenshot`. `printBackground: true` matches Chrome's default print flow
   * — without it, dark-mode pages render on a blank sheet.
   */
  async printToPdf(
    taskId: string,
    tabHint?: string,
    outputPath?: string
  ): Promise<{ path: string; bytes: number }> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'pdf');

    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) {
      throw new Error(`Tab ${shortId} not found`);
    }

    const sessionId = await this.getSessionId(conn, target.targetId);

    const { data } = (await conn.cdp.send(
      'Page.printToPDF',
      { printBackground: true, preferCSSPageSize: true },
      sessionId
    )) as { data: string };
    const buffer = Buffer.from(data, 'base64');

    const sessionsDir = getProfileSessionsDir(runtimeKey, task.name);
    const automaticPath = path.join(sessionsDir, `${Date.now()}.pdf`);
    const finalPath = resolveScreenshotOutputPath(outputPath, automaticPath);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.promises.writeFile(finalPath, buffer);

    return { path: finalPath, bytes: buffer.length };
  }

  // ─── Recording ──────────────────────────────────────────────────────────────
  //
  // CDP `Page.startScreencast` emits a JPEG frame per `everyNthFrame`. We pipe
  // those frames into ffmpeg's stdin (image2pipe) and encode to a webm/vp9 file
  // under `sessions/<task>/recordings/`. A background watcher enforces the
  // duration + size caps so a forgotten recording can't fill the disk.
  private recordings = new Map<string, {
    outputPath: string;
    startedAt: number;
    fps: number;
    maxBytes: number;
    durationMs: number;
    ffmpeg: import('child_process').ChildProcess;
    ffmpegStderr: () => string;
    encoderError: () => Error | undefined;
    frameCount: number;
    sessionId: string;
    conn: CdpProfileConnection;
    frameHandler: (params: unknown) => void;
    framePump: NodeJS.Timeout;
    durationTimer: NodeJS.Timeout;
    sizeCheckInterval: NodeJS.Timeout;
    stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  }>();

  async recordStart(
    taskId: string,
    tabHint?: string,
    opts: { fps?: number; duration?: number; maxMb?: number } = {}
  ): Promise<{ path: string; fps: number; durationCapSec: number; maxMb: number }> {
    if (this.recordings.has(taskId)) {
      throw new Error(`Task "${taskId}" is already recording. Call record stop first.`);
    }

    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'screenshot');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);
    const sessionId = await this.getSessionId(conn, target.targetId);

    const fps = opts.fps ?? 5;
    const durationSec = opts.duration ?? 60;
    const maxMb = opts.maxMb ?? 25;
    if (fps < 1 || fps > 30) throw new Error('--fps must be between 1 and 30');
    if (durationSec < 1 || durationSec > 3600) throw new Error('--duration must be between 1 and 3600 seconds');
    if (maxMb < 1 || maxMb > 500) throw new Error('--max-mb must be between 1 and 500');

    const recordingsDir = path.join(getProfileSessionsDir(runtimeKey, task.name), 'recordings');
    await fs.promises.mkdir(recordingsDir, { recursive: true });
    const outputPath = path.join(recordingsDir, `${Date.now()}.webm`);

    // Resolve ffmpeg lazily so non-recording paths don't pay the import cost.
    const [{ spawn }, ffmpegPath] = await Promise.all([
      import('child_process'),
      resolveFfmpeg(),
    ]);
    // The frame pump below clocks the latest CDP paint into stdin at exactly
    // `fps`, including repeated frames while the page is static. Declare that
    // cadence to image2pipe so frame count / fps is the real capture duration.
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-loglevel', 'error',
        '-f', 'image2pipe',
        '-framerate', String(fps),
        '-i', '-',
        '-c:v', 'libvpx-vp9',
        '-b:v', '1M',
        '-pix_fmt', 'yuv420p',
        '-y',
        outputPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
    );
    // Wait for the spawn to confirm before wiring CDP frames into a dead pipe.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        ffmpeg.off('spawn', onSpawn);
        reject(err);
      };
      const onSpawn = () => {
        ffmpeg.off('error', onError);
        resolve();
      };
      ffmpeg.once('error', onError);
      ffmpeg.once('spawn', onSpawn);
    });

    // Capture ffmpeg's own diagnostics (encoder error, bad codec, etc.) so a
    // failing encode is DIAGNOSABLE at recordStop instead of being discarded.
    // Cap the buffer so a chatty ffmpeg can't grow it unbounded.
    let stderrBuf = '';
    ffmpeg.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-64 * 1024);
    });
    const ffmpegStderr = () => stderrBuf;
    ffmpeg.on('error', () => { /* post-spawn errors get reported via exit code */ });

    let frameCount = 0;
    let latestFrame: Buffer | undefined;
    let stdinBlocked = false;
    let stdinError: Error | undefined;
    ffmpeg.stdin?.on('drain', () => { stdinBlocked = false; });
    ffmpeg.stdin?.on('error', (error) => { stdinError = error; });
    const writeFrame = (frame: Buffer): boolean => {
      const stdin = ffmpeg.stdin;
      if (!stdin || stdin.destroyed || stdinError || stdinBlocked) return false;
      stdinBlocked = !stdin.write(frame);
      frameCount += 1;
      return true;
    };
    const frameIntervalMs = 1000 / fps;
    let resolveFirstFrame!: () => void;
    const firstFrame = new Promise<void>((resolve) => { resolveFirstFrame = resolve; });
    const frameHandler = (params: unknown, eventSessionId?: string) => {
      if (eventSessionId !== sessionId) return;
      const p = params as { data: string; sessionId: number };
      try {
        latestFrame = Buffer.from(p.data, 'base64');
        if (frameCount === 0) {
          if (writeFrame(latestFrame)) resolveFirstFrame();
        }
      } catch {
        // ffmpeg exited; ignore writes
      }
      // Must ack every frame or CDP stops sending.
      conn.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sessionId).catch(() => {});
    };
    // CDP emits on paints, so a static page can legitimately produce only one
    // event in 15 seconds. Retain the latest real frame and clock it into the
    // encoder at --fps; new paints replace it, while quiet time still advances
    // the WebM timeline instead of collapsing to a one-frame, 0.04s artifact.
    const framePump = setInterval(() => {
      if (!latestFrame) return;
      try {
        writeFrame(latestFrame);
      } catch {
        // ffmpeg exited; recordStop reports its exit code and stderr.
      }
    }, frameIntervalMs);
    // Register BEFORE startScreencast. Chrome may emit its first frame before
    // the command response; missing that frame also misses its ack and stalls
    // the entire stream with ffmpeg's stdin still empty (PHNX-2600).
    conn.cdp.on('Page.screencastFrame', frameHandler);

    try {
      await conn.cdp.send('Page.enable', {}, sessionId);
      await conn.cdp.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: 60,
          // Chrome's frames are paint-driven, not a 30fps clock. Asking for
          // every third paint can suppress the only stored frame on a static
          // page, so receive every paint and enforce --fps when writing stdin.
          everyNthFrame: 1,
          maxFramesInFlight: 1,
          // A static/low-paint page may produce no new compositor frame after
          // startScreencast. Ask Chrome to send its stored last frame so the
          // first ack can bootstrap the stream instead of leaving ffmpeg stdin
          // empty forever (confirmed live against Chrome 151 / PHNX-2600).
          sendLastFrame: true,
        },
        sessionId
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Chrome produced no screencast frame within 5s; recording was not started.')),
          5000,
        );
        firstFrame.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch (error) {
      conn.cdp.off('Page.screencastFrame', frameHandler);
      clearInterval(framePump);
      try { await conn.cdp.send('Page.stopScreencast', {}, sessionId); } catch { /* session may be gone */ }
      try { ffmpeg.stdin?.end(); } catch { /* process may already be gone */ }
      await new Promise<void>((resolve) => {
        if (ffmpeg.exitCode !== null) return resolve();
        const timer = setTimeout(() => {
          try { ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
          resolve();
        }, 1000);
        ffmpeg.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await fs.promises.rm(outputPath, { force: true });
      throw error;
    }

    const durationMs = durationSec * 1000;
    const maxBytes = maxMb * 1024 * 1024;

    const state = {
      outputPath,
      startedAt: Date.now(),
      fps,
      durationMs,
      maxBytes,
      ffmpeg,
      ffmpegStderr,
      encoderError: () => stdinError,
      get frameCount() { return frameCount; },
      sessionId,
      conn,
      frameHandler,
      framePump,
      durationTimer: setTimeout(() => {
        this.recordStop(taskId, 'duration-cap').catch(() => {});
      }, durationMs),
      sizeCheckInterval: setInterval(async () => {
        try {
          const st = await fs.promises.stat(outputPath);
          if (st.size >= maxBytes) {
            await this.recordStop(taskId, 'size-cap');
          }
        } catch {
          // File may not exist yet
        }
      }, 1000),
    };
    this.recordings.set(taskId, state);

    return { path: outputPath, fps, durationCapSec: durationSec, maxMb };
  }

  async recordStop(
    taskId: string,
    reason: 'manual' | 'duration-cap' | 'size-cap' = 'manual'
  ): Promise<{ path: string; bytes: number; durationMs: number; reason: string }> {
    const activeTask = await this.findTask(taskId).catch(() => undefined);
    if (activeTask) requireCdp(activeTask.conn, 'screenshot');
    const rec = this.recordings.get(taskId);
    if (!rec) {
      throw new Error(`Task "${taskId}" is not currently recording`);
    }
    if (rec.stopReason) {
      // Already stopping (e.g. size-cap fired while user also called stop).
      // Wait for in-flight finalize.
      while (this.recordings.has(taskId)) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    rec.stopReason = reason;

    clearTimeout(rec.durationTimer);
    clearInterval(rec.sizeCheckInterval);
    clearInterval(rec.framePump);
    rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler);

    try {
      await rec.conn.cdp.send('Page.stopScreencast', {}, rec.sessionId);
    } catch {
      // session may already be gone
    }

    // Close ffmpeg stdin so it flushes the output file cleanly, and observe how
    // it exits. A non-zero exit means the encode failed — the recording must
    // NOT be reported as success. If ffmpeg hangs, KILL it (don't just abandon
    // the promise, which leaked the process) and treat the recording as failed.
    const finalize = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
      let done = false;
      const settle = (r: { code: number | null; timedOut: boolean }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
        settle({ code: null, timedOut: true });
      }, 5000);
      rec.ffmpeg.once('exit', (code) => settle({ code, timedOut: false }));
      try {
        rec.ffmpeg.stdin?.end();
      } catch {
        // stdin already closed; wait for exit or the hard timeout above.
      }
    });

    const durationMs = Date.now() - rec.startedAt;
    // Drop the recording from the map before any throw, so a failed stop
    // doesn't wedge the task in a permanent "already recording" state.
    this.recordings.delete(taskId);

    if (finalize.timedOut) {
      throw new Error(
        `ffmpeg did not exit within 5s while finalizing the recording; killed it. ` +
          `The recording at ${rec.outputPath} is incomplete.`
      );
    }
    if (finalize.code !== 0) {
      const err = rec.ffmpegStderr().trim();
      throw new Error(
        `ffmpeg exited abnormally (code ${finalize.code}) while finalizing the recording at ` +
          `${rec.outputPath}; the file is likely corrupt or empty.` +
          (err ? ` ffmpeg: ${err.slice(-800)}` : '')
      );
    }

    const encoderError = rec.encoderError?.();
    if (encoderError) {
      throw new Error(
        `ffmpeg stopped accepting recording frames at ${rec.outputPath}: ${encoderError.message}`
      );
    }

    if (rec.frameCount === 0) {
      throw new Error(`Chrome delivered no frames for the recording at ${rec.outputPath}; the output is empty.`);
    }

    let bytes = 0;
    try {
      const st = await fs.promises.stat(rec.outputPath);
      bytes = st.size;
    } catch {
      // ffmpeg exited 0 but the file is missing — still a failed recording.
    }
    return { path: rec.outputPath, bytes, durationMs, reason };
  }

  async recordStatus(taskId: string): Promise<{ recording: boolean; path?: string; elapsedMs?: number }> {
    // The idle reaper calls this while deciding whether a task is stale. Do
    // not route an already-live task through findTask(), which stamps it as
    // active and defeats idle detection. A cold daemon may still rehydrate for
    // an explicit user query.
    const live = this.findTaskByHandle(taskId) ?? await this.findTask(taskId).catch(() => undefined);
    if (live) requireCdp(live.conn, 'screenshot');
    const rec = this.recordings.get(taskId);
    if (!rec) return { recording: false };
    return { recording: true, path: rec.outputPath, elapsedMs: Date.now() - rec.startedAt };
  }

  async refs(
    taskId: string,
    tabHint?: string,
    opts: RefOpts = {}
  ): Promise<{ refs: string; nodeMap: Map<number, RefNode> }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      const result = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(opts)),
        opts,
      );
      this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
      await this.saveTaskState(task.profile, conn.tasks);
      return result;
    }
    requireCdp(conn, 'enumerate');
    const cdpTargetId = this.getCdpTargetId(task, shortId);

    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const result = await getRefs(conn.cdp, sessionId, opts);
    // Snapshot the stable descriptors AND the opts they were numbered against
    // so a later click/type can self-heal a drifted ref by rebuilding with the
    // same filter. `refs()` is the sole owner of this cache — actions read it,
    // never overwrite it. Persist to tasks.json so it survives a daemon
    // restart.
    this.cacheRefDescriptors(task, shortId, result.nodeMap, result.opts);
    await this.saveTaskState(task.profile, conn.tasks);
    return { refs: result.refs, nodeMap: result.nodeMap };
  }

  /** Record the last ref listing (descriptors + opts) for a tab into state. */
  private cacheRefDescriptors(
    task: Task,
    shortId: string,
    nodeMap: Map<number, RefNode>,
    opts: { interactive: boolean; limit: number }
  ): void {
    if (!task.refDescriptors) task.refDescriptors = {};
    task.refDescriptors[shortId] = { descriptors: describeRefs(nodeMap), opts };
  }

  /**
   * Re-resolve a caller-supplied ref against a freshly-built node map, healing
   * it back to the right element when the integer ref has drifted since the
   * cached `refs` listing. Shared by `click` and `type` so both self-heal
   * identically. Returns the ref to act on plus, when a heal occurred, the
   * {@link HealInfo} to surface. Throws when the cached element is gone.
   */
  private resolveHealedRef(
    snapshot: RefSnapshot | undefined,
    nodeMap: Map<number, RefNode>,
    ref: number
  ): { targetRef: number; healed?: HealInfo } {
    const cached = snapshot?.descriptors.find((d) => d.ref === ref);
    if (!cached) return { targetRef: ref };

    const fresh = nodeMap.get(ref);
    const stillMatches =
      fresh !== undefined &&
      fresh.role === cached.role &&
      fresh.name === cached.name &&
      (fresh.backendNodeId !== undefined || fresh.selector !== undefined);
    if (stillMatches) return { targetRef: ref };

    const newRef = healRef(cached, nodeMap);
    if (newRef === null) {
      throw new Error(
        `Ref ${ref} (${cached.role} "${cached.name}") could not be re-resolved: ` +
          `no matching element on the current page. Re-run 'browser refs' to ` +
          `refresh the ref numbers, or act by position with 'browser click --at X,Y'.`
      );
    }
    if (newRef === ref) return { targetRef: ref };

    console.error(
      `[browser] self-healed ref ${ref} -> ${newRef} (${cached.role} "${cached.name}") — ` +
        `cached descriptor re-matched after the ref drifted`
    );
    return { targetRef: newRef, healed: { from: ref, to: newRef, role: cached.role, name: cached.name } };
  }

  async click(taskId: string, ref: number, tabHint?: string): Promise<{ healed?: HealInfo }> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      await this.evaluateArcNative(conn, task, shortId, arcClickExpression(selector));
      return healed ? { healed } : {};
    }
    requireCdp(conn, 'click');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Rebuild the node map with the SAME opts the cached listing was numbered
    // against, so the caller's ref lands on the element they saw in `browser
    // refs`. Rebuilding with a different filter (the old interactive:false)
    // renumbers every ref and defeats self-heal on the second click. Default
    // to the user-facing interactive numbering when no listing was cached yet.
    const snapshot = task.refDescriptors?.[shortId];
    const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
    const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);

    // Self-heal: the integer ref is positional and drifts on re-render. If the
    // fresh node at this position no longer matches the cached descriptor,
    // re-resolve (by attrs/proximity-tie-broken role+name) BEFORE clicking the
    // wrong element. The cache is owned by refs() and NOT rewritten here — the
    // caller's ref numbers stay anchored to the listing they came from.
    const { targetRef, healed } = this.resolveHealedRef(snapshot, nodeMap, ref);

    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, targetRef);
    await clickAtCoords(conn.cdp, sessionId, x, y);

    return healed ? { healed } : {};
  }

  /**
   * Click raw viewport coordinates, bypassing ref resolution entirely. Backs
   * `browser click --at X,Y` — the escape hatch when the accessibility tree
   * exposes no usable ref (canvas apps, custom-drawn UI) and the caller has
   * located the target from a screenshot.
   */
  async clickAt(taskId: string, x: number, y: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await clickAtCoords(conn.cdp, sessionId, x, y);
  }

  async type(taskId: string, ref: number, text: string, tabHint?: string, clear?: boolean): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      const snapshot = task.refDescriptors?.[shortId];
      const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
      const { nodeMap } = parseArcRefsResult(
        await this.evaluateArcNative(conn, task, shortId, arcRefsExpression(buildOpts)),
        buildOpts,
      );
      const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
      const selector = nodeMap.get(targetRef)?.selector;
      if (!selector) throw new Error(`Ref ${ref} has no DOM selector`);
      await this.evaluateArcNative(conn, task, shortId, arcFillExpression(selector, text, clear ?? false));
      return;
    }
    requireCdp(conn, 'type');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Same self-healing story as click(): rebuild against the cached listing's
    // opts so refs line up with what the user saw, then heal a drifted ref
    // before typing into the wrong field.
    const snapshot = task.refDescriptors?.[shortId];
    const buildOpts = snapshot?.opts ?? { interactive: true, limit: 500 };
    const { nodeMap } = await getRefs(conn.cdp, sessionId, buildOpts);
    const { targetRef } = this.resolveHealedRef(snapshot, nodeMap, ref);
    const node = nodeMap.get(targetRef);
    if (!node) throw new Error(`Ref ${ref} not found`);
    if (node.editor) {
      await typeEditorText(conn.cdp, sessionId, node, text, clear);
    } else {
      if (node.backendNodeId) {
        await focusNode(conn.cdp, sessionId, node.backendNodeId);
      }
      await typeText(conn.cdp, sessionId, text);
    }
  }

  async press(taskId: string, key: string, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await pressKey(conn.cdp, sessionId, key);
  }

  async hover(taskId: string, ref: number, tabHint?: string): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'trustedInput');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: false, limit: 1000 });
    const { x, y } = await resolveRefToCoords(conn.cdp, sessionId, nodeMap, ref);
    await hoverAtCoords(conn.cdp, sessionId, x, y);
  }

  async scroll(
    taskId: string,
    deltaX: number,
    deltaY: number,
    atX?: number,
    atY?: number,
    tabHint?: string
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    if (conn.backend === 'arc-native') {
      if (atX !== undefined || atY !== undefined) throw new ArcNativeCapabilityError('trustedInput');
      await this.evaluateArcNative(conn, task, shortId, arcScrollExpression(deltaX, deltaY));
      return;
    }
    requireCdp(conn, 'scroll');
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await scrollAtCoords(conn.cdp, sessionId, atX ?? 0, atY ?? 0, deltaX, deltaY);
  }

  async upload(
    taskId: string,
    files: string[],
    options: {
      ref?: number;
      trigger?: number;
      mode?: UploadMode;
      tabHint?: string;
      timeout?: number;
    }
  ): Promise<{ mode: 'input' | 'drop' | 'chooser' }> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'upload');
    const shortId = options.tabHint
      ? await this.resolveTabHint(conn, task, options.tabHint)
      : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    // Match the user-facing ref numbering from `agents browser refs` (which
    // defaults to interactive=true). The other action helpers in this file
    // use interactive=false historically, but that produces ref numbers the
    // user never sees — `--ref 1` then resolves to the RootWebArea instead of
    // the first interactive element. Match the listing the user actually saw.
    const { nodeMap } = await getRefs(conn.cdp, sessionId, { interactive: true, limit: 1000 });

    const mode = options.mode ?? 'auto';

    if (options.trigger !== undefined || mode === 'chooser') {
      const ref = options.trigger ?? options.ref;
      if (ref === undefined) {
        throw new Error('chooser mode requires --trigger <ref> (or --ref) pointing at the button that opens the file dialog');
      }
      const node = nodeMap.get(ref);
      if (!node) throw new Error(`Ref ${ref} not found`);
      await uploadViaFileChooser(
        conn.cdp,
        sessionId,
        { node, nodeMap },
        files,
        options.timeout
      );
      return { mode: 'chooser' };
    }

    if (options.ref === undefined) {
      throw new Error('upload requires --ref <n> (target element) or --trigger <n> (button that opens chooser)');
    }
    const node = nodeMap.get(options.ref);
    if (!node) throw new Error(`Ref ${options.ref} not found`);
    if (!node.backendNodeId) throw new Error(`Ref ${options.ref} has no DOM node`);

    let resolved: 'input' | 'drop';
    if (mode === 'input') {
      resolved = 'input';
    } else if (mode === 'drop') {
      resolved = 'drop';
    } else {
      resolved = await detectUploadPattern(conn.cdp, sessionId, node.backendNodeId);
    }

    if (resolved === 'input') {
      await uploadToFileInput(conn.cdp, sessionId, node.backendNodeId, files);
    } else {
      await uploadToDropTarget(conn.cdp, sessionId, node.backendNodeId, files);
    }
    return { mode: resolved };
  }

  stageUpload(source: string): { path: string } {
    return { path: stageUploadFile(source) };
  }

  /**
   * Status for one profile (bare name) or every live profile.
   *
   * `profileName` is a {@link ProfileName} — a BARE name, never a runtime key.
   * Every candidate is selected by the one rule ({@link keyBelongsToProfile}),
   * and a scoped query that finds no live connection falls through to disk, so
   * `status --profile comet-local` reports the LIVE `comet-local@<device>`
   * (and leftover `comet-local@endpoint-0` dirs) instead of the empty list
   * it used to return (RUSH-2709).
   */
  async status(profileRef?: ProfileName | ConnectionKey): Promise<ProfileStatus[]> {
    // Reconnect live browsers after a daemon restart so status is not empty
    // while tasks.json still holds open work.
    await this.rehydrateAllFromDisk();

    // A caller who pasted a runtime key out of an older listing still gets the
    // profile it belongs to, rather than an empty result.
    const profileName = profileRef ? parseConnectionKey(profileRef).profile : undefined;

    const seenProfiles = new Set<ProfileName>();
    const statuses: ProfileStatus[] = [];

    const candidates = profileName
      ? [...this.connections.keys()].filter((k) => keyBelongsToProfile(k, profileName))
      : Array.from(this.connections.keys());

    for (const key of candidates) {
      const status = await this.getProfileStatus(key);
      if (status) {
        statuses.push(status);
        seenProfiles.add(status.name);
      }
    }

    if (!profileName) {
      for (const profile of await listProfiles()) {
        if (seenProfiles.has(profile.name)) continue;
        const reconciled = await this.reconcileFromDisk(profile.name);
        if (reconciled) statuses.push(reconciled);
      }
    } else if (statuses.length === 0) {
      const reconciled = await this.reconcileFromDisk(profileName);
      if (reconciled) statuses.push(reconciled);
    }

    return statuses;
  }

  /**
   * Rebuild a profile's status from its runtime dirs when no live connection is
   * registered — a daemon that never connected this profile, or a browser
   * started by an earlier daemon.
   *
   * Takes a BARE profile name and walks every runtime key that belongs to it
   * ({@link listProfileCacheDirs}), including the legacy pre-composite dir named
   * exactly the profile.
   */
  private async reconcileFromDisk(profileName: ProfileName): Promise<ProfileStatus | null> {
    const dirs = listProfileCacheDirs(profileName);
    for (const dir of dirs) {
      const key = asConnectionKey(path.basename(dir));
      const info = getRunningChromeInfo(key);
      if (!info) continue;
      return this.profileStatusFromDisk(profileName, key, info.port, info.pid);
    }
    return null;
  }

  private async profileStatusFromDisk(
    profileName: ProfileName,
    runtimeKey: ConnectionKey,
    port: number,
    pid: number,
  ): Promise<ProfileStatus> {
    const profile = await getProfile(profileName);
    const tasks = this.loadTaskState(runtimeKey);
    const taskStatuses: TaskStatus[] = [];
    for (const [, task] of tasks) {
      taskStatuses.push({
        id: task.id,
        name: task.name,
        label: task.label ?? task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
      });
    }
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;
    return {
      // Bare name for the user; the endpoint travels in its own field.
      name: profileName,
      endpoint: parseConnectionKey(runtimeKey).endpoint,
      key: runtimeKey,
      running: true,
      port,
      pid,
      configuredPort: configuredPort !== port ? configuredPort : undefined,
      tasks: taskStatuses,
    };
  }

  // ─── Viewport & Device Emulation ──────────────────────────────────────────────

  async setViewport(
    taskId: string,
    width: number,
    height: number,
    options: { mobile?: boolean; deviceScaleFactor?: number; tabHint?: string } = {}
  ): Promise<void> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'viewport');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    await conn.cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width,
        height,
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        mobile: options.mobile ?? false,
      },
      sessionId
    );
  }

  async setDevice(taskId: string, deviceName: string, tabHint?: string): Promise<void> {
    const { getDevice } = await import('./devices.js');
    const device = getDevice(deviceName);
    if (!device) {
      const { listDevices } = await import('./devices.js');
      throw new Error(`Unknown device "${deviceName}". Available: ${listDevices().join(', ')}`);
    }
    await this.setViewport(taskId, device.width, device.height, {
      mobile: device.mobile,
      deviceScaleFactor: device.deviceScaleFactor,
      tabHint,
    });
  }

  // ─── Console & Errors ────────────────────────────────────────────────────────

  private async enableRuntimeForSession(conn: CdpProfileConnection, sessionId: string): Promise<void> {
    const key = `${sessionId}:Runtime`;
    if (this.enabledSessions.get(sessionId)?.has('Runtime')) return;

    await conn.cdp.send('Runtime.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Runtime');

    conn.cdp.on('Runtime.consoleAPICalled', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const entry: import('./types.js').ConsoleEntry = {
        level: params.type === 'warning' ? 'warn' : params.type,
        text: params.args?.map((a: any) => a.value ?? a.description ?? '').join(' ') || '',
        timestamp: Date.now(),
        url: params.stackTrace?.callFrames?.[0]?.url,
        line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      };

      if (!this.consoleLogs.has(taskId)) this.consoleLogs.set(taskId, []);
      const logs = this.consoleLogs.get(taskId)!;
      logs.push(entry);
      if (logs.length > 1000) logs.shift();
    });

    conn.cdp.on('Runtime.exceptionThrown', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const taskId = this.findTaskBySession(conn, sessionId);
      if (!taskId) return;

      const ex = params.exceptionDetails;
      const entry: import('./types.js').ErrorEntry = {
        message: ex.exception?.description || ex.text || 'Unknown error',
        stack: ex.stackTrace?.callFrames?.map((f: any) => `  at ${f.functionName || '<anonymous>'} (${f.url}:${f.lineNumber})`).join('\n'),
        timestamp: Date.now(),
        url: ex.url,
        line: ex.lineNumber,
      };

      if (!this.pageErrors.has(taskId)) this.pageErrors.set(taskId, []);
      const errors = this.pageErrors.get(taskId)!;
      errors.push(entry);
      if (errors.length > 500) errors.shift();
    });
  }

  async getConsoleLogs(
    taskId: string,
    options: { level?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ConsoleEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'consoleCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    let logs = this.consoleLogs.get(taskId) || [];
    if (options.level) {
      logs = logs.filter((l) => l.level === options.level);
    }
    if (options.clear) {
      this.consoleLogs.set(taskId, []);
    }
    return logs;
  }

  async getErrors(
    taskId: string,
    options: { clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').ErrorEntry[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'consoleCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableRuntimeForSession(conn, sessionId);

    const errors = this.pageErrors.get(taskId) || [];
    if (options.clear) {
      this.pageErrors.set(taskId, []);
    }
    return errors;
  }

  // ─── Network Requests ────────────────────────────────────────────────────────

  private async enableNetworkForSession(conn: CdpProfileConnection, sessionId: string, taskId: string): Promise<void> {
    if (this.enabledSessions.get(sessionId)?.has('Network')) return;

    await conn.cdp.send('Network.enable', {}, sessionId);

    if (!this.enabledSessions.has(sessionId)) {
      this.enabledSessions.set(sessionId, new Set());
    }
    this.enabledSessions.get(sessionId)!.add('Network');

    const requestMap = new Map<string, import('./types.js').NetworkRequest>();

    conn.cdp.on('Network.requestWillBeSent', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req: import('./types.js').NetworkRequest = {
        id: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: Date.now(),
      };
      requestMap.set(params.requestId, req);

      if (!this.networkRequests.has(taskId)) this.networkRequests.set(taskId, []);
      const reqs = this.networkRequests.get(taskId)!;
      reqs.push(req);
      if (reqs.length > 500) reqs.shift();
    });

    conn.cdp.on('Network.responseReceived', (params: any) => {
      if (params.sessionId !== sessionId) return;
      const req = requestMap.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.mimeType = params.response.mimeType;
      }
    });
  }

  async getNetworkRequests(
    taskId: string,
    options: { filter?: string; clear?: boolean; tabHint?: string } = {}
  ): Promise<import('./types.js').NetworkRequest[]> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'networkCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    let requests = this.networkRequests.get(taskId) || [];
    if (options.filter) {
      const f = options.filter.toLowerCase();
      requests = requests.filter((r) => r.url.toLowerCase().includes(f));
    }
    if (options.clear) {
      this.networkRequests.set(taskId, []);
    }
    return requests;
  }

  async getResponseBody(
    taskId: string,
    urlPattern: string,
    options: { timeout?: number; maxChars?: number; tabHint?: string } = {}
  ): Promise<string> {
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'networkCapture');
    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    await this.enableNetworkForSession(conn, sessionId, taskId);

    const timeout = options.timeout ?? 30000;
    const maxChars = options.maxChars ?? 200000;
    const start = Date.now();
    const pattern = urlPattern.includes('*')
      ? new RegExp(urlPattern.replace(/\*/g, '.*'), 'i')
      : null;

    while (Date.now() - start < timeout) {
      const requests = this.networkRequests.get(taskId) || [];
      const match = requests.find((r) =>
        pattern ? pattern.test(r.url) : r.url.includes(urlPattern)
      );

      if (match && match.status) {
        try {
          const { body, base64Encoded } = (await conn.cdp.send(
            'Network.getResponseBody',
            { requestId: match.id },
            sessionId
          )) as { body: string; base64Encoded: boolean };

          const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
          return text.slice(0, maxChars);
        } catch {
          // Request may have been evicted, continue waiting
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error(`No response matching "${urlPattern}" within ${timeout}ms`);
  }

  // ─── App Logs (source-side JSONL) ───────────────────────────────────────────

  async getAppLogs(
    taskId: string,
    opts: {
      lines?: number;
      level?: string;
      filter?: string;
      message?: string;
      source?: string;
      since?: string;
      until?: string;
    }
  ): Promise<any[]> {
    const { task } = await this.findTask(taskId);
    const baseProfileName = task.profile.split('@')[0];
    const profile = await getProfile(baseProfileName);
    if (!profile?.logDir) {
      throw new Error(`Profile '${task.profile}' has no logDir set`);
    }
    const logDir = expandHome(profile.logDir);

    const sources = opts.source ? [opts.source] : ['rush-app', 'rush-cli'];
    const since = opts.since ? parseSinceUntil(opts.since) : null;
    const until = opts.until ? parseSinceUntil(opts.until) : null;
    const tailN = since ? 100_000 : (opts.lines ?? 200);

    const raws = await Promise.all(
      sources.map(async (src) => {
        const prefix = BrowserService.SOURCE_PREFIX[src];
        if (!prefix) return '';
        if (profile.logHost) {
          return execSSH(
            profile.logHost,
            readNewestMatchingRemoteFileCommand(logDir, prefix, tailN)
          );
        }
        return readNewestMatchingFile(logDir, prefix, tailN);
      })
    );

    const entries = raws
      .flatMap((r) => r.split('\n').filter(Boolean))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      })
      .filter((e) => !opts.level || e.level === opts.level)
      .filter((e) => !opts.message || e.message === opts.message)
      .filter((e) => !opts.filter || JSON.stringify(e).includes(opts.filter))
      .filter((e) => !since || (e.timestamp && new Date(e.timestamp) >= since))
      .filter((e) => !until || (e.timestamp && new Date(e.timestamp) <= until))
      .sort(
        (a, b) =>
          new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime()
      );

    return since ? entries : entries.slice(-(opts.lines ?? 200));
  }

  // ─── Wait Conditions ─────────────────────────────────────────────────────────

  async wait(
    taskId: string,
    type: 'time' | 'selector' | 'url' | 'function' | 'load',
    value: string | number,
    options: { timeout?: number; tabHint?: string } = {}
  ): Promise<void> {
    const timeout = options.timeout ?? 30000;
    const { conn, task } = await this.findTask(taskId);
    requireCdp(conn, 'asyncEvaluate');

    if (type === 'time') {
      await new Promise((r) => setTimeout(r, typeof value === 'number' ? value : parseInt(value as string, 10)));
      return;
    }

    const shortId = options.tabHint ? await this.resolveTabHint(conn, task, options.tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);
    const start = Date.now();

    while (Date.now() - start < timeout) {
      let condition = false;

      if (type === 'selector') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!document.querySelector(${JSON.stringify(value)})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'url') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        const pattern = (value as string).includes('*')
          ? new RegExp((value as string).replace(/\*/g, '.*'), 'i')
          : null;
        condition = pattern ? pattern.test(result.result.value) : result.result.value.includes(value as string);
      } else if (type === 'function') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: `!!(${value})`, returnByValue: true },
          sessionId
        )) as { result: { value: boolean } };
        condition = result.result.value === true;
      } else if (type === 'load') {
        const result = (await conn.cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          sessionId
        )) as { result: { value: string } };
        if (value === 'domcontentloaded') {
          condition = result.result.value !== 'loading';
        } else if (value === 'load' || value === 'complete') {
          condition = result.result.value === 'complete';
        } else if (value === 'networkidle') {
          // Simplified: check if document is complete
          condition = result.result.value === 'complete';
        }
      }

      if (condition) return;
      await new Promise((r) => setTimeout(r, 100));
    }

    throw new Error(`Wait condition "${type}:${value}" not met within ${timeout}ms`);
  }

  // ─── Downloads ───────────────────────────────────────────────────────────────

  /**
   * Point the browser's default download destination at the profile's downloads
   * dir, browser-global, at connect time. Without this a download the agent never
   * explicitly routed (`browser download --path`) falls to Chromium's own default
   * — for an attached user browser, wherever that browser was last configured,
   * which is how downloads used to escape into random locations. Sent on the root
   * session (no sessionId) so every current and future tab inherits it. Best
   * effort: a remote CDP endpoint that doesn't expose the Browser domain must not
   * fail the whole connect.
   */
  private async applyDefaultDownloadBehavior(conn: CdpProfileConnection, key: ConnectionKey): Promise<void> {
    const downloadPath = getProfileDownloadsDir(key);
    try {
      await fs.promises.mkdir(downloadPath, { recursive: true });
      await conn.cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath,
        eventsEnabled: true,
      });
    } catch {
      // Best effort: a remote CDP endpoint (ssh://, ws(s)://) may not expose the
      // Browser domain. Downloads then keep the endpoint's own default; the connect
      // must still succeed.
    }
  }

  async setDownloadPath(taskId: string, downloadPath?: string, tabHint?: string): Promise<string> {
    const { conn, task, key: runtimeKey } = await this.findTask(taskId);
    requireCdp(conn, 'download');
    const shortId = tabHint ? await this.resolveTabHint(conn, task, tabHint) : this.resolveCurrentTab(task);
    const cdpTargetId = this.getCdpTargetId(task, shortId);
    const target = await this.getTarget(conn, cdpTargetId);
    if (!target) throw new Error(`Tab ${shortId} not found`);

    const sessionId = await this.getSessionId(conn, target.targetId);

    // No explicit --path: fall back to the profile's downloads dir, the same
    // destination already set browser-global at connect (applyDefaultDownloadBehavior).
    const resolvedPath = downloadPath ?? getProfileDownloadsDir(runtimeKey);
    await fs.promises.mkdir(resolvedPath, { recursive: true });

    await conn.cdp.send(
      'Browser.setDownloadBehavior',
      {
        behavior: 'allow',
        downloadPath: resolvedPath,
        eventsEnabled: true,
      },
      sessionId
    );

    this.pendingDownloads.set(taskId, { path: resolvedPath, completed: false });

    conn.cdp.on('Browser.downloadProgress', (params: any) => {
      if (params.state === 'completed') {
        const dl = this.pendingDownloads.get(taskId);
        if (dl) {
          dl.completed = true;
          dl.filename = params.suggestedFilename;
        }
      }
    });

    return resolvedPath;
  }

  async waitForDownload(taskId: string, timeout: number = 60000): Promise<string> {
    const { conn } = await this.findTask(taskId);
    requireCdp(conn, 'download');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const dl = this.pendingDownloads.get(taskId);
      if (dl?.completed) {
        const fullPath = dl.filename ? `${dl.path}/${dl.filename}` : dl.path;
        this.pendingDownloads.delete(taskId);
        return fullPath;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Download not completed within ${timeout}ms`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private findTaskBySession(conn: ProfileConnection, sessionId: string): string | undefined {
    for (const [taskId, task] of conn.tasks) {
      for (const tabId of Object.values(task.tabs)) {
        if (conn.sessionCache.get(tabId) === sessionId) {
          return taskId;
        }
      }
    }
    return undefined;
  }

  async shutdown(): Promise<void> {
    // Drain any in-flight recordings first so we don't orphan ffmpeg processes
    // or leak the duration/size-check timers when the daemon goes down.
    for (const [taskId, rec] of this.recordings) {
      clearTimeout(rec.durationTimer);
      clearInterval(rec.sizeCheckInterval);
      try { rec.conn.cdp.off('Page.screencastFrame', rec.frameHandler); } catch { /* socket may be gone */ }
      clearInterval(rec.framePump);
      try { rec.ffmpeg.stdin?.end(); } catch { /* already closed */ }
      // Give ffmpeg up to 1s to flush; then SIGKILL.
      const exited = await new Promise<boolean>((resolve) => {
        let done = false;
        rec.ffmpeg.once('exit', () => { done = true; resolve(true); });
        setTimeout(() => { if (!done) resolve(false); }, 1000);
      });
      if (!exited) {
        try { rec.ffmpeg.kill('SIGKILL'); } catch { /* already dead */ }
      }
      this.recordings.delete(taskId);
    }

    for (const [, conn] of this.connections) {
      if (conn.backend !== 'arc-native') conn.cdp.close();
      conn.cleanup?.();
    }
    this.connections.clear();
  }

  private findAvailableFork(
    baseKey: ConnectionKey
  ): { name: ConnectionKey; conn: ProfileConnection } | null {
    for (const [name, conn] of this.connections) {
      if (conn.forkedFrom === baseKey && conn.tasks.size === 0) {
        return { name, conn };
      }
    }
    return null;
  }

  private async forkElectronProfile(
    profile: BrowserProfile,
    baseKey: ConnectionKey,
  ): Promise<{ forkName: ConnectionKey; connection: ProfileConnection }> {
    let forkNum = 2;
    while (this.connections.has(asConnectionKey(`${baseKey}.${forkNum}`))) {
      forkNum++;
    }
    const forkName = asConnectionKey(`${baseKey}.${forkNum}`);

    const port = allocatePort();
    const chromeOpts = { ...profile.chrome, viewport: profile.viewport };
    const { pid, wsUrl } = await launchBrowser(
      forkName,
      profile.browser,
      port,
      chromeOpts,
      profile.secrets,
      profile.binary,
      profile.electron === true
    );

    const cdp = new CDPClient();
    await cdp.connect(wsUrl);
    await this.enableDomains(cdp);

    const connection: ProfileConnection = {
      backend: 'cdp',
      cdp,
      port,
      pid,
      electron: true,
      browserType: profile.browser,
      targetFilter: profile.targetFilter,
      key: forkName,
      profile: profile.name,
      forkedFrom: baseKey,
      tasks: new Map(),
      sessionCache: new Map(),
    };
    this.connections.set(forkName, connection);
    await this.applyDefaultDownloadBehavior(connection, forkName);

    return { forkName, connection };
  }

  /**
   * Connect to a profile at a specific endpoint preset. The caller has
   * already resolved the endpoint and built the `effectiveProfile` with
   * the per-endpoint binary/targetFilter overrides applied; we just use it.
   *
   * `key` is the runtime key (`<profile>@<device>`) and is what every on-disk
   * lookup uses. It is a SEPARATE argument because `effectiveProfile.name`
   * stays the bare, user-facing name (RUSH-2709).
   */
  private async connectProfile(
    effectiveProfile: BrowserProfile,
    target: string,
    key: ConnectionKey,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection> {
    const existingInfo = getRunningChromeInfo(key);
    const tunnelled = opts.persistRemote || target.startsWith('ssh:');

    if (tunnelled) {
      // A leftover local chrome-data / pid file under this key is the
      // pre-T2 logged-out browser on THIS box. Attaching localhost CDP
      // here is the original bug. Only a recorded SSH tunnel is ours to
      // reuse, and connectSSH already does that via isOwnTunnel.
      const meta = readProfileRuntimeMeta(key);
      if (meta && meta.kind !== 'tunnel') {
        clearProfileRuntime(key);
      }
    } else if (existingInfo) {
      try {
        const { wsUrl, browser } = await discoverBrowserWsUrl(
          existingInfo.port,
          'localhost',
          effectiveProfile.name
        );
        verifyBrowserIdentity(browser, effectiveProfile.browser, existingInfo.port);
        const cdp = new CDPClient();
        await cdp.connect(wsUrl);
        await this.enableDomains(cdp);

        const tasks = this.loadTaskState(key);

        return {
          backend: 'cdp',
          cdp,
          port: existingInfo.port,
          pid: existingInfo.pid,
          electron: effectiveProfile.electron,
          browserType: effectiveProfile.browser,
          targetFilter: effectiveProfile.targetFilter,
          tasks,
          sessionCache: new Map(),
        };
      } catch (err) {
        // pid file says a process is alive on that port, but nothing is
        // actually responding to CDP — most commonly because the user
        // changed the configured endpoint port after a previous launch,
        // or because the OS reused the pid for an unrelated process.
        // Wipe the stale runtime files and fall through to a fresh
        // connect against the profile's currently-configured endpoint.
        clearProfileRuntime(key);
      }
    }

    const conn = await this.connectEndpoint(effectiveProfile, target, key, opts);
    if (!conn) {
      throw new Error(`Could not connect to endpoint ${target} for profile "${effectiveProfile.name}"`);
    }
    return conn;
  }

  private async connectEndpoint(
    profile: BrowserProfile,
    endpoint: string,
    key: ConnectionKey,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection | null> {
    const url = new URL(endpoint);

    if (url.protocol === 'cdp:') {
      const conn = await connectLocal(endpoint, profile, key);
      await this.enableDomains(conn.cdp);
      return {
        backend: 'cdp',
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: conn.pid === 0 ? this.loadTaskState(key) : new Map(),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'ssh:') {
      const conn = await connectSSH(endpoint, profile, key, {
        persistRemote: opts.persistRemote,
      });
      await this.enableDomains(conn.cdp);
      return {
        backend: 'cdp',
        cdp: conn.cdp,
        port: conn.port,
        pid: conn.pid,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: new Map(),
        sessionCache: new Map(),
        cleanup: conn.cleanup,
      };
    }

    if (url.protocol === 'wss:' || url.protocol === 'ws:') {
      const port = parseInt(url.port || (url.protocol === 'wss:' ? '443' : '80'), 10);
      const cdp = new CDPClient();
      try {
        await cdp.connect(endpoint);
      } catch {
        throw new BrowserCdpConnectionError(port, profile.name, url.hostname || 'localhost');
      }
      await this.enableDomains(cdp);
      return {
        backend: 'cdp',
        cdp,
        port: 0,
        pid: 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
      };
    }

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const port = parseInt(url.port || (url.protocol === 'https:' ? '443' : '80'), 10);
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, url.hostname, profile.name);
      verifyBrowserIdentity(browser, profile.browser, port, url.hostname);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);
      return {
        backend: 'cdp',
        cdp,
        port,
        pid: 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
      };
    }

    // Native Arc backend (PHNX-2399): `arc-native:` protocol connects through
    // Apple Events instead of CDP. No debugging port, no browser launch.
    if (url.protocol === 'arc-native:') {
      if (process.platform !== 'darwin') {
        throw new Error('Native Arc automation is only available on macOS');
      }
      if (!(await isArcRunning())) {
        throw new Error(
          'Arc is not running. Start Arc normally, then retry.\n' +
            'Native Arc automation drives your existing browser — it does not launch one.',
        );
      }

      if (!profile.arc) {
        throw new Error(
          `Native Arc profile "${profile.name}" has no stable native profile metadata. ` +
            `Re-select it with: agents browser use arc-<profile-id>`,
        );
      }

      return {
        port: 0,
        pid: 0,
        electron: false,
        browserType: 'arc',
        targetFilter: profile.targetFilter,
        tasks: this.loadTaskState(key),
        sessionCache: new Map(),
        backend: 'arc-native',
        arcProfile: profile.arc,
      };
    }

    return null;
  }

  private async enableDomains(cdp: CDPClient): Promise<void> {
    await cdp.send('Target.setDiscoverTargets', { discover: true });
  }

  /**
   * The single path that opens a new CDP page/window target. It exists so the
   * Arc guard lives in exactly one place: `Target.createTarget` crashes Arc
   * (verified, PR #2778), so an Arc connection throws a clear, actionable error
   * here instead of every call site re-checking. Every drivable Chromium-family
   * browser goes straight through.
   */
  private async createPageTarget(
    conn: ProfileConnection,
    params: { url: string; newWindow?: boolean },
  ): Promise<{ targetId: string }> {
    if (conn.browserType === 'arc') {
      throw arcNotDrivableError(conn.profile);
    }
    return (await conn.cdp.send('Target.createTarget', params)) as { targetId: string };
  }

  private async getOrCreateWindow(conn: CdpProfileConnection): Promise<string> {
    // Already have a window for this profile?
    if (conn.windowId) {
      // Verify it still exists via CDP
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
      };
      if (targetInfos.some((t) => t.targetId === conn.windowId && t.type === 'page')) {
        return conn.windowId;
      }
      // Window was closed, fall through to find/create new
    }

    // Check if browser already has a page target we can use
    const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; type: string; url: string; title?: string }>;
    };
    const existing = pickWindowTarget(targetInfos, conn.targetFilter);
    if (existing) {
      conn.windowId = existing.targetId;
      return existing.targetId;
    }

    // If we have an explicit filter, `pickWindowTarget` returns undefined when nothing
    // matches. That almost always means the profile is misconfigured (typo in the
    // filter, target hasn't loaded yet, app version moved the URL). Falling through
    // to `Target.createTarget` would silently create an orphan tab the user can't see.
    // Surface the failure instead, with the candidate list so the fix is obvious.
    if (parseTargetFilter(conn.targetFilter)) {
      const candidates = targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => `  - url=${t.url ?? ''} title=${t.title ?? ''}`)
        .join('\n');
      throw new Error(
        `Target filter ${JSON.stringify(conn.targetFilter)} matched no page target.\n` +
          `Available page targets:\n${candidates || '  (none)'}`
      );
    }

    // First ever use - create window
    const result = await this.createPageTarget(conn, {
      url: 'about:blank',
      newWindow: true,
    });
    conn.windowId = result.targetId;
    return result.targetId;
  }

  private hasTaskNamed(name: string): boolean {
    for (const conn of this.connections.values()) {
      if (this.lookupTaskOnConn(conn, name)) return true;
    }
    return false;
  }

  /** The (connection, task) a handle names anywhere, or undefined. */
  private findTaskByHandle(handle: string): { conn: ProfileConnection; task: Task } | undefined {
    for (const conn of this.connections.values()) {
      const task = this.lookupTaskOnConn(conn, handle);
      if (task) return { conn, task };
    }
    return undefined;
  }

  /**
   * Same-name `start --task <name>` retry (PHNX-2399). When a task by that name
   * already exists this REUSES it — reopening the URL in the same tab (same id,
   * a real reload, the `Tab already open—refreshed` note) — but only after
   * proving it is genuinely the same task: same bare profile, same endpoint, and
   * a matching caller identity. A mismatch on any of those is a real conflict and
   * throws, so a different caller/profile/endpoint can never silently acquire
   * another task. Serialized by the `namedstart:` lock in {@link start}.
   */
  private async retryNamedStart(
    existing: { conn: ProfileConnection; task: Task },
    profileName: string,
    routed: { key: ConnectionKey; device: string; picked?: string },
    opts: StartOptions,
  ): Promise<StartResult> {
    const { conn, task } = existing;
    const existingKey = conn.key ?? task.profile;

    // Profile + endpoint must match what this retry asked for.
    if (!keyBelongsToProfile(existingKey, profileName)) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists on profile "${parseConnectionKey(existingKey).profile}", not "${profileName}".`,
          `Next: stop it first (agents browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }
    const wantEndpoint = parseConnectionKey(routed.key).endpoint;
    const haveEndpoint = parseConnectionKey(existingKey).endpoint;
    if (opts.endpointName && wantEndpoint !== haveEndpoint) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists on endpoint "${haveEndpoint}", not "${wantEndpoint}".`,
          `Next: stop it first (agents browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }

    // Caller identity must match. Both identity-less (a human shell) is fine;
    // otherwise the SAME session/launch must own it — never another caller's.
    const caller = { sessionId: opts.sessionId, launchId: opts.launchId };
    const bothAnon = !task.sessionId && !task.launchId && !caller.sessionId && !caller.launchId;
    if (!bothAnon && !taskMatchesCaller(task, caller)) {
      throw new Error(
        actionable(
          `Task "${opts.taskName}" already exists and belongs to a different caller.`,
          `Next: stop it first (agents browser done --task ${task.name}) or pick a different --task name.`,
        ),
      );
    }

    // Genuine same-task retry. When a URL is given, run the real navigate — which
    // reopens the same owned tab (refreshed) OR reuses the current tab for a
    // different URL (created:false, refreshed:false) — and carry its ACTUAL
    // result. With NO URL there is NO page operation: no reload, no counter
    // change; it is a pure task reuse (created/refreshed both false).
    let firstOpen: PageOpenResult;
    if (opts.url) {
      const nav = await this.navigate(task.name, opts.url, existingKey);
      firstOpen = { tabId: nav.tabId, created: nav.created, refreshed: nav.refreshed, message: nav.message };
    } else {
      firstOpen = { tabId: task.currentTabId, created: false, refreshed: false };
    }

    let skill: ResolvedDomainSkill | undefined;
    if (opts.url && !opts.skipDomainSkill) {
      const resolved = resolveDomainSkill(opts.url);
      if (resolved) skill = resolved;
    }

    return {
      task: task.id,
      name: task.name,
      tabId: firstOpen.tabId,
      profile: profileName,
      key: existingKey,
      device: routed.device,
      picked: routed.picked,
      skill,
      reused: true,
      firstOpen,
    };
  }

  /** Map key for a task on a connection (tasks are keyed by `name`). */
  private taskMapKey(conn: ProfileConnection, task: Task): string | undefined {
    for (const [key, t] of conn.tasks) {
      if (t === task || t.id === task.id || t.name === task.name) return key;
    }
    return undefined;
  }

  /** Find a task by map key, id, or name on one connection. */
  private lookupTaskOnConn(conn: ProfileConnection, handle: string): Task | undefined {
    const direct = conn.tasks.get(handle);
    if (direct) return direct;
    for (const task of conn.tasks.values()) {
      if (task.id === handle || task.name === handle) return task;
    }
    return undefined;
  }

  private maybeUpdateLabelFromUrl(conn: ProfileConnection, task: Task, url: string): void {
    if (task.label && task.label !== 'untitled') return;
    const next = deriveTaskLabel({ url, existing: task.label });
    if (next === task.label) return;
    task.label = next;
    void this.saveTaskState(task.profile, conn.tasks).catch(() => { /* best-effort */ });
  }

  /**
   * Resolve a task for a page/close verb.
   *
   *   - explicit `task` handle → look up (with disk rehydrate on RAM miss)
   *   - no handle, exactly one live task for this caller → use it
   *   - no handle, multiple for this caller → error listing them + `--task`
   *   - no handle, zero for this caller, createIfMissing → start a new task
   *   - no handle, zero, !createIfMissing → return null (caller reports "nothing to close")
   */
  async resolveOrCreateTask(opts: {
    /** Whether the CALLER was dispatched here by a fleet `--device` hop. */
    fleetRemote?: boolean;
    task?: string;
    profile?: string;
    actor?: string;
    launchId?: string;
    sessionId?: string;
    createIfMissing: boolean;
    title?: string;
    url?: string;
  }): Promise<{
    conn: ProfileConnection;
    task: Task;
    key: ConnectionKey;
    created: boolean;
    picked?: string;
    device?: string;
    /**
     * When this call CREATED the task by starting a browser on `opts.url`, the
     * page operation `start` already performed on that URL. The owning IPC
     * handler reports it truthfully (adopt → created:false, Arc reuse →
     * created:false, fresh tab → created:true) instead of re-running the
     * navigate/tab-add (a duplicate execution) and assuming a create (PHNX-2399).
     */
    firstOpen?: PageOpenResult;
  } | null> {
    // Consent gate — the one chokepoint every drive/mutate verb passes through.
    // ipc.ts routes each PAGE_RESOLVE_VERB and CLOSE_VERB here via bindTask, so
    // gating at the top refuses a fleet-remote ATTACH (an explicit --task, or a
    // lone identity match) exactly as it already refused an implicit CREATE.
    // Gating only the create branch below left tab-add/navigate/done on an
    // already-running browser ungated, so a remote caller could drive the
    // owner's authenticated profile with consent off (RUSH-3064). Read the
    // per-request marker, never the daemon's env — see remote-control.ts.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });

    if (opts.task) {
      const found = await this.findTask(opts.task, opts.profile);
      return { ...found, created: false };
    }

    // Serialize identity resolution + implicit creation per caller so two
    // concurrent first-use requests (e.g. two `navigate <url>` with no --task)
    // don't both see zero matches and both start a task. The `create:` namespace
    // is disjoint from the `task:` locks `navigate`/`tabAdd` take, so the nested
    // `start → navigate` (Arc/Electron) can never wait on a lock this frame holds
    // (PHNX-2399). Distinct profiles create distinct tasks, so profile is in the
    // key; identity-less human shells share one `anon` lane.
    const createKey = `create:${opts.sessionId ?? opts.launchId ?? 'anon'}:${opts.profile ?? 'default'}`;
    return this.runExclusive(createKey, () => this.resolveOrCreateByIdentity(opts));
  }

  private async resolveOrCreateByIdentity(opts: {
    fleetRemote?: boolean;
    profile?: string;
    actor?: string;
    launchId?: string;
    sessionId?: string;
    createIfMissing: boolean;
    title?: string;
    url?: string;
  }): Promise<{
    conn: ProfileConnection;
    task: Task;
    key: ConnectionKey;
    created: boolean;
    picked?: string;
    device?: string;
    firstOpen?: PageOpenResult;
  } | null> {
    // After a daemon restart the connections map is empty while tasks.json still
    // holds live tasks. Rehydrate before identity matching so done/screenshot
    // without --task still find the caller's task.
    await this.rehydrateAllFromDisk();

    const caller = {
      sessionId: opts.sessionId,
      launchId: opts.launchId,
    };
    const matches = this.listTasksForCaller(caller);

    if (matches.length === 1) {
      const m = matches[0]!;
      await this.prepareTask(m.conn, m.task);
      await this.touchTask(m.conn, m.task);
      return { conn: m.conn, task: m.task, key: m.key, created: false };
    }

    if (matches.length > 1) {
      const lines = matches.map((m) => {
        const ageMs = Date.now() - m.task.createdAt;
        const age =
          ageMs < 60_000
            ? `${Math.round(ageMs / 1000)}s`
            : `${Math.round(ageMs / 60_000)}m`;
        const label = m.task.label ?? m.task.name;
        const url = this.currentUrlHint(m.conn, m.task) ?? '-';
        return `  ${label}  id=${m.task.name}  url=${url}  age=${age}`;
      });
      throw new Error(
        actionable(
          `Multiple browser tasks for this session — pass --task <name>:`,
          ...lines,
          `Next: agents browser status`,
        ),
      );
    }

    // Zero matches for this caller.
    if (!opts.createIfMissing) return null;

    // The top-of-function consent gate already refused a fleet-remote create
    // here — before ensureDefaultBrowserProfile() below resolves a default — so
    // a refused request never touches the target machine. Since PHNX-3296 that
    // resolver never mints a profile: with no launchable default it throws, and
    // the throw surfaces to the caller exactly like any other start failure.

    // Implicit start on the default / named profile.
    let profileName = opts.profile;
    if (!profileName) {
      const { ensureDefaultBrowserProfile } = await import('./profiles.js');
      const detected = await ensureDefaultBrowserProfile();
      profileName = detected.name;
    }
    const started = await this.start(profileName, {
      fleetRemote: opts.fleetRemote,
      url: opts.url,
      actor: opts.actor,
      launchId: opts.launchId,
      sessionId: opts.sessionId,
      title: opts.title,
    });
    return {
      ...(await this.findTask(started.name, started.profile)),
      created: true,
      picked: started.picked,
      device: started.device,
      // `start` already opened opts.url on this tab; the handler must not open
      // it a second time (a duplicate tab for tab-add; a redundant reload for
      // navigate). Carry the ACTUAL page result so created/refreshed are truthful.
      firstOpen: started.firstOpen,
    };
  }

  private listTasksForCaller(caller: {
    sessionId?: string;
    launchId?: string;
  }): Array<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> {
    const out: Array<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> = [];
    const hasIdentity = !!(caller.sessionId || caller.launchId);

    for (const [key, conn] of this.connections) {
      for (const task of conn.tasks.values()) {
        if (hasIdentity) {
          if (taskMatchesCaller(task, caller)) {
            out.push({ conn, task, key: conn.key ?? key });
          }
        } else {
          // No caller identity: only match tasks that also lack identity
          // (a human-driven shell). If there is exactly one live task total,
          // the single-task path still needs that listed — fall through below.
          if (!task.sessionId && !task.launchId) {
            out.push({ conn, task, key: conn.key ?? key });
          }
        }
      }
    }

    // No-identity caller with zero unscoped matches: if the daemon holds
    // exactly one live task that ALSO has no identity (a human-started one),
    // use it. Never steal a task stamped with another caller's session/launch.
    if (!hasIdentity && out.length === 0) {
      const unowned = this.listTasks().filter((t) => !t.task.sessionId && !t.task.launchId);
      if (unowned.length === 1) {
        const only = unowned[0]!;
        const conn = this.connections.get(only.profile) ??
          [...this.connections.entries()].find(([, c]) =>
            c.tasks.has(only.task.name) || [...c.tasks.values()].includes(only.task),
          )?.[1];
        if (conn) {
          out.push({ conn, task: only.task, key: only.profile });
        }
      }
    }

    return out;
  }

  private currentUrlHint(conn: ProfileConnection, task: Task): string | undefined {
    const shortId = task.currentTabId;
    if (!shortId) return undefined;
    const cdpId = task.tabs[shortId];
    if (!cdpId) return undefined;
    const cached = conn.targetCache?.targets.find((t) => t.targetId === cdpId);
    return cached?.url;
  }

  /**
   * Mark a task as active, so the reaper's idle window measures time since the
   * last real use rather than time since `start` (RUSH-2622).
   *
   * Called from `findTask` — the single funnel every task-scoped operation
   * resolves through — rather than from each of the ~26 call sites, so a new
   * action added later cannot forget to stamp it.
   *
   * The in-memory stamp is what the reaper reads: it runs inside the same
   * daemon that owns these `Task` objects. The write to tasks.json exists only
   * so a daemon RESTART does not inherit a stale stamp and reap a task an agent
   * has been clicking through for the last half hour — `click`, `type`,
   * `evaluate`, and `screenshot` never call `saveTaskState` on their own, so
   * without this the on-disk stamp would sit at the last navigation. It is
   * coalesced to at most one write per profile per minute so a screenshot loop
   * does not become a write loop; the resulting on-disk stamp trails by at most
   * a minute, well inside the 30-minute idle window.
   */
  private async touchTask(conn: ProfileConnection, task: Task): Promise<void> {
    const now = Date.now();
    task.lastActionAt = now;

    const last = this.lastTouchPersist.get(task.profile) ?? 0;
    if (now - last < BrowserService.TOUCH_PERSIST_INTERVAL_MS) return;
    this.lastTouchPersist.set(task.profile, now);
    try {
      await this.saveTaskState(task.profile, conn.tasks);
    } catch {
      // Durability here is best-effort — the in-memory stamp above is
      // authoritative for the running daemon — and an unwritable runtime dir
      // must not turn a working browser action into a failure. Same guard the
      // `recordBrowserSession` call in `start` uses for the same reason.
    }
  }

  private async prepareTask(conn: ProfileConnection, task: Task): Promise<void> {
    if (conn.backend !== 'arc-native') return;
    await this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const native = this.requireArcTask(task);
      if (native.profileId !== conn.arcProfile.profileId) {
        throw new Error(
          `Arc task profile ${JSON.stringify(native.profileId)} does not match connected profile ` +
            `${JSON.stringify(conn.arcProfile.profileId)}.`,
        );
      }
    });
  }

  private async findTask(
    taskId: string,
    profileRef?: ProfileName | ConnectionKey,
  ): Promise<{ conn: ProfileConnection; task: Task; key: ConnectionKey }> {
    if (profileRef) {
      // Accept bare profile names against composite connection keys.
      // One rule: an exact runtime key, else every key belonging to that bare
      // profile. Callers pass whichever they hold — the composite is theirs to
      // ignore (RUSH-2709).
      const keys = [...this.connections.keys()].filter(
        (k) => k === profileRef || keyBelongsToProfile(k, profileRef),
      );
      for (const key of keys) {
        const conn = this.connections.get(key)!;
        const task = this.lookupTaskOnConn(conn, taskId);
        if (task) {
          await this.prepareTask(conn, task);
          await this.touchTask(conn, task);
          return { conn, task, key: conn.key ?? key };
        }
      }
      // RAM miss → rehydrate from disk for this profile.
      const rehydrated = await this.rehydrateTaskFromDisk(taskId, profileRef);
      if (rehydrated) {
        await this.prepareTask(rehydrated.conn, rehydrated.task);
        await this.touchTask(rehydrated.conn, rehydrated.task);
        return rehydrated;
      }
      throw new Error(
        actionable(
          `Task "${taskId}" not found on profile "${profileRef}".`,
          `Next: agents browser status --profile ${parseConnectionKey(profileRef).profile}`,
        ),
      );
    }

    for (const [key, conn] of this.connections) {
      const task = this.lookupTaskOnConn(conn, taskId);
      if (task) {
        await this.prepareTask(conn, task);
        await this.touchTask(conn, task);
        return { conn, task, key: conn.key ?? key };
      }
    }

    // RAM miss after a daemon restart: tasks.json still has the task and
    // meta.json still has the browser pid/port. Reconnect and adopt.
    const rehydrated = await this.rehydrateTaskFromDisk(taskId);
    if (rehydrated) {
      await this.prepareTask(rehydrated.conn, rehydrated.task);
      await this.touchTask(rehydrated.conn, rehydrated.task);
      return rehydrated;
    }

    const live = this.listTasks()
      .map(({ task }) => task.label ?? task.name)
      .join(', ');
    throw new Error(
      actionable(
        `Task "${taskId}" not found.`,
        `Active tasks: ${live || 'none'}`,
        `It may have been closed by the idle reaper (30 min).`,
        `Next: agents browser status  |  agents browser navigate <url>`,
      ),
    );
  }

  /**
   * Soft-attach to an already-running browser for a runtime dir.
   *
   * Never launches a browser and never clears pid/port files on failure —
   * `connectProfile` does both, which made `status()` wipe disk state when
   * CDP was unreachable (CI / post-reaper) and then return an empty list.
   * Returns null when nothing is speaking CDP so callers can fall through
   * to disk reconcile.
   */
  private async attachRunningProfile(
    key: ConnectionKey,
    diskTasks: Map<string, Task>,
  ): Promise<ProfileConnection | null> {
    const { profile: bare, endpoint: endpointFromKey } = parseConnectionKey(key);
    const profile = await getProfile(bare);
    if (!profile) return null;

    let resolved;
    try {
      // Legacy keys encode the preset (`endpoint-0`). New keys encode the
      // declaring device, which is not a preset name — resolve via registry.
      if (endpointFromKey && /^endpoint-\d+$/.test(endpointFromKey)) {
        resolved = resolveEndpoint(profile, endpointFromKey);
      } else {
        const routed = resolveBrowserTarget(bare);
        resolved = { name: routed.device, target: routed.target };
      }
    } catch {
      return null;
    }

    // Native Arc endpoints (PHNX-2399): reconnect via the native driver if Arc
    // is still running. No port, no CDP — just verify Arc is alive and restore
    // the task state.
    if (resolved.target.startsWith('arc-native:')) {
      if (process.platform !== 'darwin' || !(await isArcRunning())) return null;
      const tasks = this.loadTaskState(key);
      for (const [k, t] of diskTasks) {
        if (!tasks.has(k)) tasks.set(k, t);
      }
      if (!profile.arc) return null;
      return {
        port: 0,
        pid: 0,
        electron: false,
        browserType: 'arc',
        targetFilter: profile.targetFilter,
        key,
        profile: bare,
        tasks,
        sessionCache: new Map(),
        backend: 'arc-native',
        arcProfile: profile.arc,
      };
    }

    const existingInfo = getRunningChromeInfo(key);
    const parsed = parseEndpointUrl(resolved.target);
    const port = existingInfo?.port ?? parsed?.port;
    if (port === undefined) return null;
    const host = parsed?.host && parsed.host !== 'localhost' ? parsed.host : 'localhost';

    // ssh:// endpoints: a daemon restart killed this box's tunnel, but the
    // browser is still running on the FAR side — so the caller's tasks are
    // valid, only the local hop is gone. Re-establish the tunnel and reconnect
    // CDP (connectSSH attaches to the already-running remote browser via
    // isOwnTunnel — it never launches one, so this stays a soft-attach), then
    // merge the disk tasks. Without this, a remote agent driving a browser host
    // after a restart got "Unknown browser task" for a tab that was still alive
    // (PHNX-2663). A failure returns null exactly like the local-CDP path, so
    // the caller falls through to disk reconcile rather than crashing.
    if (resolved.target.startsWith('ssh:')) {
      try {
        const conn = await connectSSH(resolved.target, profile, key, { persistRemote: true });
        await this.enableDomains(conn.cdp);
        const tasks = this.loadTaskState(key);
        for (const [k, t] of diskTasks) {
          if (!tasks.has(k)) tasks.set(k, t);
        }
        return {
          backend: 'cdp',
          cdp: conn.cdp,
          port: conn.port,
          pid: conn.pid,
          electron: profile.electron,
          browserType: profile.browser,
          targetFilter: resolved.targetFilter ?? profile.targetFilter,
          key,
          profile: bare,
          tasks,
          sessionCache: new Map(),
          // Carry the tunnel teardown so removing this connection kills the
          // ssh hop — otherwise it leaks across the next restart (see the
          // `cleanup` docblock on ProfileConnection).
          cleanup: conn.cleanup,
        };
      } catch {
        return null;
      }
    }

    try {
      const { wsUrl, browser } = await discoverBrowserWsUrl(port, host, bare);
      verifyBrowserIdentity(browser, profile.browser, port, host);
      const cdp = new CDPClient();
      await cdp.connect(wsUrl);
      await this.enableDomains(cdp);

      const tasks = this.loadTaskState(key);
      for (const [k, t] of diskTasks) {
        if (!tasks.has(k)) tasks.set(k, t);
      }

      const conn: ProfileConnection = {
        backend: 'cdp',
        cdp,
        port,
        pid: existingInfo?.pid ?? 0,
        electron: profile.electron,
        browserType: profile.browser,
        targetFilter: resolved.targetFilter ?? profile.targetFilter,
        key,
        profile: bare,
        tasks,
        sessionCache: new Map(),
      };
      return conn;
    } catch {
      return null;
    }
  }

  /**
   * Reconnect every profile runtime dir that still has a live browser and
   * tasks.json entries. Used before identity-based resolution so a daemon
   * restart does not make the caller's tasks invisible.
   */
  /**
   * Register a freshly-rehydrated connection, unless a concurrent rehydrate won
   * the race and already registered one for this key. `attachRunningProfile`
   * awaits an ssh-tunnel spawn / CDP connect, so two commands landing right
   * after a daemon restart can each build a connection for the same key; the
   * loser must be released instead of silently overwriting the winner (whose
   * `cleanup` would then never run).
   *
   * The subtlety is the SSH tunnel: when the loser's `connectSSH` landed after
   * the winner's tunnel had already bound the local port, `isOwnTunnel` makes it
   * **reuse** that same OS process (`drivers/ssh.ts`) — so both connections carry
   * the same `pid`/`port`. Calling the loser's `cleanup()` then does
   * `tunnel.kill()` on the SHARED process and breaks the winner's live CDP. So
   * when the loser shares the winner's tunnel we close ONLY the loser's own CDP
   * socket and leave the tunnel to the winner; only a loser that spawned its own
   * distinct tunnel gets the full `cleanup()` (else it would leak). Returns the
   * winning connection to use.
   */
  private registerRehydratedConnection(
    key: ConnectionKey,
    conn: ProfileConnection,
  ): ProfileConnection {
    const existing = this.connections.get(key);
    if (!existing) {
      this.connections.set(key, conn);
      return conn;
    }
    const sharesTunnel =
      conn.pid !== 0 && conn.pid === existing.pid && conn.port === existing.port;
    if (conn.pid !== 0 && !sharesTunnel && conn.cleanup) {
      // Distinct tunnel — full teardown so this loser's tunnel doesn't leak.
      try { conn.cleanup(); } catch { /* best effort — the winner stays live */ }
    } else {
      // Shared/borrowed tunnel (or a local connection with no tunnel): close
      // only our own CDP client; killing the tunnel would break the winner.
      if (conn.backend !== 'arc-native') {
        try { conn.cdp.close(); } catch { /* best effort */ }
      }
    }
    return existing;
  }

  private async rehydrateAllFromDisk(): Promise<void> {
    const runtimeRoot = getBrowserRuntimeDir();
    let dirNames: string[] = [];
    try {
      dirNames = fs.readdirSync(runtimeRoot).filter((d) => {
        try {
          return fs.statSync(path.join(runtimeRoot, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return;
    }

    for (const dirName of dirNames) {
      // A runtime dir name IS a connection key — that is what wrote it.
      const key = asConnectionKey(dirName);
      if (this.connections.has(key)) continue;
      // Skip non-runtime dirs (e.g. profiles/)
      if (dirName === 'profiles' || dirName === 'sessions' || dirName === 'exports') continue;
      const tasks = this.loadTaskState(key);
      if (tasks.size === 0) continue;
      // Soft attach only — never launch / never clear pid files.
      const conn = await this.attachRunningProfile(key, tasks);
      if (!conn) continue;
      // A concurrent rehydrate may have registered one for this key while we
      // awaited the attach; keep the winner and tear our loser's tunnel down.
      const registered = this.registerRehydratedConnection(key, conn);
      if (registered !== conn) continue;
      try {
        if (conn.backend !== 'arc-native') await this.applyDefaultDownloadBehavior(conn, key);
      } catch {
        // Non-fatal for rehydrate.
      }
    }
  }

  /**
   * On a RAM miss, scan profile runtime dirs for a tasks.json entry matching
   * `taskId`, soft-attach when CDP is still up, and register the connection.
   * Does not launch browsers or clear runtime files.
   */
  private async rehydrateTaskFromDisk(
    taskId: string,
    profileHint?: ProfileName | ConnectionKey,
  ): Promise<{ conn: ProfileConnection; task: Task; key: ConnectionKey } | null> {
    const runtimeRoot = getBrowserRuntimeDir();
    let dirNames: string[] = [];
    try {
      dirNames = fs.readdirSync(runtimeRoot).filter((d) => {
        try {
          return fs.statSync(path.join(runtimeRoot, d)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }

    if (profileHint) {
      dirNames = dirNames.filter(
        (d) => d === profileHint || keyBelongsToProfile(d, profileHint),
      );
    }

    for (const dirName of dirNames) {
      if (dirName === 'profiles' || dirName === 'sessions' || dirName === 'exports') continue;
      const key = asConnectionKey(dirName);
      const tasks = this.loadTaskState(key);
      let found: Task | undefined;
      for (const task of tasks.values()) {
        if (task.id === taskId || task.name === taskId) {
          found = task;
          break;
        }
      }
      // Also allow map-key match
      if (!found) found = tasks.get(taskId);
      if (!found) continue;

      // Already connected under this key?
      let conn = this.connections.get(key);
      if (!conn) {
        const attached = await this.attachRunningProfile(key, tasks);
        if (!attached) {
          // CDP down — cannot rehydrate a live connection; caller will error.
          continue;
        }
        // Keep whichever connection a concurrent rehydrate registered first and
        // tear our loser's tunnel down instead of leaking it (see the helper).
        conn = this.registerRehydratedConnection(key, attached);
        if (conn === attached) {
          try {
            if (conn.backend !== 'arc-native') await this.applyDefaultDownloadBehavior(conn, key);
          } catch {
            // Non-fatal.
          }
        }
      }

      const task = this.lookupTaskOnConn(conn, taskId) ?? found;
      // Ensure the rehydrated task is on the connection map.
      if (!this.lookupTaskOnConn(conn, task.name)) {
        conn.tasks.set(task.name, task);
      }
      return { conn, task, key: conn.key ?? key };
    }
    return null;
  }

  private async getTabsForTask(cdp: CDPClient, task: Task): Promise<TabInfo[]> {
    const targets = (await cdp.send('Target.getTargets')) as {
      targetInfos: Array<{ targetId: string; url: string; title: string }>;
    };

    const tabs: TabInfo[] = [];
    for (const [shortId, cdpId] of Object.entries(task.tabs)) {
      const target = targets.targetInfos.find((t) => t.targetId === cdpId);
      if (target) {
        tabs.push({
          id: shortId,
          url: target.url,
          title: target.title,
          task: task.name,
        });
      }
    }
    return tabs;
  }

  /** Live status for ONE registered connection, addressed by its runtime key. */
  private async getProfileStatus(key: ConnectionKey): Promise<ProfileStatus | null> {
    const conn = this.connections.get(key);
    if (!conn) return null;

    if (conn.backend === 'arc-native') {
      const tasks: TaskStatus[] = [];
      for (const task of conn.tasks.values()) {
        const tabs = await this.listArcTaskTabs(task);
        const domains = tabs.flatMap((tab) => {
          try {
            const domain = new URL(tab.url).hostname.replace(/^www\./, '');
            return domain && domain !== 'blank' ? [domain] : [];
          } catch {
            return [];
          }
        });
        tasks.push({
          id: task.id,
          name: task.name,
          label: task.label ?? task.name,
          tabCount: Object.keys(task.tabs).length,
          currentTabId: task.currentTabId,
          createdAt: task.createdAt,
          tabs: tabs.length ? tabs : undefined,
          domains: [...new Set(domains)],
        });
      }
      const parsed = parseConnectionKey(key);
      return {
        name: conn.profile ?? parsed.profile,
        endpoint: parsed.endpoint,
        key,
        running: await isArcRunning(),
        port: 0,
        pid: 0,
        tasks,
      };
    }

    // Fetch all targets once for efficiency
    let targets: Array<{ targetId: string; url: string; title: string }> = [];
    try {
      const result = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: Array<{ targetId: string; url: string; title: string }>;
      };
      targets = result.targetInfos;
    } catch {
      // CDP not responding, fall back to metadata only
    }

    const tasks: TaskStatus[] = [];
    for (const [, task] of conn.tasks) {
      const tabs: Array<{ id: string; url: string; title?: string; current?: boolean }> = [];
      const domainSet = new Set<string>();

      for (const [shortId, cdpId] of Object.entries(task.tabs)) {
        const target = targets.find((t) => t.targetId === cdpId);
        if (target) {
          tabs.push({
            id: shortId,
            url: target.url,
            title: target.title,
            current: shortId === task.currentTabId,
          });
          try {
            const domain = new URL(target.url).hostname.replace(/^www\./, '');
            if (domain && domain !== 'blank') domainSet.add(domain);
          } catch {
            // invalid URL
          }
        }
      }

      tasks.push({
        id: task.id,
        name: task.name,
        label: task.label ?? task.name,
        tabCount: Object.keys(task.tabs).length,
        currentTabId: task.currentTabId,
        createdAt: task.createdAt,
        tabs: tabs.length > 0 ? tabs : undefined,
        domains: domainSet.size > 0 ? Array.from(domainSet) : undefined,
      });
    }

    const parsed = parseConnectionKey(key);
    const bare = conn.profile ?? parsed.profile;
    const profile = await getProfile(bare);
    const configuredPort = profile ? extractConfiguredPort(profile) : undefined;

    return {
      name: bare,
      endpoint: parsed.endpoint,
      key,
      running: true,
      port: conn.port,
      pid: conn.pid,
      configuredPort: configuredPort !== conn.port ? configuredPort : undefined,
      tasks,
    };
  }

  private async getTarget(
    conn: CdpProfileConnection,
    tabId: string
  ): Promise<TargetInfo | undefined> {
    const now = Date.now();
    if (!conn.targetCache || now - conn.targetCache.ts > 1000) {
      const { targetInfos } = (await conn.cdp.send('Target.getTargets')) as {
        targetInfos: TargetInfo[];
      };
      conn.targetCache = { targets: targetInfos, ts: now };
    }

    return conn.targetCache.targets.find((target) => target.targetId === tabId);
  }

  private async getSessionId(conn: CdpProfileConnection, tabId: string): Promise<string> {
    const cachedSessionId = conn.sessionCache.get(tabId);
    if (cachedSessionId) {
      return cachedSessionId;
    }

    const { sessionId } = (await conn.cdp.send('Target.attachToTarget', {
      targetId: tabId,
      flatten: true,
    })) as { sessionId: string };

    // Inject a stealth shim before any page script runs. Chromium exposes
    // navigator.webdriver = true whenever a remote-debug transport is attached;
    // Cloudflare Turnstile, hCaptcha, and similar bot checks read it first.
    //
    // Only attach-to-running profiles (conn.pid === 0 — Comet / Arc / Brave the
    // user launched themselves) need this. Browsers agents-cli spawns already
    // carry the --disable-blink-features=AutomationControlled launch flag, which
    // makes navigator.webdriver a native Navigator.prototype getter returning
    // false — indistinguishable from an untouched browser. Injecting on top of
    // that is actively harmful: it defines an OWN getter on the instance, and an
    // own `webdriver` descriptor (native lives on the prototype) returning
    // `undefined` (native returns `false`) is itself a tampering signal that
    // bot.sannysoft.com and similar tests flag as "WebDriver present".
    //
    // When we do inject (attach mode), mirror native semantics exactly: define
    // on Navigator.prototype and return false, so no own descriptor leaks and
    // the value matches a real browser. Non-page targets (workers, service
    // workers) reject these calls; swallow the error and keep going.
    if (conn.pid === 0) {
      try {
        await conn.cdp.send('Page.enable', {}, sessionId);
        await conn.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
          source:
            "Object.defineProperty(Navigator.prototype,'webdriver',{get:()=>false,configurable:true});",
        }, sessionId);
      } catch {
        // Target doesn't support Page domain — nothing to inject.
      }
    }

    conn.sessionCache.set(tabId, sessionId);
    return sessionId;
  }

  private invalidateTargetCache(conn: ProfileConnection): void {
    conn.targetCache = undefined;
  }

  private async saveTaskState(key: ConnectionKey, tasks: Map<string, Task>): Promise<void> {
    // tasks.json holds EVERY task on this connection, so two tasks persisting
    // concurrently (the per-task locks are disjoint, and `touchTask`/label writes
    // fire outside any task lock) would interleave writes of the same file and
    // could truncate or corrupt it. Serialize the whole file write per runtime
    // key — a `persist:` namespace disjoint from the `task:`/`create:` locks, so a
    // save issued while holding a task lock never deadlocks (PHNX-2399).
    await this.runExclusive(`persist:${key}`, async () => {
      const runtimeDir = getProfileRuntimeDir(key);
      await fs.promises.mkdir(runtimeDir, { recursive: true });

      const state = Object.fromEntries(tasks);
      // Write to a temp sibling then rename, so a reader never sees a half-written
      // file even if the process dies mid-write (rename is atomic on one fs).
      const target = path.join(runtimeDir, 'tasks.json');
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2));
      await fs.promises.rename(tmp, target);
    });
  }

  private loadTaskState(key: ConnectionKey): Map<string, Task> {
    const runtimeDir = getProfileRuntimeDir(key);
    const tasksFile = path.join(runtimeDir, 'tasks.json');

    if (!fs.existsSync(tasksFile)) {
      return new Map();
    }

    const state = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    const tasks = new Map<string, Task>();
    let needsMigration = false;

    for (const [key, raw] of Object.entries(state)) {
      const task = raw as Record<string, unknown>;
      // Migrate old format (tabIds array) to new format (tabs object)
      if (Array.isArray(task.tabIds) && !task.tabs) {
        needsMigration = true;
        const tabs: Record<string, string> = {};
        for (const cdpId of task.tabIds as string[]) {
          const shortId = generateShortId();
          tabs[shortId] = cdpId;
        }
        const tabIds = Object.keys(tabs);
        tasks.set(key, {
          id: task.id as string,
          name: task.name as string || key,
          profile: asConnectionKey(task.profile as string),
          tabs,
          currentTabId: tabIds.length > 0 ? tabIds[tabIds.length - 1] : undefined,
          createdAt: task.createdAt as number,
          lastActionAt: (task.lastActionAt as number) ?? (task.createdAt as number),
          pid: task.pid as number,
        });
      } else {
        const loaded = task as unknown as Task;
        // Tasks persisted before RUSH-2622 carry no lastActionAt. Normalize on
        // read so every in-memory task has one: its own createdAt is the last
        // moment we can prove the task did anything.
        if (typeof loaded.lastActionAt !== 'number') {
          loaded.lastActionAt = loaded.createdAt;
        }
        tasks.set(key, loaded);
      }
    }

    // Save migrated data back to disk
    if (needsMigration) {
      const migratedState = Object.fromEntries(tasks);
      fs.writeFileSync(tasksFile, JSON.stringify(migratedState, null, 2));
    }

    return tasks;
  }

  private async saveToHistory(task: Task, domains: string[]): Promise<void> {
    const historyDir = getBrowserRuntimeDir();
    await fs.promises.mkdir(historyDir, { recursive: true });
    const historyFile = path.join(historyDir, 'history.json');

    let history: HistoricalTask[] = [];
    if (fs.existsSync(historyFile)) {
      try {
        history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      } catch {
        // Corrupted file, start fresh
      }
    }

    history.unshift({
      id: task.id,
      name: task.name,
      // `task.profile` is the runtime key; history is a user-facing table, so
      // it carries the bare name (RUSH-2709).
      profile: parseConnectionKey(task.profile).profile,
      createdAt: task.createdAt,
      endedAt: Date.now(),
      domains,
      tabCount: Object.keys(task.tabs).length,
      ...(task.owner ? { owner: task.owner } : {}), // carry who launched it (RUSH-2020)
    });

    // Keep only last 50 entries
    history = history.slice(0, 50);
    await fs.promises.writeFile(historyFile, JSON.stringify(history, null, 2));
  }

  /**
   * The cached connection for `key`, or undefined — evicting it first if the
   * browser died underneath us.
   *
   * A browser killed externally (Cmd-Q, crash, a user clearing the profile by
   * hand) leaves a closed WebSocket in the map. Without this the next
   * `cdp.send` throws "CDP connection not open" and there is no recovery short
   * of killing the daemon.
   */
  private async reuseHealthyConnection(key: ConnectionKey): Promise<ProfileConnection | undefined> {
    const conn = this.connections.get(key);
    if (!conn) return undefined;
    if (await isConnHealthy(conn)) return conn;
    if (conn.backend !== 'arc-native') {
      try { conn.cdp.close(); } catch { /* already closed */ }
    }
    conn.cleanup?.();
    this.connections.delete(key);
    return undefined;
  }

  /**
   * Reuse a live connection for this profile: the new `<name>@<device>` key
   * first, then any leftover `<name>@endpoint-N` key still in the map so a
   * browser started before the key collapse is not abandoned.
   */
  private async reuseProfileConnection(
    profileName: ProfileName,
    preferred: ConnectionKey,
    local: boolean,
  ): Promise<{ conn: ProfileConnection; key: ConnectionKey } | undefined> {
    const preferredConn = await this.reuseHealthyConnection(preferred);
    if (preferredConn) return { conn: preferredConn, key: preferred };
    // Leftover `@endpoint-N` connections are THIS machine's pre-T2 local
    // browser. Reusing them on a tunnelled resolve is the original bug.
    if (!local) return undefined;

    for (const key of [...this.connections.keys()]) {
      if (key === preferred) continue;
      if (!isLegacyEndpointKey(key, profileName)) continue;
      if (parseConnectionKey(key).fork !== undefined) continue;
      const conn = await this.reuseHealthyConnection(key);
      if (conn) return { conn, key };
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Native Arc backend helpers (PHNX-2399)
  // ---------------------------------------------------------------------------

  /**
   * Bind a task to the profile's Space in the visible Arc window that holds it.
   * The Space is the profile (PHNX-2399); only its live window id is looked up.
   */
  private async resolveArcSpace(
    profile: ArcNativeProfileIdentity,
  ): Promise<{ windowId: string; spaceId: string; spaceTitle: string }> {
    const live = (await enumerateArcSpaces()).filter((space) => space.spaceId === profile.spaceId);
    if (live.length !== 1) {
      throw new Error(
        live.length === 0
          ? `Arc Space ${JSON.stringify(profile.spaceTitle)} (${profile.spaceId}) is not open in a visible Arc window.`
          : `Arc Space ${JSON.stringify(profile.spaceTitle)} is open in more than one window; refusing an ambiguous native address.`,
      );
    }
    return {
      windowId: live[0].windowId,
      spaceId: live[0].spaceId,
      spaceTitle: profile.spaceTitle,
    };
  }

  private requireArcTask(task: Task): NonNullable<Task['arcNative']> {
    const native = task.arcNative;
    if (!native || typeof native.profileId !== 'string' || typeof native.windowId !== 'string' ||
        typeof native.spaceId !== 'string' || !native.tabs || typeof native.tabs !== 'object') {
      throw new Error(`Task ${JSON.stringify(task.name)} has no valid durable Arc identity.`);
    }
    for (const [shortId, ref] of Object.entries(native.tabs)) {
      if (!ref || typeof ref.windowId !== 'string' || typeof ref.spaceId !== 'string' ||
          typeof ref.tabId !== 'string' || ref.windowId !== native.windowId || ref.spaceId !== native.spaceId) {
        throw new Error(
          `Owned Arc tab ${JSON.stringify(shortId)} has no stable id in its original window/Space.`,
        );
      }
    }
    for (const [shortId, intent] of Object.entries(native.createIntents ?? {})) {
      if (!intent || intent.tabId !== shortId || typeof intent.markerUrl !== 'string' ||
          !isArcCreateMarker(intent.markerUrl) ||
          typeof intent.targetUrl !== 'string' || typeof intent.createdAt !== 'number') {
        throw new Error(`Arc creation intent ${JSON.stringify(shortId)} is invalid; refusing recovery.`);
      }
      if (intent.ref && (intent.ref.windowId !== native.windowId || intent.ref.spaceId !== native.spaceId ||
          typeof intent.ref.tabId !== 'string')) {
        throw new Error(`Arc creation intent ${JSON.stringify(shortId)} left its original window/Space.`);
      }
    }
    return native;
  }

  private async reconcileArcCreateIntents(conn: ArcProfileConnection, task: Task): Promise<void> {
    const native = this.requireArcTask(task);
    for (const intent of Object.values(native.createIntents ?? {})) {
      let ref = intent.ref;
      if (ref) {
        const live = await resolveArcTab(ref);
        if (!live) {
          throw new Error(
            `Owned Arc tab ${intent.tabId} left its original window/Space while creation was incomplete; refusing to adopt it elsewhere.`,
          );
        }
        if (live.url === intent.targetUrl) {
          native.tabs[intent.tabId] = ref;
          task.tabs[intent.tabId] = ref.tabId;
          if (intent.previousTabId) {
            await restoreArcSelection(ref, intent.previousTabId);
          }
          delete native.createIntents?.[intent.tabId];
          await this.saveTaskState(task.profile, conn.tasks);
          continue;
        }
        if (live.url !== intent.markerUrl) {
          throw new Error(`Owned Arc tab ${intent.tabId} changed outside this task during creation; refusing to navigate it.`);
        }
      } else {
        const originalSpace = (await enumerateArcSpaces()).find(
          (space) => space.windowId === native.windowId && space.spaceId === native.spaceId,
        );
        if (!originalSpace) {
          throw new Error('The original Arc window/Space for this task is no longer present.');
        }
        const markerMatches = originalSpace.tabs.filter((tab) => tab.url === intent.markerUrl);
        if (markerMatches.length > 1) {
          throw new Error(`Arc creation marker ${JSON.stringify(intent.markerUrl)} is not unique in the original Space.`);
        }
        if (markerMatches[0]) {
          ref = markerMatches[0];
        } else {
          try {
            ref = await createArcTab({ windowId: native.windowId, spaceId: native.spaceId }, intent.markerUrl);
          } catch (error) {
            // Arc selects the Space it was asked to create in even when the
            // creation itself fails. Put the owner back on their tab before
            // surfacing the error, so a failed agent verb never leaves them
            // staring at the wrong Space.
            if (intent.previousTabId) await selectWindowTab(native.windowId, intent.previousTabId);
            throw error;
          }
        }
        intent.ref = ref;
        native.tabs[intent.tabId] = ref;
        task.tabs[intent.tabId] = ref.tabId;
        await this.saveTaskState(task.profile, conn.tasks);
      }
      await navigateArcTab(ref, intent.targetUrl);
      if (intent.previousTabId) {
        await restoreArcSelection(ref, intent.previousTabId);
      }
      delete native.createIntents?.[intent.tabId];
      task.currentTabId = intent.tabId;
      await this.saveTaskState(task.profile, conn.tasks);
    }
  }

  private async createArcOwnedTab(
    conn: ArcProfileConnection,
    task: Task,
    url: string,
  ): Promise<string> {
    const native = this.requireArcTask(task);
    const tabId = generateShortId();
    const markerUrl = arcCreateMarker();
    const originalSpace = (await enumerateArcSpaces()).find(
      (space) => space.windowId === native.windowId && space.spaceId === native.spaceId,
    );
    if (!originalSpace) throw new Error('The original Arc window/Space for this task is no longer present.');
    native.createIntents ??= {};
    native.createIntents[tabId] = {
      tabId,
      markerUrl,
      targetUrl: url,
      createdAt: Date.now(),
      previousTabId: originalSpace.activeTabId,
    };
    await this.saveTaskState(task.profile, conn.tasks);
    await this.reconcileArcCreateIntents(conn, task);
    return tabId;
  }

  private async navigateArcNative(
    conn: ArcProfileConnection,
    task: Task,
    url: string,
    addTab = false,
  ): Promise<{ tabId: string; url: string; created: boolean; refreshed: boolean; message?: string }> {
    return this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const native = this.requireArcTask(task);
      if (!addTab) {
        for (const [shortId, ref] of Object.entries(native.tabs)) {
          const live = await resolveArcTab(ref);
          if (live && canonicalTabUrl(live.url) === canonicalTabUrl(url)) {
            await navigateArcTab(ref, url);
            task.currentTabId = shortId;
            await this.saveTaskState(task.profile, conn.tasks);
            return { tabId: shortId, url, created: false, refreshed: true, message: 'Tab already open—refreshed' };
          }
        }
      }
      const currentId = task.currentTabId;
      if (!addTab && currentId) {
        const ref = native.tabs[currentId];
        if (!ref || !(await resolveArcTab(ref))) {
          throw new Error(`Owned Arc tab ${currentId} is missing from its original window/Space; refusing to adopt a moved tab.`);
        }
        await navigateArcTab(ref, url);
        return { tabId: currentId, url, created: false, refreshed: false };
      }
      const tabId = await this.createArcOwnedTab(conn, task, url);
      return { tabId, url, created: true, refreshed: false };
    });
  }

  /**
   * Execute JavaScript in a native Arc tab. Sync JS only, isolated world —
   * async/promise evaluation fails honestly with an AppleScript error.
   */
  private async evaluateArcNative(
    conn: ArcProfileConnection,
    task: Task,
    shortId: string,
    expression: string,
  ): Promise<unknown> {
    const ref = this.requireArcTask(task).tabs[shortId];
    if (!ref || !(await resolveArcTab(ref))) {
      throw new Error(`Owned Arc tab ${shortId} is missing from its original window/Space.`);
    }
    return executeJavaScript(ref, expression);
  }

  private async listArcTaskTabs(task: Task): Promise<TabInfo[]> {
    const native = this.requireArcTask(task);
    const tabs: TabInfo[] = [];
    for (const [shortId, ref] of Object.entries(native.tabs)) {
      const live = await resolveArcTab(ref);
      if (!live) {
        throw new Error(
          `Owned Arc tab ${shortId} is missing from its original window/Space; refusing to adopt a moved tab.`,
        );
      }
      tabs.push({
        id: shortId,
        url: live.url,
        title: live.title,
        task: task.name,
        current: shortId === task.currentTabId,
      });
    }
    return tabs;
  }

  /**
   * Close native Arc tabs owned by a task. Only closes tabs the task created
   * (not borrowed ones). Never kills Arc. Identifies tabs only by stable ids in
   * the original window and Space.
   */
  private async closeArcNativeTabs(conn: ArcProfileConnection, task: Task): Promise<void> {
    await this.runExclusive('arc-native:host-app', async () => {
      await this.reconcileArcCreateIntents(conn, task);
      const native = this.requireArcTask(task);
      for (const [shortId, ref] of Object.entries(native.tabs)) {
        await closeArcTab(ref);
        delete native.tabs[shortId];
        delete task.tabs[shortId];
        delete task.refDescriptors?.[shortId];
      }
      task.currentTabId = undefined;
    });
  }

  /** Connect a profile at `target`, register it under `key`, and arm downloads. */
  private async openConnection(
    profile: BrowserProfile,
    target: string,
    key: ConnectionKey,
    profileName: ProfileName,
    opts: { persistRemote?: boolean } = {},
  ): Promise<ProfileConnection> {
    const conn = await this.connectProfile(profile, target, key, opts);
    conn.key = key;
    conn.profile = profileName;
    this.connections.set(key, conn);
    // Download behavior configuration is CDP-specific; skip for native Arc.
    if (conn.backend !== 'arc-native') {
      await this.applyDefaultDownloadBehavior(conn, key);
    }
    return conn;
  }

  /**
   * Open a tab for a HUMAN to read, bound to no task.
   *
   * That is the entire difference from {@link start}, and it is the point. The
   * abandoned-task reaper closes a task's tabs when the calling session dies or
   * after the idle window, but it "deliberately never touches a tab that is not
   * in `task.tabs`" (hygiene.ts) — so a viewer tab must not be in one, or the
   * artifact the user is reading vanishes when the agent that rendered it exits.
   *
   * Consequently `stop`/`done` do not close it either, which is correct: it is
   * the user's tab now.
   */
  async showUrl(
    profileName: ProfileName,
    url: string,
    opts: { endpointName?: string; fleetRemote?: boolean; actor?: string; probe?: DeviceProbe } = {},
  ): Promise<{ profile: ProfileName; key: ConnectionKey; tabId: string; device: string; picked?: string }> {
    // Same consent gate as start(): this opens a browser, so a fleet-remote
    // caller needs the target machine's opt-in.
    assertRemoteControlAllowedForRequest(opts.fleetRemote, { actor: opts.actor });

    const routed = resolveBrowserTarget(profileName, {
      endpointName: opts.endpointName,
      probe: opts.probe,
    });
    if (!routed.local && routed.commandDispatch) {
      throw new Error(
        `Native Arc profile "${profileName}" is owned by ${routed.device}; dispatch the complete browser command there.`,
      );
    }
    const key = routed.key;
    const effectiveProfile: BrowserProfile = routed.profile;

    const reused = await this.reuseProfileConnection(profileName, key, routed.local);
    let conn = reused?.conn;
    const effectiveKey = reused?.key ?? key;
    if (!conn) {
      adoptLegacyRuntimeIfLocal(routed.local, profileName, key, getBrowserRuntimeDir());
      conn = await this.openConnection(
        effectiveProfile,
        routed.target,
        key,
        profileName,
        { persistRemote: !routed.local },
      );
    }

    if (conn.backend === 'arc-native') {
      throw new ArcNativeCapabilityError(
        'show',
        'Task-less viewer tabs are unavailable for native Arc because creation intent cannot be bound to an owning task.',
      );
    }

    // createPageTarget refuses Arc with an actionable error rather than crashing it.
    const created = await this.createPageTarget(conn, { url });
    this.invalidateTargetCache(conn);
    return {
      profile: profileName,
      key: effectiveKey,
      tabId: created.targetId,
      device: routed.device,
      picked: routed.picked,
    };
  }

  async getHistory(limit = 10): Promise<HistoricalTask[]> {
    const historyFile = path.join(getBrowserRuntimeDir(), 'history.json');
    if (!fs.existsSync(historyFile)) return [];

    try {
      const history: HistoricalTask[] = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
      return history.slice(0, limit);
    } catch {
      return [];
    }
  }
}
