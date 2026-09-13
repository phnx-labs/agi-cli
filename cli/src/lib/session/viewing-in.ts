/**
 * "Viewing in <app> tab N" for tmux-hosted agent sessions.
 *
 * A tmux-wrapped agent (see src/lib/exec.ts `runInTmux`) runs detached on the
 * shared socket; a terminal only *displays* it while a client is attached. This
 * resolver answers "which app + tab is looking at this session right now" by
 * matching the session to its attached tmux client(s) and reusing the app/tab
 * resolvers we already have:
 *
 *   - app  — the client's terminal PID walked up the process ancestry via the
 *            shared HOST_MATCHERS logic (`hostFromPid`).
 *   - tab  — per app: Ghostty via `assignGhosttyTabs` (cwd + title match), iTerm
 *            via the `t<n>` field of the client's `$ITERM_SESSION_ID`, and
 *            VS Code / Cursor / Codium via the extension-published `tabIndex` in
 *            live-terminals.json (keyed by session id).
 *
 * No client attached => `undefined` (the session is running detached). Every
 * lookup is best-effort; a miss degrades to `{ app }` with no tab, never throws.
 */

import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import type { TmuxClient } from '../tmux/session.js';
import type { ActiveSession } from './active.js';
import { hostFromPid } from './active.js';
import { enumerateGhosttyTabs, assignGhosttyTabs, type GhosttySurface } from './ghostty-tabs.js';
import { getTerminalsDir } from '../state.js';

const execFileAsync = promisify(execFile);

/** Where a tmux-hosted session is currently displayed. */
interface ViewingIn {
  /** Host app of the attached client — 'ghostty', 'iterm', 'code', 'codium', … */
  app: string;
  /** 1-based tab number within that app, when it can be resolved. */
  tab?: number;
}

/**
 * The one display form of "where is this session being watched" — `'codium tab 3'`
 * when a client is attached, the bare app name when the tab can't be resolved, and
 * `'detached'` when the pane is live but nobody is looking at it (the terminal that
 * displayed it was closed or crashed).
 *
 * `undefined` means **we do not know**, and it covers two different situations that
 * must not be confused with `'detached'`: a session that isn't tmux-hosted (no pane
 * to attach to, so it isn't on this axis at all), and a tmux session whose pane the
 * locator could not resolve (`mapPanesToTargets` returned nothing for this socket,
 * or the row was never enriched). {@link resolveViewingIn} answers `undefined` for
 * BOTH "no client attached" and "could not locate the pane", so the pane's resolved
 * `tmuxTarget` is what separates them: without it there is no evidence of absence,
 * only absence of evidence. Claiming `'detached'` there would invent an orphaned
 * session — and a consumer acts on that claim (the ext's picker pre-ticks every
 * detached row for rescue), so the wrong answer resumes a session nobody asked for.
 *
 * Shared by the `--active` row renderer and the `--json` serializer so a machine
 * consumer reads exactly the string a human sees, instead of re-deriving "detached"
 * from an absent field.
 */
export function viewingInLabel(
  s: Pick<ActiveSession, 'provenance' | 'viewingIn' | 'tmuxTarget'>,
): string | undefined {
  if (s.provenance?.mux?.kind !== 'tmux' || !s.provenance.mux.pane) return undefined;
  if (!s.viewingIn) return s.tmuxTarget ? 'detached' : undefined;
  return s.viewingIn.tab != null ? `${s.viewingIn.app} tab ${s.viewingIn.tab}` : s.viewingIn.app;
}

/**
 * Wire form -> internal form for a row arriving from another machine's
 * `--active --json`. The fan-out reaches peers whose CLI may predate
 * {@link viewingInLabel} and still emit the `{app, tab}` object, so this boundary
 * normalizes both shapes into one — the ONLY place either shape is accepted.
 * `'detached'` maps to undefined, which is what "no attached client" means
 * internally; {@link viewingInLabel} regenerates the word from the pane.
 */
export function parseViewingIn(raw: unknown): ViewingIn | undefined {
  if (raw && typeof raw === 'object') {
    const app = (raw as ViewingIn).app;
    const tab = (raw as ViewingIn).tab;
    return typeof app === 'string' ? { app, tab: typeof tab === 'number' ? tab : undefined } : undefined;
  }
  if (typeof raw !== 'string' || !raw || raw === 'detached') return undefined;
  const m = raw.match(/^(.+?) tab (\d+)$/);
  return m ? { app: m[1], tab: parseInt(m[2], 10) } : { app: raw };
}

/** Injection seams so `resolveViewingIn` is unit-testable without a live tmux/ps/osascript. */
export interface ViewingInDeps {
  /** Ghostty surfaces (window/tab/cwd/title). Enumerated once by the caller and shared. */
  ghosttySurfaces?: GhosttySurface[];
  /** pane id -> `session:window.pane`, from `mapPanesToTargets`. Used to find the session name. */
  paneToTarget?: Map<string, string>;
  /** client pid -> host app. Defaults to the real `hostFromPid`. */
  resolveApp?: (pid: number) => Promise<string | undefined>;
  /** client pid -> raw env. Defaults to reading /proc (Linux) or `ps eww` (macOS). */
  readClientEnv?: (pid: number) => Promise<Record<string, string> | undefined>;
  /** session id -> VS Code editor-tab index, from live-terminals.json. Defaults to the real read. */
  tabIndexForSession?: (sessionId: string | undefined) => number | undefined;
}

