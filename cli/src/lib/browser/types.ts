export type BrowserType = 'chrome' | 'comet' | 'chromium' | 'brave' | 'edge' | 'arc' | 'custom';

/**
 * The user-facing name of a profile — what `agents browser profiles list`
 * prints and what `--profile <name>` takes. ALWAYS bare: it never carries an
 * `@<endpoint>` suffix or a `.<fork>` suffix. `BrowserProfile.name` is one.
 */
export type ProfileName = string;

/**
 * The key of an endpoint preset within a profile (`endpoint-0`, `local`, …) —
 * see {@link EndpointPreset} and `getEndpointPresets`.
 */
export type EndpointName = string;

/**
 * The RUNTIME key a live browser is registered under: `<profile>@<endpoint>`,
 * plus an optional `.<n>` fork suffix for Electron forks. It keys
 * `BrowserService.connections`, the profile's runtime dir, its `tasks.json`,
 * and its capture dirs — so one YAML profile can run at several endpoints
 * concurrently without colliding on disk.
 *
 * It is BRANDED on purpose. Before RUSH-2709 both this and a {@link ProfileName}
 * were bare `string`s and `start()` overwrote `BrowserProfile.name` with the
 * composite, so a connection key leaked into every user-facing listing and six
 * consumers each invented their own rule for turning one back into the other.
 * The brand makes `connections.get(someProfileName)` — the exact miss behind
 * `status --profile comet-local` returning EMPTY for a live
 * `comet-local@endpoint-0` — a compile error. Build one ONLY with
 * {@link connectionKey} (deriving) or {@link asConnectionKey} (adopting a name
 * that is already a runtime key, e.g. a directory read off disk).
 */
export type ConnectionKey = string & { readonly __connectionKey: unique symbol };

/** The single site that derives a {@link ConnectionKey} from its two parts. */
export function connectionKey(profile: ProfileName, endpoint: EndpointName): ConnectionKey {
  return `${profile}@${endpoint}` as ConnectionKey;
}

/**
 * Adopt a string that IS already a runtime key — a runtime directory name, a
 * `tasks.json` `profile` field, a fork key. Never use it to launder a bare
 * profile name into a key; use {@link connectionKey} for that.
 */
export function asConnectionKey(raw: string): ConnectionKey {
  return raw as ConnectionKey;
}

/**
 * Split a {@link ConnectionKey} back into its parts. The inverse of
 * {@link connectionKey}, and the ONE rule every consumer uses to decide whether
 * a runtime key belongs to a profile.
 *
 * Tolerates the legacy shape still on disk: a pre-composite key that is just
 * the bare profile name (`comet-local`).
 *
 * A key with no `@` is read as a WHOLE profile name, never as `<name>.<fork>`,
 * because nothing constrains a profile's name (`createProfile` checks only for
 * a duplicate name and a port collision). Reading the trailing digits as a fork
 * would let `stop --profile chrome` claim the runtime dirs of a separate
 * profile named `chrome.2` and kill its browser. A fork is only ever created
 * from a composite base (`forkElectronProfile` appends to a `<p>@<e>` key), so
 * the `@`-bearing branch below is the one that must understand forks.
 */
export function parseConnectionKey(key: string): {
  profile: ProfileName;
  endpoint?: EndpointName;
  fork?: number;
} {
  // LAST `@`, not the first: a profile name may itself contain one (`me@work`),
  // and splitting on the first would report its profile as `me` — so
  // `status --profile me@work` would find nothing for a running browser.
  const at = key.lastIndexOf('@');
  if (at === -1) return { profile: key };
  const profile = key.slice(0, at);
  const rest = key.slice(at + 1);
  const dot = rest.indexOf('.');
  if (dot === -1) return { profile, endpoint: rest };
  const fork = Number(rest.slice(dot + 1));
  return {
    profile,
    endpoint: rest.slice(0, dot),
    fork: Number.isFinite(fork) ? fork : undefined,
  };
}

/** True when `key` is a runtime key of `profile`. The only reconciliation rule. */
export function keyBelongsToProfile(key: string, profile: ProfileName): boolean {
  return parseConnectionKey(key).profile === profile;
}

/**
 * A single named endpoint preset within a profile. Lets one profile cover
 * the local + remote variants of the same app (e.g. an Electron app on this
 * Mac vs. on a remote host) instead of forcing two parallel profiles.
 *
 * Per-endpoint overrides take precedence over profile-level fields.
 */
