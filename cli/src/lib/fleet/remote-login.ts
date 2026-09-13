/**
 * `agents fleet login` — remote device-code OAuth orchestration.
 *
 * WHY this exists: copying one OAuth credential file across N boxes is fatal — a
 * shared refresh token rotates server-side on first refresh and invalidates the
 * other copies (droid collapsed 10 boxes -> 1 overnight). The durable fix is a
 * per-machine credential: an interactive login per (agent x box). This module
 * makes that bearable by driving every box's device-code flow over SSH, scraping
 * each verification URL + user code, and surfacing them all in ONE local browser
 * page so the human enters codes back-to-back instead of babysitting N terminals.
 *
 * The propagation gate lives in `auth-sync.ts`: {@link isCredentialSafeToPropagate}
 * and {@link SINGLE_USE_ROTATING_REFRESH_AGENTS} are the single place where the
 * "is this credential safe to copy?" decision is made, shared by `agents apply`
 * and any other propagation path.
 *
 * Layering — pure vs I/O, so the valuable logic is unit-testable without SSH:
 *  - `scrapeLogin` / `classifyLoginFlow` / `selectLoginTargets` /
 *    `buildRemoteLoginSshCommand` / `buildDashboardHtml` are PURE.
 *  - `driveRemoteLogin` drives a PTY through an injectable {@link PtyDriver}
 *    (fake in tests; real over the pty sidecar in prod).
 *  - `detectPending` / `runFleetLogin` do the real fleet I/O.
 *
 * The device codes have a ~15 min TTL, so the default (bulk) mode requests every
 * code concurrently and shows them at once, while `--interactive` drives one box
 * at a time — requesting each code just-in-time so it can't expire while the
 * human works through the earlier ones.
 */
import * as http from 'http';
import type { AgentId } from '../types.js';
import type { DeviceProfile } from '../devices/registry.js';
import { loadDevices } from '../devices/registry.js';
import { deviceIdentityArgs, fleetDialTarget } from '../devices/connect.js';
import { planFleetTargets } from '../devices/fleet.js';
import { assertValidSshTarget, shellQuote, sshExecAsync } from '../ssh-exec.js';
import { machineId } from '../session/sync/config.js';
import { ptyRequest } from '../pty-client.js';
import { showUrl } from '../open-url.js';
import {
  readAuthHealthCache,
  type AuthVerdict,
  type AuthHealth,
} from '../auth-health.js';
import {
  FLEET_LOGIN_FLOWS,
  KEYCHAIN_BOUND_ON_MAC,
  type LoginFlow,
} from './auth-sync.js';

// ---------------------------------------------------------------------------
// Pure: scrape / classify / select / command-build (unit-tested; no I/O)
// ---------------------------------------------------------------------------

/** A verification URL + user code scraped from a device-code login screen. */
interface ScrapedLogin {
  url?: string;
  code?: string;
}

/**
 * Extract the verification URL and user code from an ANSI-stripped login screen
 * using the flow's regexes. Pure — no I/O, so it is the highest-value unit test
 * target (a wrong code boundary or a missed URL is exactly the bug class this
 * whole feature turns on). Group 1 is preferred over the whole match so a
 * surrounding phrase ("enter code XXXX-XXXX") never leaks into the captured
 * value. A flow with no regex for a field yields `undefined` for that field.
 */
export function scrapeLogin(screenText: string, flow: LoginFlow): ScrapedLogin {
  const out: ScrapedLogin = {};
  if (flow.verificationUrlRegex) {
    const m = screenText.match(flow.verificationUrlRegex);
    if (m) out.url = (m[1] ?? m[0]).trim();
  }
  if (flow.userCodeRegex) {
    const m = screenText.match(flow.userCodeRegex);
    if (m) out.code = (m[1] ?? m[0]).trim();
  }
  return out;
}

/** Why a logged-out (agent, device) pair can or cannot be driven remotely. */
interface FlowClassification {
  flow: LoginFlow | null;
  remotable: boolean;
  reason?: string;
}