/** Apps whose tab index is published by the extension via live-terminals.json. */
const EDITOR_APPS = new Set(['code', 'cursor', 'codium', 'windsurf']);

/** The tmux session name a session's pane belongs to, from `session:window.pane`. */
function sessionNameFor(session: ActiveSession, paneToTarget?: Map<string, string>): string | undefined {
  const pane = session.provenance?.mux?.pane;
  const target = (pane && paneToTarget?.get(pane)) ?? session.tmuxTarget;
  if (!target) return undefined;
  const name = target.split(':')[0];
  return name || undefined;
}

/**
 * Resolve where a single tmux-hosted session is being viewed. Returns undefined
 * when the session isn't tmux-hosted, can't be located, or has no client
 * attached (detached). Pure aside from the injected (defaulted) probes.
 */
export async function resolveViewingIn(
  session: ActiveSession,
  clients: TmuxClient[],
  deps: ViewingInDeps = {},
): Promise<ViewingIn | undefined> {
  if (session.provenance?.mux?.kind !== 'tmux' || !session.provenance.mux.pane) return undefined;
  const sessName = sessionNameFor(session, deps.paneToTarget);
  if (!sessName) return undefined;

  const attached = clients.filter((c) => c.target.split(':')[0] === sessName);
  if (attached.length === 0) return undefined; // running detached — no viewer

  const client = attached[0];
  const resolveApp = deps.resolveApp ?? hostFromPid;
  const app = (await resolveApp(client.pid)) ?? 'terminal';

  let tab: number | undefined;
  if (app === 'ghostty') {
    tab = await ghosttyTab(session, deps.ghosttySurfaces);
  } else if (app === 'iterm') {
    tab = await itermTab(client.pid, deps.readClientEnv ?? readClientEnv);
  } else if (EDITOR_APPS.has(app)) {
    const lookup = deps.tabIndexForSession ?? tabIndexFromLiveTerminals;
    tab = lookup(session.sessionId);
  }
  return { app, tab };
}

/** Ghostty tab via the existing cwd+title matcher, reusing shared surfaces when provided. */
async function ghosttyTab(session: ActiveSession, surfaces?: GhosttySurface[]): Promise<number | undefined> {
  const s = surfaces ?? (await enumerateGhosttyTabs());
  if (s.length === 0) return undefined;
  // assignGhosttyTabs only considers host === 'ghostty' sessions; use a probe
  // clone so we don't mutate the real row's host.
  const probe = { ...session, host: 'ghostty' } as ActiveSession;
  return assignGhosttyTabs([probe], s).get(probe);
}

/**
 * iTerm tab from the attaching client's `$ITERM_SESSION_ID` (`w<n>t<n>p<n>:UUID`).
 * The `t<n>` field is iTerm2's 0-based tab index; we present it 1-based to match
 * Ghostty's `index of tab`. Exported for the parser test.
 */
export function itermTabFromSessionId(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(/t(\d+)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n + 1 : undefined;
}

async function itermTab(
  pid: number,
  readEnv: (pid: number) => Promise<Record<string, string> | undefined>,
): Promise<number | undefined> {
  const env = await readEnv(pid);
  return itermTabFromSessionId(env?.ITERM_SESSION_ID);
}

/** Read a process's env (best-effort): /proc on Linux, `ps eww` on macOS. */
async function readClientEnv(pid: number): Promise<Record<string, string> | undefined> {
  if (process.platform === 'linux') {
    try {
      const buf = await readFile(`/proc/${pid}/environ`, 'utf8');
      const env: Record<string, string> = {};
      for (const pair of buf.split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      return env;
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      // ITERM_SESSION_ID is a single token (no spaces): grab it out of the flat line.
      const m = stdout.match(/(?:^|\s)ITERM_SESSION_ID=(\S+)/);
      return m ? { ITERM_SESSION_ID: m[1] } : {};
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * VS Code editor-tab index for a session, from the extension's live-terminals.json
 * (`tabIndex` per entry — the DATA CONTRACT with the extension teammate). Read
 * directly (not via active.ts's readLiveTerminals, which strips tabIndex).
 */
function tabIndexFromLiveTerminals(sessionId: string | undefined): number | undefined {
  if (!sessionId) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(getTerminalsDir(), 'live-terminals.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  for (const slice of Object.values(parsed) as any[]) {
    for (const e of (slice?.entries ?? []) as any[]) {
      if (e?.sessionId === sessionId && typeof e.tabIndex === 'number') return e.tabIndex;
    }
  }
  return undefined;
}