export interface EndpointPreset {
  /**
   * CDP URL — `cdp://host:port` or `ssh://host?port=N`.
   *
   * For an SSH target whose remote is Windows, append `&os=windows` (e.g.
   * `ssh://user@host?port=9222&os=windows`). The driver then speaks the
   * Windows dialect (launch via WMI Win32_Process.Create so the browser
   * survives the ssh session, teardown via Get-NetTCPConnection/Stop-Process)
   * instead of the POSIX default. The query param is the single source of
   * truth for remote-OS selection.
   */
  target: string;
  /** Override the profile-level binary (e.g. a remote host has no local binary). */
  binary?: string;
  /** Override the profile-level targetFilter (Electron app builds may diverge). */
  targetFilter?: string;
}

export interface BrowserProfile {
  /**
   * The user-facing profile name, ALWAYS bare — never `name@endpoint`. The
   * runtime key that carries the endpoint is a separate value
   * ({@link ConnectionKey}); nothing may write one here.
   */
  name: ProfileName;
  description?: string;
  browser: BrowserType;
  binary?: string;
  electron?: boolean;
  /**
   * `url:<substring>` or `title:<substring>`. Picks which CDP page target
   * represents the visible UI for Electron apps with multiple WebContents.
   */
  targetFilter?: string;
  /**
   * Endpoint presets. Accepts two shapes for backward compatibility:
   *   - Legacy: `string[]` of CDP URLs; first entry is the default.
   *   - New:    `{ [presetName]: EndpointPreset }`, with optional `defaultEndpoint`.
   * Normalize via `resolveEndpoint(profile, name?)` instead of reading directly.
   */
  endpoints: string[] | Record<string, EndpointPreset>;
  defaultEndpoint?: string;
  chrome?: ChromeOptions;
  secrets?: string;
  viewport?: { width: number; height: number; x?: number; y?: number };
  /** Directory holding source-side JSONL logs (e.g. ~/.rush/logs). */
  logDir?: string;
  /** Optional SSH host where logDir lives, e.g. "user@remote-host". */
  logHost?: string;
}

/** Parsed form of `BrowserProfile.targetFilter`. */
export interface TargetFilter {
  kind: 'url' | 'title';
  value: string;
}

export interface ChromeOptions {
  headless?: boolean;
  args?: string[];
  viewport?: { width: number; height: number; x?: number; y?: number };
}

export interface Task {
  id: string;
  /**
   * Unique addressable handle used as the tasks map key, capture-dir name, and
   * the value agents export as `$AGENTS_BROWSER_TASK`. Prefer the short `id`
   * for auto-generated tasks; an explicit `--task` name still wins.
   */
  name: string;
  /**
   * Human-readable label for `browser status`. Derived once from `--title`,
   * else the first navigated host, else `untitled`. Distinct from `name` so a
   * short machine id can stay addressable while status stays readable.
   */
  label?: string;
  /**
   * The RUNTIME key of the browser this task lives on (`<profile>@<endpoint>`),
   * not the bare profile name — it addresses the runtime dir this task's
   * `tasks.json` and captures are written under. Use
   * {@link parseConnectionKey} to get the user-facing name out of it.
   */
  profile: ConnectionKey;
  tabs: Record<string, string>; // shortId (8 chars) -> CDP targetId
  /**
   * Tabs this task DRIVES but did not create, by shortId — a tab that already
   * existed in the browser and was reused because the browser cannot open new
   * ones (Arc: `Target.createTarget` crashes it, #2778/#2786). Every close path
   * skips these: the task never opened the tab, so closing it on `done` would
   * take away something that was there first. Same rule `adoptTabShowing`
   * states for unowned pages, kept when reuse is unavoidable rather than
   * optional.
   */
  borrowedTabs?: string[];
  currentTabId?: string; // shortId of current tab
  createdAt: number;
  /**
   * When this task last did anything. Stamped at creation (equal to
   * `createdAt`) and refreshed by every task-scoped action, because every one
   * of them resolves the task through `BrowserService.findTask`.
   *
   * Read by the idle half of the abandoned-task reaper (`hygiene.ts`): a task
   * nobody has driven for `idleMs` is stopped so its tabs stop piling up in the
   * profile window (RUSH-2622).
   *
   * Persisted in tasks.json. Tasks written before RUSH-2622 carry none;
   * `loadTaskState` normalizes those to `createdAt` on read, so every task in
   * memory has one and the reaper never has to guess.
   */
  lastActionAt: number;
  pid: number;
  /**
   * Resolved actor id (`resolveActor().id`) stamped at task start — WHO launched
   * this browser task (a person/agent identity, stable across runs). Forwarded
   * from the caller over IPC — the daemon is shared, so it cannot resolve the
   * caller's actor itself. Optional: tasks persisted before RUSH-2020 carry none.
   */
  owner?: string;
  /**
   * The caller's per-run launch id (`$AGENT_LAUNCH_ID`, minted by exec.ts for
   * every harness) stamped at task start — WHICH run created this task. Distinct
   * from `owner`: two runs by the same actor get different launchIds, which is
   * the scope the current-task default and `status --mine` filter on. Forwarded
   * from the caller over IPC. Optional: tasks from before this shipped carry none.
   */
  launchId?: string;
  /**
   * The agent session that started this task (`$AGENT_SESSION_ID`), forwarded
   * from the caller at `start`. The durable copy lives in the `browser_sessions`
   * table, which survives `stop`; this in-memory/tasks.json copy is the live one
   * (RUSH-2549).
   */
  sessionId?: string;
  /**
   * Per-tab snapshot of the last ref listing captured for that tab
   * (shortId -> {descriptors, opts}). Persisted to tasks.json so a later
   * `click`/`type <ref>` can self-heal a drifted ref — the cached `opts` let
   * the action rebuild its node map with the SAME accessibility filter the
   * listing was numbered against. Owned by `refs()`; actions never overwrite
   * it. See RefSnapshot / RefDescriptor.
   */
  refDescriptors?: Record<string, import('./refs.js').RefSnapshot>;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  task: string;
}

