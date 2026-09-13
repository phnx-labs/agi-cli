import Database from '../sqlite.js';
import { getSessionsDbPath } from '../state.js';
import { topNamesByKind, kindMix } from './usage-db.js';

/** Time window for mix recipes under `agents insights mix`. */
export interface AnalyticsWindow {
  days: number;
  sinceIso: string;
}

export interface RecipeSection {
  id: string;
  title: string;
  store: 'sessions' | 'usage';
  rows: Array<Record<string, string | number | null>>;
  empty?: boolean;
}

export function analyticsWindow(days: number): AnalyticsWindow {
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  const since = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  return { days: d, sinceIso: since.toISOString() };
}

/** @deprecated Use analyticsWindow. */
export const trendsWindow = analyticsWindow;

function openSessions(): Database.Database | null {
  try {
    const db = new Database(getSessionsDbPath());
    db.pragma('busy_timeout = 2000');
    return db;
  } catch {
    return null;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

export function recipeHarnessMix(win: AnalyticsWindow): RecipeSection {
  const db = openSessions();
  const id = 'harness-mix';
  const title = 'Harness mix';
  if (!db) return { id, title, store: 'sessions', rows: [], empty: true };
  try {
    const rows = db.prepare(
      `SELECT agent AS name, COUNT(*) AS n
         FROM sessions WHERE timestamp >= ?
         GROUP BY agent ORDER BY n DESC`,
    ).all(win.sinceIso) as Array<{ name: string; n: number }>;
    return {
      id,
      title,
      store: 'sessions',
      rows: rows.map((r) => ({ harness: r.name, sessions: r.n })),
      empty: rows.length === 0,
    };
  } catch {
    return { id, title, store: 'sessions', rows: [], empty: true };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function recipeModelMix(win: AnalyticsWindow): RecipeSection {
  const db = openSessions();
  const id = 'model-mix';
  const title = 'Model mix';
  if (!db) return { id, title, store: 'sessions', rows: [], empty: true };
  try {
    const rows = db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(model), ''), '(unrecorded)') AS name, COUNT(*) AS n
         FROM sessions WHERE timestamp >= ?
         GROUP BY 1 ORDER BY n DESC LIMIT 25`,
    ).all(win.sinceIso) as Array<{ name: string; n: number }>;
    return {
      id,
      title,
      store: 'sessions',
      rows: rows.map((r) => ({ model: r.name, sessions: r.n })),
      empty: rows.length === 0,
    };
  } catch {
    return { id, title, store: 'sessions', rows: [], empty: true };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export function recipeToolsPerSession(win: AnalyticsWindow): RecipeSection {
  const db = openSessions();
  const id = 'tools-per-session';
  const title = 'Tools per session';
  if (!db) return { id, title, store: 'sessions', rows: [], empty: true };
  try {
    // Counts come from tool_scan_ledger — one row per session the tool indexer
    // has scanned, carrying that session's true call_count (0 included). The
    // sessions.tool_call_count column is NOT the source: only the teams
    // summarizer ever writes it (lib/teams/summarizer.ts), so reading it scored
    // every non-teams session as 0 and pinned p50 at 0 fleet-wide.
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_scan_ledger'`,
    ).all() as Array<{ name: string }>;
    if (tables.length === 0) {
      return { id, title, store: 'sessions', rows: [], empty: true };
    }
    const byAgent = db.prepare(
      `SELECT s.agent AS agent, l.call_count AS n
         FROM tool_scan_ledger l
         JOIN sessions s ON s.id = l.session_id
        WHERE s.timestamp >= ?`,
    ).all(win.sinceIso) as Array<{ agent: string; n: number }>;
    if (byAgent.length === 0) return { id, title, store: 'sessions', rows: [], empty: true };

    const groups = new Map<string, number[]>();
    const all: number[] = [];
    for (const r of byAgent) {
      all.push(r.n);
      const list = groups.get(r.agent) ?? [];
      list.push(r.n);
      groups.set(r.agent, list);
    }
    const roll = (label: string, vals: number[]) => {
      const sorted = [...vals].sort((a, b) => a - b);
      const sum = sorted.reduce((a, b) => a + b, 0);
      return {
        scope: label,
        n: sorted.length,
        avg: Math.round(sum / sorted.length),
        p50: Math.round(percentile(sorted, 50)),
        p99: Math.round(percentile(sorted, 99)),
      };
    };
    const rows: Array<Record<string, string | number | null>> = [roll('(all)', all)];
    for (const [agent, vals] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
      rows.push(roll(agent, vals));
    }
    return { id, title, store: 'sessions', rows, empty: false };
  } catch {
    return { id, title, store: 'sessions', rows: [], empty: true };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function recipeTokenRatio(win: AnalyticsWindow): RecipeSection {
  const db = openSessions();
  const id = 'token-ratio';
  const title = 'Token read→write ratio';
  if (!db) return { id, title, store: 'sessions', rows: [], empty: true };
  try {
    const rows = db.prepare(
      `SELECT agent,
              COUNT(*) AS sessions,
              IFNULL(SUM(token_count), 0) AS tokenIn,
              IFNULL(SUM(output_tokens), 0) AS tokenOut
         FROM sessions
        WHERE timestamp >= ?
          AND (token_count IS NOT NULL OR output_tokens IS NOT NULL)
        GROUP BY agent
        ORDER BY sessions DESC`,
    ).all(win.sinceIso) as Array<{ agent: string; sessions: number; tokenIn: number; tokenOut: number }>;
    if (rows.length === 0) return { id, title, store: 'sessions', rows: [], empty: true };
    const totalIn = rows.reduce((a, r) => a + r.tokenIn, 0);
    const totalOut = rows.reduce((a, r) => a + r.tokenOut, 0);
    const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
    const fmt = (inn: number, out: number) => (out > 0 ? (inn / out).toFixed(2) : out === 0 && inn > 0 ? '∞' : '—');
    const outRows: Array<Record<string, string | number | null>> = [{
      scope: '(all)',
      sessions: totalSessions,
      token_in: totalIn,
      token_out: totalOut,
      ratio: fmt(totalIn, totalOut),
      avg_in: totalSessions ? Math.round(totalIn / totalSessions) : 0,
      avg_out: totalSessions ? Math.round(totalOut / totalSessions) : 0,
    }];
    for (const r of rows) {
      outRows.push({
        scope: r.agent,
        sessions: r.sessions,
        token_in: r.tokenIn,
        token_out: r.tokenOut,
        ratio: fmt(r.tokenIn, r.tokenOut),
        avg_in: Math.round(r.tokenIn / r.sessions),
        avg_out: Math.round(r.tokenOut / r.sessions),
      });
    }
    return { id, title, store: 'sessions', rows: outRows, empty: false };
  } catch {
    return { id, title, store: 'sessions', rows: [], empty: true };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function recipeSessionVolume(win: AnalyticsWindow): RecipeSection {
  const db = openSessions();
  const id = 'session-volume';
  const title = 'Session volume';
  if (!db) return { id, title, store: 'sessions', rows: [], empty: true };
  try {
    const rows = db.prepare(
      `SELECT COALESCE(NULLIF(TRIM(machine), ''), '(unknown)') AS machine,
              COUNT(*) AS sessions,
              IFNULL(SUM(duration_ms), 0) AS durationMs
         FROM sessions WHERE timestamp >= ?
         GROUP BY 1 ORDER BY sessions DESC`,
    ).all(win.sinceIso) as Array<{ machine: string; sessions: number; durationMs: number }>;
    return {
      id,
      title,
      store: 'sessions',
      rows: rows.map((r) => ({
        machine: r.machine,
        sessions: r.sessions,
        duration_min: Math.round(r.durationMs / 60000),
      })),
      empty: rows.length === 0,
    };
  } catch {
    return { id, title, store: 'sessions', rows: [], empty: true };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function recipeSecretsHot(win: AnalyticsWindow): RecipeSection {
  const id = 'secrets-hot';
  const title = 'Hottest secrets';
  const rows = topNamesByKind('secret', win.sinceIso, 15);
  return {
    id,
    title,
    store: 'usage',
    rows: rows.map((r) => ({ bundle: r.name, accesses: r.n, last: r.last })),
    empty: rows.length === 0,
  };
}

function recipeBrowserActivity(win: AnalyticsWindow): RecipeSection {
  const id = 'browser-activity';
  const title = 'Browser activity';
  const rows = topNamesByKind('browser', win.sinceIso, 15);
  return {
    id,
    title,
    store: 'usage',
    rows: rows.map((r) => ({ profile: r.name, events: r.n, last: r.last })),
    empty: rows.length === 0,
  };
}

function recipeResourceMix(win: AnalyticsWindow): RecipeSection {
  const id = 'resource-mix';
  const title = 'Resource usage mix';
  const rows = kindMix(win.sinceIso);
  return {
    id,
    title,
    store: 'usage',
    rows: rows.map((r) => ({ kind: r.kind, events: r.n })),
    empty: rows.length < 2,
  };
}

export type RecipeId =
  | 'harness-mix'
  | 'model-mix'
  | 'tools-per-session'
  | 'token-ratio'
  | 'session-volume'
  | 'secrets-hot'
  | 'browser-activity'
  | 'resource-mix';

export const RECIPE_IDS: readonly RecipeId[] = [
  'harness-mix',
  'model-mix',
  'tools-per-session',
  'token-ratio',
  'session-volume',
  'secrets-hot',
  'browser-activity',
  'resource-mix',
] as const;

const RUNNERS: Record<RecipeId, (win: AnalyticsWindow) => RecipeSection> = {
  'harness-mix': recipeHarnessMix,
  'model-mix': recipeModelMix,
  'tools-per-session': recipeToolsPerSession,
  'token-ratio': recipeTokenRatio,
  'session-volume': recipeSessionVolume,
  'secrets-hot': recipeSecretsHot,
  'browser-activity': recipeBrowserActivity,
  'resource-mix': recipeResourceMix,
};

export function runRecipe(id: RecipeId, win: AnalyticsWindow): RecipeSection {
  return RUNNERS[id](win);
}

export function listRecipes(): Array<{ id: RecipeId; title: string; store: 'sessions' | 'usage' }> {
  const win = analyticsWindow(7);
  return RECIPE_IDS.map((id) => {
    const s = RUNNERS[id](win);
    return { id, title: s.title, store: s.store };
  });
}