/**
 * Decide whether `agent`'s login can be driven on a box of `platform`. Only a
 * `device-code` flow is remotable; loopback (browser + 127.0.0.1 on the box),
 * api-key, unknown, or a macOS keychain-bound token are surfaced with an honest
 * reason instead of a mis-drive. Pure.
 */
export function classifyLoginFlow(agent: AgentId | string, platform: string | undefined): FlowClassification {
  const flow = FLEET_LOGIN_FLOWS[agent] ?? null;
  if (!flow) return { flow: null, remotable: false, reason: 'no login flow defined' };
  if (platform === 'macos' && KEYCHAIN_BOUND_ON_MAC.has(agent)) {
    return { flow, remotable: false, reason: 'keychain-bound on macOS (log in on the box itself)' };
  }
  switch (flow.flowType) {
    case 'device-code':
      return { flow, remotable: true };
    case 'loopback':
      return { flow, remotable: false, reason: 'loopback OAuth — needs a browser on the box' };
    case 'api-key':
      return { flow, remotable: false, reason: 'api-key login — no device code' };
    case 'unknown':
    default:
      return { flow, remotable: false, reason: 'login flow not yet characterized' };
  }
}

/**
 * Does a cached auth verdict mean "this (host, agent) needs an interactive
 * login"? A missing row (never signed in / credential absent) and a `revoked`
 * token do; `live`, `unverified` (signed in, no probe), `expired`, and
 * `rate_limited` are treated as already-logged-in (expired self-heals on next
 * launch — never re-login on it). Pure.
 */
export function isPendingVerdict(verdict: AuthVerdict | undefined): boolean {
  return verdict === undefined || verdict === 'revoked';
}

/** The worst (most-actionable) verdict cached for a host+agent across versions. */
function worstCachedVerdict(cache: Record<string, AuthHealth>, host: string, agent: string): AuthVerdict | undefined {
  const prefix = `${host}:${agent}:`;
  let best: AuthVerdict | undefined;
  for (const [key, health] of Object.entries(cache)) {
    if (!key.startsWith(prefix)) continue;
    // A revoked row always wins (most actionable); otherwise the first live/other.
    if (health.verdict === 'revoked') return 'revoked';
    if (best === undefined) best = health.verdict;
  }
  return best;
}

/** A logged-out (agent, device) pair `fleet login` will target or explain. */
interface PendingLogin {
  device: string;
  agent: AgentId | string;
  platform?: string;
  /** ssh dial target for the device. */
  target: string;
  extraSshArgs?: string[];
  flow: LoginFlow;
  /** True when a device-code flow this command can actually drive. */
  remotable: boolean;
  /** Present when `!remotable` — why it must be done on the box itself. */
  reason?: string;
}

interface SelectLoginOptions {
  /** Include pairs already logged-in (verdict live/unverified) — for a forced re-login. */
  includeLoggedIn?: boolean;
}

/**
 * From a device list, requested agents, and the auth-health cache, compute the
 * pending logins — partitioned (via {@link classifyLoginFlow}) into remotable
 * device-code flows and non-remotable pairs with a reason. Pure: the caller
 * supplies the already-loaded devices + cache, so this is fully unit-testable.
 *
 * A pair is pending when its cached verdict {@link isPendingVerdict} (or
 * `includeLoggedIn` forces it). Agents with no defined login flow are dropped
 * silently (nothing to log into).
 */
export function selectLoginTargets(
  devices: DeviceProfile[],
  agents: (AgentId | string)[],
  cache: Record<string, AuthHealth>,
  opts: SelectLoginOptions = {},
): PendingLogin[] {
  const out: PendingLogin[] = [];
  for (const device of devices) {
    for (const agent of agents) {
      const { flow, remotable, reason } = classifyLoginFlow(agent, device.platform);
      if (!flow) continue; // agent has no login flow — nothing to do
      const verdict = worstCachedVerdict(cache, device.name, agent);
      if (!opts.includeLoggedIn && !isPendingVerdict(verdict)) continue;
      out.push({
        device: device.name,
        agent,
        platform: device.platform,
        target: fleetDialTarget(device),
        extraSshArgs: deviceIdentityArgs(device),
        flow,
        remotable,
        reason,
      });
    }
  }
  return out;
}