export interface ProfileStatus {
  /**
   * The BARE profile name — what the user passed to `--profile` and what
   * `status` prints. The endpoint is reported separately in {@link endpoint};
   * the raw runtime key (if a caller genuinely needs it) is {@link key}.
   */
  name: ProfileName;
  /** Endpoint preset this browser is running at, when the key carries one. */
  endpoint?: EndpointName;
  /** The runtime key backing this status: `<profile>@<endpoint>[.<fork>]`. */
  key?: ConnectionKey;
  running: boolean;
  port?: number;
  pid?: number;
  /** The port declared in the profile's first endpoint, when it differs from the running port. */
  configuredPort?: number;
  tasks: TaskStatus[];
}

export interface TaskStatus {
  id: string;
  name: string;
  /** Human label for status tables; falls back to name when absent. */
  label?: string;
  tabCount: number;
  currentTabId?: string;
  createdAt: number;
  endedAt?: number;
  domains?: string[];
  tabs?: Array<{ id: string; url: string; title?: string; current?: boolean }>;
}

export interface HistoricalTask {
  id: string;
  name: string;
  profile: string;
  createdAt: number;
  endedAt: number;
  domains: string[];
  tabCount: number;
  /** Actor id who launched the task (RUSH-2020); absent for pre-RUSH-2020 history. */
  owner?: string;
}

/**
 * Why the reaper stopped a task. `session-dead` — the agent session (or run)
 * that started it is provably gone; `idle` — nothing has driven it for the
 * idle window. See `hygiene.ts`.
 */
export type ReapReason = 'session-dead' | 'idle';

/** One task the reaper stopped (or, under `dryRun`, would have stopped). */
export interface ReapedTask {
  task: string;
  profile: string;
  reason: ReapReason;
}

export interface ReapResult {
  closed: ReapedTask[];
  /** Tasks left alone this pass: still live, still inside the idle window, or recording. */
  skipped: number;
}

export type IPCAction =
  | 'start'
  // Open a tab for a HUMAN to read. Deliberately absent from PAGE_CREATE_VERBS
  // and PAGE_RESOLVE_VERBS: it must NOT bind a task, or the abandoned-task
  // reaper would close the user's tab when the calling session ends.
  | 'show'
  | 'gc'
  | 'record-start'
  | 'record-stop'
  | 'done'
  | 'stop'
  | 'status'
  | 'history'
  | 'navigate'
  | 'tab-add'
  | 'tab-focus'
  | 'tab-close'
  | 'tab-list'
  | 'evaluate'
  | 'screenshot'
  | 'pdf'
  | 'refs'
  | 'click'
  | 'type'
  | 'press'
  | 'hover'
  | 'scroll'
  | 'set-viewport'
  | 'set-device'
  | 'console'
  | 'errors'
  | 'requests'
  | 'response-body'
  | 'wait'
  | 'set-download-path'
  | 'wait-download'
  | 'upload'
  | 'getAppLogs'
  | 'version'
  // On-demand self-update: run the same fail-closed check/install/verify/exit
  // path SelfUpdateService's periodic tick runs (self-update-service.ts),
  // right now instead of on its own schedule. See reconcileDaemonVersion below.
  | 'request-self-update';

