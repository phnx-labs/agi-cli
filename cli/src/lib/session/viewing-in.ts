
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

interface ViewingIn {
  app: string;
  tab?: number;
}

export function viewingInLabel(
  s: Pick<ActiveSession, 'provenance' | 'viewingIn' | 'tmuxTarget'>,
): string | undefined {
  if (s.provenance?.mux?.kind !== 'tmux' || !s.provenance.mux.pane) return undefined;
  if (!s.viewingIn) return s.tmuxTarget ? 'detached' : undefined;
  return s.viewingIn.tab != null ? `${s.viewingIn.app} tab ${s.viewingIn.tab}` : s.viewingIn.app;
}

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

export interface ViewingInDeps {
  ghosttySurfaces?: GhosttySurface[];
  paneToTarget?: Map<string, string>;
  resolveApp?: (pid: number) => Promise<string | undefined>;
  readClientEnv?: (pid: number) => Promise<Record<string, string> | undefined>;
  tabIndexForSession?: (sessionId: string | undefined) => number | undefined;
}

const EDITOR_APPS = new Set(['code', 'cursor', 'codium', 'windsurf']);

function sessionNameFor(session: ActiveSession, paneToTarget?: Map<string, string>): string | undefined {
  const pane = session.provenance?.mux?.pane;
  const target = (pane && paneToTarget?.get(pane)) ?? session.tmuxTarget;
  if (!target) return undefined;
  const name = target.split(':')[0];
  return name || undefined;
}

export async function resolveViewingIn(
  session: ActiveSession,
  clients: TmuxClient[],
  deps: ViewingInDeps = {},
): Promise<ViewingIn | undefined> {
  if (session.provenance?.mux?.kind !== 'tmux' || !session.provenance.mux.pane) return undefined;
  const sessName = sessionNameFor(session, deps.paneToTarget);
  if (!sessName) return undefined;

  const attached = clients.filter((c) => c.target.split(':')[0] === sessName);
  if (attached.length === 0) return undefined;

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

async function ghosttyTab(session: ActiveSession, surfaces?: GhosttySurface[]): Promise<number | undefined> {
  const s = surfaces ?? (await enumerateGhosttyTabs());
  if (s.length === 0) return undefined;
  const probe = { ...session, host: 'ghostty' } as ActiveSession;
  return assignGhosttyTabs([probe], s).get(probe);
}

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
      const m = stdout.match(/(?:^|\s)ITERM_SESSION_ID=(\S+)/);
      return m ? { ITERM_SESSION_ID: m[1] } : {};
    } catch {
      return undefined;
    }
  }
  return undefined;
}

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