/**
 * Build the `ssh -tt <target> <loginCommand>` command string driven through the
 * PTY sidecar. `-tt` forces a tty so the remote CLI enters its interactive
 * device-code flow; `accept-new` learns a first-seen host key without a prompt.
 * Both the target and the login command are shell-quoted. Pure/testable.
 *
 * NOTE: this uses key-based ssh auth (the tailnet fleet's norm). Password-bundle
 * devices need the askpass shim env, which the PTY env allowlist strips — those
 * are a follow-up (TODO), surfaced as an error rather than silently mis-driven.
 */
export function buildRemoteLoginSshCommand(target: string, flow: LoginFlow, extraSshArgs: string[] = []): string {
  assertValidSshTarget(target);
  // The agent CLIs (kimi/droid/codex/…) are agents-cli shims that live in
  // ~/.agents/.cache/shims and are only on PATH in an interactive/login shell.
  // `ssh <box> <cmd>` runs a NON-login shell, so a bare `kimi` is "command not
  // found" and the login program never launches (the scrape then times out).
  // Prepend the shim dir — resolved on the REMOTE via $HOME, single-quoted so
  // $HOME/$PATH expand on the box, not locally — so the login command resolves.
  const remoteCmd = `PATH="$HOME/.agents/.cache/shims:$PATH" ${flow.loginCommand}`;
  return [
    'ssh', '-tt',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    ...extraSshArgs.map(shellQuote),
    shellQuote(target),
    shellQuote(remoteCmd),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Dashboard HTML (pure) — self-contained, dark+light, terminal-coded
// ---------------------------------------------------------------------------

type LoginMode = 'bulk' | 'interactive';

/** Per-pair status shape shared between the driver, the status endpoint, and the page. */
export type LoginStatusState = 'pending' | 'driving' | 'ready' | 'authorized' | 'error' | 'skipped';

export interface LoginStatus {
  device: string;
  agent: string;
  remotable: boolean;
  reason?: string;
  state: LoginStatusState;
  url?: string;
  code?: string;
  /** epoch ms the scraped code expires (best-effort ~15 min TTL). */
  expiresAt?: number;
  detail?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the self-contained dashboard page. Inlines all CSS/JS; the page polls
 * `/api/status` and flips rows to their live state. `bulk` shows a grid of every
 * pending login at once; `interactive` shows a one-at-a-time wizard. Pure — a
 * string in, a string out — so it renders (and is asserted) without a server.
 * Terminal-coded per the agents-cli brand (#0a0a0a bg, #a3e635 lime), with a
 * light variant via `prefers-color-scheme`.
 */
export function buildDashboardHtml(pending: PendingLogin[], mode: LoginMode): string {
  const seed = pending.map((p) => ({
    device: p.device,
    agent: p.agent,
    remotable: p.remotable,
    reason: p.reason,
    state: (p.remotable ? 'pending' : 'skipped') as LoginStatusState,
  }));
  const seedJson = JSON.stringify(seed);
  const remotableCount = pending.filter((p) => p.remotable).length;
  const subtitle = mode === 'interactive'
    ? 'Guided login — one box at a time, codes requested just-in-time.'
    : 'All pending logins — enter each code in a browser tab, back to back.';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agents fleet login</title>
<style>
  :root {
    --bg: #0a0a0a; --panel: #141414; --border: #262626; --fg: #e5e5e5;
    --muted: #8a8a8a; --accent: #a3e635; --ready: #38bdf8; --ok: #22c55e;
    --warn: #f59e0b; --err: #ef4444; --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --panel: #fff; --border: #e5e5e5; --fg: #171717; --muted: #6b7280; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: Inter, system-ui, sans-serif; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
  header h1 { font-family: var(--mono); font-size: 20px; margin: 0 0 4px; }
  header h1 .lime { color: var(--accent); }
  header p { color: var(--muted); margin: 0 0 6px; font-size: 14px; }
  .meta { color: var(--muted); font-size: 12px; font-family: var(--mono); margin-bottom: 24px; }
  .grid { display: grid; gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card.done { border-color: var(--ok); }
  .card.err { border-color: var(--err); }
  .card.skip { opacity: 0.6; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .who { font-family: var(--mono); font-size: 14px; }
  .who .agent { color: var(--accent); }
  .who .at { color: var(--muted); }
  .state { font-family: var(--mono); font-size: 12px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .state.pending { color: var(--muted); }
  .state.driving { color: var(--warn); border-color: var(--warn); }
  .state.ready { color: var(--ready); border-color: var(--ready); }
  .state.authorized { color: var(--ok); border-color: var(--ok); }
  .state.error { color: var(--err); border-color: var(--err); }
  .code-line { margin-top: 12px; display: none; align-items: center; gap: 12px; flex-wrap: wrap; }
  .code-line.show { display: flex; }
  .code { font-family: var(--mono); font-size: 22px; letter-spacing: 2px; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; }
  a.auth-btn { text-decoration: none; background: var(--accent); color: #0a0a0a; font-weight: 600; font-family: var(--mono); font-size: 13px; padding: 8px 14px; border-radius: 8px; }
  button.copy { font-family: var(--mono); font-size: 12px; background: transparent; color: var(--fg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; cursor: pointer; }
  .ttl { font-family: var(--mono); font-size: 12px; color: var(--muted); }
  .reason { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .empty { color: var(--muted); font-family: var(--mono); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>agents <span class="lime">fleet login</span></h1>
    <p>${esc(subtitle)}</p>
    <div class="meta">mode: ${mode} &middot; ${remotableCount} remotable &middot; <span id="tick"></span></div>
  </header>
  <div id="grid" class="grid"></div>
</div>
<script>
  const SEED = ${seedJson};
  const MODE = ${JSON.stringify(mode)};
  const keyOf = (s) => s.device + '::' + s.agent;
  let statuses = {};
  for (const s of SEED) statuses[keyOf(s)] = s;

  function fmtTtl(expiresAt) {
    if (!expiresAt) return '';
    const ms = expiresAt - Date.now();
    if (ms <= 0) return 'expired';
    const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
    return 'expires in ' + m + 'm ' + String(sec).padStart(2, '0') + 's';
  }

  function render() {
    const grid = document.getElementById('grid');
    const items = Object.values(statuses);
    if (items.length === 0) { grid.innerHTML = '<div class="empty">Nothing pending — every requested account is already logged in.</div>'; return; }
    grid.innerHTML = '';
    for (const s of items) {
      const card = document.createElement('div');
      card.className = 'card' + (s.state === 'authorized' ? ' done' : s.state === 'error' ? ' err' : s.state === 'skipped' ? ' skip' : '');
      const stateCls = s.state;
      const stateText = s.state === 'skipped' ? 'not remotable' : s.state;
      card.innerHTML =
        '<div class="row">' +
          '<span class="who"><span class="agent">' + s.agent + '</span><span class="at"> @ </span>' + s.device + '</span>' +
          '<span class="state ' + stateCls + '">' + stateText + '</span>' +
        '</div>' +
        (s.reason && !s.remotable ? '<div class="reason">' + s.reason + '</div>' : '') +
        (s.detail ? '<div class="reason">' + s.detail + '</div>' : '');
      if (s.url && s.code && s.state !== 'authorized') {
        const line = document.createElement('div');
        line.className = 'code-line show';
        const sep = s.url.indexOf('?') === -1 ? '?' : '&';
        const deep = s.url + sep + 'user_code=' + encodeURIComponent(s.code);
        line.innerHTML =
          '<span class="code">' + s.code + '</span>' +
          '<button class="copy" data-code="' + s.code + '">copy code</button>' +
          '<a class="auth-btn" href="' + deep + '" target="_blank" rel="noopener">Authorize &rarr;</a>' +
          '<span class="ttl" data-exp="' + (s.expiresAt || '') + '">' + fmtTtl(s.expiresAt) + '</span>';
        card.appendChild(line);
      }
      grid.appendChild(card);
    }
    grid.querySelectorAll('button.copy').forEach((b) => {
      b.addEventListener('click', () => { navigator.clipboard.writeText(b.getAttribute('data-code')); b.textContent = 'copied'; });
    });
  }

  async function poll() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      for (const s of data.statuses) statuses[keyOf(s)] = s;
    } catch (e) { /* transient */ }
    render();
  }

  function tick() {
    document.getElementById('tick').textContent = new Date().toLocaleTimeString();
    document.querySelectorAll('.ttl[data-exp]').forEach((el) => {
      const exp = Number(el.getAttribute('data-exp'));
      if (exp) el.textContent = fmtTtl(exp);
    });
  }

  render();
  poll();
  setInterval(poll, 2000);
  setInterval(tick, 1000);
  tick();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// PTY driver (injectable) + driveRemoteLogin
// ---------------------------------------------------------------------------

/** The subset of the PTY sidecar `driveRemoteLogin` needs — faked in tests. */
export interface PtyDriver {
  start(opts?: { rows?: number; cols?: number }): Promise<string>;
  exec(id: string, command: string): Promise<void>;
  write(id: string, input: string): Promise<void>;
  screen(id: string): Promise<{ screen: string; exited: boolean }>;
  stop(id: string): Promise<void>;
}

/** Real driver over the pty sidecar (`ptyRequest`). */
export function defaultPtyDriver(): PtyDriver {
  const expectOk = (res: { ok: boolean; error?: string }, what: string) => {
    if (!res.ok) throw new Error(`pty ${what} failed: ${res.error ?? 'unknown'}`);
  };
  return {
    async start(opts) {
      const res = await ptyRequest('start', undefined, { rows: opts?.rows ?? 40, cols: opts?.cols ?? 120 });
      expectOk(res, 'start');
      return res.id as string;
    },
    async exec(id, command) {
      expectOk(await ptyRequest('exec', id, { command }), 'exec');
    },
    async write(id, input) {
      expectOk(await ptyRequest('write', id, { input }), 'write');
    },
    async screen(id) {
      const res = await ptyRequest('screen', id);
      expectOk(res, 'screen');
      return { screen: (res.screen as string) ?? '', exited: Boolean(res.exited) };
    },
    async stop(id) {
      await ptyRequest('stop', id).catch(() => undefined);
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface DriveOptions {
  /** Wait after launching ssh before steering / scraping (default 4000ms). */
  initialDelayMs?: number;
  /** Poll cadence for the scrape loop (default 1000ms). */
  pollMs?: number;
  /** Overall scrape deadline (default 90000ms). */
  timeoutMs?: number;
}

interface DriveResult extends ScrapedLogin {
  /** True when the underlying ssh session already exited (login finished or failed). */
  exited: boolean;
  /** The pty session id, so the caller can keep polling / stop it. */
  sessionId: string;
}

/**
 * Drive one remote device-code login: launch `ssh -tt <target> <loginCommand>`
 * in a PTY, send the flow's `deviceCodeSelect` keystrokes (if any) to reach the
 * device-code path, then poll the screen until {@link scrapeLogin} yields both a
 * URL and a code (or the deadline / session-exit). The human completes the code
 * in the browser; the caller polls the credential file for completion. Testable
 * against a fake {@link PtyDriver}.
 */
export async function driveRemoteLogin(
  target: string,
  flow: LoginFlow,
  driver: PtyDriver,
  opts: DriveOptions = {},
  extraSshArgs: string[] = [],
): Promise<DriveResult> {
  const initialDelayMs = opts.initialDelayMs ?? 4000;
  const pollMs = opts.pollMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 90000;

  const id = await driver.start();
  // Everything past start() must tear the session down on a mid-flight throw —
  // otherwise the caller never receives a sessionId and the PTY (and the
  // `ssh -tt` process it drives) leaks until the sidecar's idle reaper. On the
  // normal return paths the caller owns stop() via the returned sessionId.
  try {
    await driver.exec(id, buildRemoteLoginSshCommand(target, flow, extraSshArgs));
    await sleep(initialDelayMs);

    if (flow.deviceCodeSelect) {
      await driver.write(id, flow.deviceCodeSelect);
    }

    const deadline = Date.now() + timeoutMs;
    let last: ScrapedLogin = {};
    for (;;) {
      const { screen, exited } = await driver.screen(id);
      const scraped = scrapeLogin(screen, flow);
      if (scraped.url) last.url = scraped.url;
      if (scraped.code) last.code = scraped.code;
      if (last.url && last.code) return { ...last, exited, sessionId: id };
      if (exited) return { ...last, exited: true, sessionId: id };
      if (Date.now() >= deadline) return { ...last, exited: false, sessionId: id };
      await sleep(pollMs);
    }
  } catch (e) {
    await driver.stop(id).catch(() => {});
    throw e;
  }
}

// ---------------------------------------------------------------------------
// detect / verify (real I/O)
// ---------------------------------------------------------------------------

interface DetectOptions {
  agents?: (AgentId | string)[];
  devices?: string[];
  includeLoggedIn?: boolean;
}

/**
 * Resolve the online fleet devices, then compute pending logins
 * from the shared auth-health cache (populated by `agents fleet ping`). Thin I/O
 * over the pure {@link selectLoginTargets}. Devices/agents can be narrowed by the
 * caller's flags; the default agent set is every agent with a defined flow.
 */
async function detectPending(opts: DetectOptions = {}): Promise<PendingLogin[]> {
  const reg = await loadDevices();
  const self = machineId();
  const online = planFleetTargets(reg)
    .filter((t) => !t.skip && t.device.name !== self)
    .map((t) => t.device);

  const deviceFilter = opts.devices && opts.devices.length > 0 ? new Set(opts.devices) : null;
  const devices = deviceFilter ? online.filter((d) => deviceFilter.has(d.name)) : online;

  const agents = opts.agents && opts.agents.length > 0
    ? opts.agents
    : Object.keys(FLEET_LOGIN_FLOWS);

  const cache = readAuthHealthCache();
  return selectLoginTargets(devices, agents, cache, { includeLoggedIn: opts.includeLoggedIn });
}

/**
 * Best-effort epoch-seconds mtime of a home-relative file on a remote box, or 0
 * when it is absent/unreadable. Used to detect the credential file appearing /
 * bumping after the human completes the browser step. POSIX `stat` only (the
 * device-code agents are all POSIX-fleet).
 */
async function remoteFileMtime(target: string, homeRel: string, extraSshArgs: string[] = []): Promise<number> {
  const cmd = `stat -c %Y "$HOME/${homeRel}" 2>/dev/null || stat -f %m "$HOME/${homeRel}" 2>/dev/null || echo 0`;
  const res = await sshExecAsync(target, cmd, { timeoutMs: 15000, multiplex: true, extraSshArgs }).catch(() => null);
  if (!res || res.code !== 0) return 0;
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Orchestration entry
// ---------------------------------------------------------------------------

interface RunFleetLoginOptions {
  agents?: (AgentId | string)[];
  devices?: string[];
  interactive?: boolean;
  json?: boolean;
  /** Target every device-code pair regardless of cached login state (cold cache / forced re-login). */
  all?: boolean;
  /** Overrides for testing / non-default cadence. */
  driver?: PtyDriver;
  drive?: DriveOptions;
  /** Port for the local dashboard (0 = ephemeral). */
  port?: number;
  /** Open the browser (default true). */
  open?: boolean;
  /** Max wall-clock to wait for all logins before giving up (default 20 min). */
  overallTimeoutMs?: number;
  /** ~15 min device-code TTL used for the countdown. */
  codeTtlMs?: number;
}

const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Orchestrate `agents fleet login`: detect pending -> serve the local dashboard
 * + open the browser -> drive each box's device-code flow (concurrent in bulk,
 * sequential just-in-time in interactive) -> poll the credential file for
 * completion -> print a final matrix. The pure pieces above carry the logic;
 * this wires them to the live fleet.
 */
export async function runFleetLogin(opts: RunFleetLoginOptions = {}): Promise<LoginStatus[]> {
  const pending = await detectPending({ agents: opts.agents, devices: opts.devices, includeLoggedIn: opts.all });
  if (pending.length === 0) return [];

  const mode: LoginMode = opts.interactive ? 'interactive' : 'bulk';
  const codeTtl = opts.codeTtlMs ?? DEVICE_CODE_TTL_MS;
  const key = (device: string, agent: string) => `${device}::${agent}`;

  const statuses = new Map<string, LoginStatus>();
  for (const p of pending) {
    statuses.set(key(p.device, p.agent), {
      device: p.device,
      agent: String(p.agent),
      remotable: p.remotable,
      reason: p.reason,
      state: p.remotable ? 'pending' : 'skipped',
    });
  }

  // Local dashboard server (loopback only; read-only status endpoint).
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
      res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end('method not allowed'); return; }
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildDashboardHtml(pending, mode));
      return;
    }
    if (url === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ statuses: [...statuses.values()] }));
      return;
    }
    res.writeHead(404).end('not found');
  });

  const boundPort: number = await new Promise((resolve) => {
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0));
    });
  });
  const dashUrl = `http://127.0.0.1:${boundPort}/`;
  if (!opts.json) {
    console.log(`Dashboard: ${dashUrl}`);
  }
  if (opts.open !== false) {
    const shown = await showUrl(dashUrl);
    if (shown.via === 'none') {
      console.error('Could not open a browser — open this yourself:');
      console.error(`  ${dashUrl}`);
    }
  }

  const driver = opts.driver ?? defaultPtyDriver();
  const remotable = pending.filter((p) => p.remotable);

  const driveOne = async (p: PendingLogin): Promise<void> => {
    const k = key(p.device, p.agent);
    const st = statuses.get(k)!;
    st.state = 'driving';
    const baseMtime = await remoteFileMtime(p.target, p.flow.successFile, p.extraSshArgs).catch(() => 0);
    let sessionId: string | undefined;
    try {
      const r = await driveRemoteLogin(p.target, p.flow, driver, opts.drive, p.extraSshArgs);
      sessionId = r.sessionId;
      if (r.url && r.code) {
        st.url = r.url; st.code = r.code; st.expiresAt = Date.now() + codeTtl; st.state = 'ready';
      } else {
        st.state = 'error';
        st.detail = r.exited ? 'login process exited before printing a code' : 'timed out scraping the device code';
        if (sessionId) await driver.stop(sessionId);
        return;
      }
    } catch (e) {
      st.state = 'error';
      st.detail = (e as Error).message;
      return;
    }

    // Poll the credential file for the human completing the browser step.
    const codeDeadline = st.expiresAt ?? Date.now() + codeTtl;
    for (;;) {
      if (Date.now() > codeDeadline) { st.state = 'error'; st.detail = 'device code expired before authorization'; break; }
      const mtime = await remoteFileMtime(p.target, p.flow.successFile, p.extraSshArgs).catch(() => 0);
      if (mtime > baseMtime) { st.state = 'authorized'; break; }
      await sleep(3000);
    }
    if (sessionId) await driver.stop(sessionId);
  };

  if (mode === 'interactive') {
    for (const p of remotable) await driveOne(p); // sequential, just-in-time codes
  } else {
    await Promise.all(remotable.map((p) => driveOne(p))); // bulk, concurrent
  }

  server.close();
  return [...statuses.values()];
}