export interface IPCRequest {
  action: IPCAction;
  task?: string;
  taskName?: string; // human-readable task name for 'open'
  profile?: string;
  url?: string;
  tabId?: string;
  expr?: string;
  path?: string;
  ref?: number;
  // Coordinate click (`browser click --at X,Y`): bypasses ref resolution.
  atX?: number;
  atY?: number;
  text?: string;
  key?: string;
  scrollX?: number;
  scrollY?: number;
  scrollAtX?: number;
  scrollAtY?: number;
  interactive?: boolean;
  limit?: number;
  // Viewport/device
  width?: number;
  height?: number;
  deviceName?: string;
  mobile?: boolean;
  deviceScaleFactor?: number;
  // Console/errors
  level?: 'log' | 'info' | 'warn' | 'error';
  clear?: boolean;
  // Network
  filter?: string;
  urlPattern?: string;
  maxChars?: number;
  // Wait
  waitType?: 'time' | 'selector' | 'url' | 'function' | 'load';
  waitValue?: string | number;
  timeout?: number;
  // Downloads
  downloadPath?: string;
  // Upload
  files?: string[];
  trigger?: number;
  uploadMode?: 'auto' | 'input' | 'drop' | 'chooser';
  // Screenshot
  quality?: 'compressed' | 'raw';
  // Endpoint preset
  endpoint?: string;
  // Recording
  fps?: number;
  duration?: number;
  maxMb?: number;
  // App logs
  source?: string;
  lines?: number;
  message?: string;
  since?: string;
  until?: string;
  appLevel?: string;
  // Browser start: opt out of domain-skill discovery.
  skipDomainSkill?: boolean;
  /**
   * Explicit human label for a new task (`agents browser start --title …`).
   * When omitted, the label is derived from the first navigated host.
   */
  title?: string;
  /**
   * Browser start: always open a new tab. Without it, `start --url` reclaims a
   * tab that an ABANDONED task is still holding on this exact URL rather than
   * opening a duplicate (RUSH-2622). A tab held by a live task, or one nobody's
   * task owns (the user's own), is never taken either way — set this when the
   * caller wants its own tab regardless.
   */
  fresh?: boolean;
  // `gc`: override the idle window (default 30) and preview without closing.
  idleMinutes?: number;
  dryRun?: boolean;
  // Caller identity, forwarded from the CLI process. The browser daemon is
  // shared and long-lived, so it cannot resolve the caller's actor/run itself
  // (resolveActor() there yields the daemon's identity, not the caller's).
  // `actor` is stamped onto the task at `start`; `launchId` is stamped too AND,
  // on `status`, scopes the listing to the caller's run.
  actor?: string;
  launchId?: string;
  /**
   * The calling agent session (`$AGENT_SESSION_ID` / `$AGENTS_SESSION_ID`) —
   * the id that answers "which agent drove this task" and the one persisted to
   * `browser_sessions` (RUSH-2549).
   *
   * This is the primary identity, not a spare: `launchId` alone was the join
   * key, and a fleet measurement found it present on only 2 of 5 live agent
   * processes while a session id was on 5 of 5 — every agent reaching the
   * browser carries one. It is the same env `stampProvenance()` already reads
   * for `computer.action` events, so both tool surfaces key on one signal.
   */
  sessionId?: string;

  /**
   * True when the CLI process that issued this request was itself dispatched to
   * this machine by a fleet `--device` hop.
   *
   * Stamped client-side for the same reason actor/launchId are — and
   * additionally because the daemon may have been auto-started BY a fleet-remote
   * CLI and inherited AGENTS_FLEET_REMOTE for its whole life (startDetached
   * passes `env: opts.env ?? process.env`). The daemon's own env is therefore
   * not a truthful signal about the CURRENT caller; only the request is.
   */
  fleetRemote?: boolean;
}

/** Subset of IPCResponse describing a recording start result. */
export interface RecordStartFields {
  fps?: number;
  durationCapSec?: number;
  maxMb?: number;
}

/** Subset of IPCResponse describing a recording stop result. */
export interface RecordStopFields {
  durationMs?: number;
  stopReason?: 'manual' | 'duration-cap' | 'size-cap';
}

export interface IPCResponse {
  ok: boolean;
  error?: string;
  task?: string;
  tabId?: string;
  windowTargetId?: string;
  tabs?: TabInfo[];
  profiles?: ProfileStatus[];
  history?: HistoricalTask[];
  /** `gc`: what the abandoned-task reaper closed (or would close under dryRun). */
  reaped?: ReapResult;
  result?: unknown;
  path?: string;
  bytes?: number;
  width?: number;
  height?: number;
  refs?: string;
  nodes?: RefNodeJson[];
  /** Human-readable note surfaced to the CLI (e.g. a self-heal notice on click). */
  message?: string;
  port?: number;
  pid?: number;
  // Recording
  fps?: number;
  durationCapSec?: number;
  maxMb?: number;
  durationMs?: number;
  stopReason?: 'manual' | 'duration-cap' | 'size-cap';
  // Console/errors
  logs?: ConsoleEntry[];
  errors?: ErrorEntry[];
  // Network
  requests?: NetworkRequest[];
  body?: string;
  // Downloads
  downloadPath?: string;
  // Devices
  devices?: string[];
  // Upload
  uploadMode?: 'input' | 'drop' | 'chooser';
  // App logs
  appLogs?: any[];
  // Version handshake — daemon answers with the package version it was
  // built from so the client can warn when the daemon is older than the
  // caller (the failure mode that produced this whole patch series: a
  // launchd-managed registry daemon silently serving old code to a
  // dev-build CLI client).
  version?: string;
  // 'request-self-update' result: whether the daemon installed + verified a
  // newer version and is about to exit for the OS supervisor to relaunch it
  // (see self-update-service.ts), or why it did not.
  updated?: boolean;
  reason?: string;
  // Domain-skill auto-discovery result from `start` when a URL is supplied
  // and a matching SKILL.md was found under
  // ~/.agents/skills/browser/domain-skills/.
  skill?: {
    name: string;
    path: string;
    content: string;
    hostname: string;
  };
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  text: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  timestamp: number;
  url?: string;
  line?: number;
}

export interface NetworkRequest {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  timestamp: number;
}

export interface RefNodeJson {
  ref: number;
  role: string;
  name: string;
  attrs: string[];
  editor?: string;
}

export interface DeviceDescriptor {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export const TASK_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidTaskId(id: string): boolean {
  return TASK_ID_REGEX.test(id) && id.length <= 64;
}

export function generateTaskId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function generateShortId(): string {
  return crypto.randomUUID().split('-')[0]; // 8 chars
}

const ADJECTIVES = [
  'swift', 'cosmic', 'jolly', 'quiet', 'bold', 'bright', 'calm', 'eager',
  'golden', 'happy', 'keen', 'lucky', 'noble', 'proud', 'quick', 'royal',
  'silver', 'amber', 'crimson', 'misty', 'sunny', 'gentle', 'wild', 'brave',
  'merry', 'sleek', 'wise', 'fierce', 'curious', 'humble', 'spry', 'witty',
];

const NOUNS = [
  'falcon', 'comet', 'tiger', 'nebula', 'phoenix', 'river', 'summit', 'wave',
  'aurora', 'breeze', 'crystal', 'dragon', 'ember', 'forest', 'glacier', 'harbor',
  'crab', 'otter', 'hawk', 'fox', 'wolf', 'panda', 'lynx', 'raven',
  'meadow', 'canyon', 'valley', 'orchid', 'cedar', 'thistle', 'lotus', 'briar',
];

export function generateFunName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

/**
 * Auto-generated task name: `<adjective>-<noun>-<noun>-<hex8>`, e.g.
 * `swift-crab-falcon-a3f92b1c`. Three English words make it memorable and
 * easy to read; 32 bits of hex give every spawned task enough entropy that
 * parallel agents never collide on the daemon side.
 */
export function generateTaskName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun1 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  let noun2 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  while (noun2 === noun1) {
    noun2 = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  }
  const hex8 = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `${adj}-${noun1}-${noun2}-${hex8}`;
}
