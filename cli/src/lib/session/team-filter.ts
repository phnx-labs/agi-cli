/**
 * Classification and filtering of team-spawned sessions.
 *
 * Sessions launched by `agents teams` carry an 'sdk-cli' entrypoint and
 * optionally have a meta.json with handle/mode info. This module determines
 * whether a session is team-origin and splits session lists into visible
 * and hidden groups for the picker UI.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionMeta, TeamOrigin } from './types.js';
import { sanitizeForTerminal } from './parse.js';
import { getTeamsAgentsDir } from '../state.js';

const HOME = os.homedir();

// Default path; tests can override via AGENTS_TEAMS_DIR env var.
/** Resolve the directory containing per-session team metadata files. */
function teamsAgentsDir(): string {
  return process.env.AGENTS_TEAMS_DIR ?? getTeamsAgentsDir();
}

/**
 * Determine whether `session` was spawned by `agents teams`.
 *
 * Primary signal is `session.isTeamOrigin`, captured at scan time from the
 * JSONL `entrypoint` field ('sdk-cli' for team spawns, 'cli' for real CLI).
 * When a team meta.json exists we additionally enrich with handle/mode/team and
 * the orchestrator that spawned it — but its absence no longer demotes a
 * session: older team runs whose meta dir was cleaned up still get recognized
 * via the entrypoint flag.
 *
 * Returns the TeamOrigin metadata when the session is team-origin, or null
 * when it is a normal interactive session.
 */
export function classifyTeamSession(session: SessionMeta): TeamOrigin | null {
  const origin = teamOriginIndex().get(session.id);
  if (origin) return origin;

  if (session.isTeamOrigin) {
    return { handle: session.id.slice(0, 8), source: 'entrypoint' };
  }

  return null;
}

/**
 * Parse one teammate `meta.json` into a {@link TeamOrigin}. Degrades to a bare
 * handle when the file is unreadable or malformed — a teammate whose record we
 * can't parse is still a teammate.
 */
function readTeamOrigin(metaPath: string, agentId: string): { origin: TeamOrigin; sessionId?: string } {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      origin: {
        handle: str(meta.name) ?? agentId.slice(0, 8),
        mode: str(meta.mode),
        team: str(meta.task_name),
        parentSessionId: str(meta.parent_session_id),
        startedAt: str(meta.started_at),
        source: 'meta',
      },
      sessionId: str(meta.remote_session_id),
    };
  } catch {
    // An unreadable meta.json still lives under the teams agents dir, so the
    // session IS a teammate — mark the source accordingly, just without fields.
    return { origin: { handle: agentId.slice(0, 8), source: 'meta' } };
  }
}

/**
 * A team name / handle as it is safe to render: a real string, terminal escapes
 * stripped, or undefined.
 *
 * These values reach the row and the preview pane, and for a peer's row they are
 * whatever JSON that machine sent — `parseRemoteList` copies the object through
 * without inspecting its fields, so neither the type nor the content is ours to
 * assume. A non-string `spawnedTeam` used to throw out of `teamBadge`, which runs
 * on every row, taking down the whole listing rather than one entry.
 */
export function safeTeamText(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  return sanitizeForTerminal(value);
}

/** Cached teammate index; the directory is small (teams GC it after 7 days). */
let originIndexCache: Map<string, TeamOrigin> | null = null;

/** Drop the cached teammate index — for tests that rewrite AGENTS_TEAMS_DIR. */
export function _resetTeamOriginIndex(): void {
  originIndexCache = null;
}

/**
 * Every teammate record, keyed by the session ids it can be reached under.
 *
 * A teammate's directory name is its **agent id**, which is only sometimes the
 * id of the transcript it produced: the harness mints its own session id, and
 * the spawn records it separately as `remote_session_id`. Keying the lookup on
 * the directory name alone therefore missed most teammates — on a live box, 14
 * of 16 records were reachable only by `remote_session_id` — so a teammate row
 * could not name its team however good the record was. Both keys are registered.
 *
 * Read once per process rather than per row: the old per-session `existsSync` +
 * `readFileSync` cost a pair of syscalls for every row in the pool, which the
 * interactive browser re-pays on each hotkey.
 */
function teamOriginIndex(): Map<string, TeamOrigin> {
  if (originIndexCache) return originIndexCache;

  const dir = teamsAgentsDir();
  const index = new Map<string, TeamOrigin>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  for (const agentId of entries) {
    const metaPath = path.join(dir, agentId, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    const { origin, sessionId } = readTeamOrigin(metaPath, agentId);
    index.set(agentId, origin);
    if (sessionId) index.set(sessionId, origin);
  }

  originIndexCache = index;
  return index;
}

/**
 * Attach `teamOrigin` to every team-spawned row in `sessions`, from the shared
 * teammate index rather than a stat per row.
 */
export function enrichTeamOrigins(sessions: SessionMeta[]): SessionMeta[] {
  const index = teamOriginIndex();

  return sessions.map((session) => {
    // A peer's rows are classified on the peer (its meta.json is on its disk, not
    // ours) and ride across in the --json fan-out already populated. Re-deriving
    // here would find no local record and downgrade a named teammate to a bare id.
    if (session.teamOrigin) return session;

    const origin =
      index.get(session.id) ??
      (session.isTeamOrigin ? { handle: session.id.slice(0, 8), source: 'entrypoint' as const } : null);
    return origin ? { ...session, teamOrigin: origin } : session;
  });
}

/** Result of splitting sessions into visible and hidden (team-origin) groups. */
interface FilterResult {
  visible: SessionMeta[];
  hiddenCount: number;
}

/**
 * Whether a listing scope must retain team-origin sessions.
 *
 * A routine owns every session produced during its run, including teammates and
 * SDK-launched children. Requiring callers to add `--teams` would make a routine
 * catalog incomplete and can make team-heavy routines appear to have no runs.
 */
export function shouldShowTeamSessions(filters: {
  teams?: boolean;
  routine?: boolean | string;
}): boolean {
  return !!filters.teams || !!filters.routine;
}

/**
 * Split `sessions` into visible and hidden (team-origin) groups.
 * When `showTeams` is true every session is visible and `teamOrigin` is
 * populated on team sessions for display. When false, team sessions are
 * excluded and counted in `hiddenCount`.
 */
export function filterTeamSessions(
  sessions: SessionMeta[],
  showTeams: boolean,
): FilterResult {
  let hiddenCount = 0;
  const visible: SessionMeta[] = [];

  for (const session of sessions) {
    const origin = classifyTeamSession(session);
    if (origin !== null) {
      if (showTeams) {
        visible.push({ ...session, teamOrigin: origin });
      } else {
        hiddenCount++;
      }
    } else {
      visible.push(session);
    }
  }

  return { visible, hiddenCount };
}

/**
 * Whether a team-origin session is a real `agents teams` teammate or a bare SDK
 * spawn with no teammate record. The two share the `sdk-cli` entrypoint that
 * sets `isTeamOrigin`, so they are told apart by whether a `meta.json` teammate
 * record backs the origin ({@link TeamOrigin.source} === `'meta'`).
 *
 * `source` is newer than the rest of {@link TeamOrigin}, so a row that arrived
 * from a pre-`source` peer over the `--device` fan-out carries none. There the
 * meta-only fields settle it: the entrypoint fallback is a bare `{ handle }`, so
 * any `team` / `mode` / `parentSessionId` / `startedAt` means a real teammate
 * record produced it — otherwise a genuine teammate from an unupgraded peer
 * would be misfiled into the no-team bucket, the exact conflation this splits.
 */
export function teamRowKind(origin: TeamOrigin | undefined): 'teammate' | 'subagent' {
  if (!origin) return 'subagent';
  if (origin.source === 'meta') return 'teammate';
  if (origin.source === 'entrypoint') return 'subagent';
  return origin.team || origin.mode || origin.parentSessionId || origin.startedAt
    ? 'teammate'
    : 'subagent';
}

/** A team-origin session with its resolved {@link TeamOrigin} guaranteed present. */
type TeamSession = SessionMeta & { teamOrigin: TeamOrigin };

/**
 * Key/label for the residual bucket — sessions flagged `isTeamOrigin` (an SDK /
 * `sdk-cli` entrypoint) that carry no teammate `meta.json`. In practice this is
 * headless `agents run` spawns and teammates whose team record aged out; a true
 * `Task` sub-agent's transcript is never indexed, so it cannot land here. Named
 * "(no team)" rather than "(sub-agents)" so the label matches what it holds.
 */
export const NO_TEAM_GROUP_KEY = '(no team)';
/** Key/label for teammates whose record carries no team name (`task_name`). */
export const UNNAMED_TEAM_KEY = '(unnamed team)';

/** One team's sessions, grouped for the `agents sessions --teams` view. */
export interface TeamSessionGroup {
  /**
   * The grouping key: the team name, {@link UNNAMED_TEAM_KEY} for teammates that
   * carry no `task_name`, or {@link NO_TEAM_GROUP_KEY} for the residual bucket.
   */
  key: string;
  /** A named team of `agents teams` teammates vs the catch-all no-team bucket. */
  kind: 'team' | 'noTeam';
  /** Team name when this is a named team, else undefined. */
  team?: string;
  /**
   * The orchestrator session id that spawned this team (`parent_session_id`),
   * when every teammate agrees on one. Undefined for the no-team bucket, an
   * unparented team, or a group whose teammates disagree.
   */
  spawnerSessionId?: string;
  /** The team's rows, newest-active first. */
  sessions: TeamSession[];
  /** Most-recent activity across the group, for ordering groups. */
  maxTs: string;
  /** Earliest spawn time across the group (`started_at`, else `timestamp`). */
  firstSpawnTs: string;
}

/** Recency signal for a row: last activity, else the creation timestamp. */
function rowTs(s: SessionMeta): string {
  return s.lastActivity ?? s.timestamp;
}

/** Spawn time for a row: the meta `started_at`, else the transcript creation time. */
function spawnTs(s: TeamSession): string {
  return s.teamOrigin.startedAt ?? s.timestamp;
}

/**
 * Group team-origin sessions for the `--teams` view: each named team becomes one
 * group of its teammates, and every bare SDK spawn with no teammate record falls
 * into a single trailing {@link NO_TEAM_GROUP_KEY} bucket, so a real teammate and
 * a bare spawn are never shown as the same thing.
 *
 * Only rows with a resolved {@link TeamOrigin} participate (the caller has
 * already run {@link filterTeamSessions}); any non-team session is ignored.
 * Groups are ordered newest-active first; sub-agents always sort last. Pure —
 * unit-tested.
 */
export function groupSessionsByTeam(sessions: SessionMeta[]): TeamSessionGroup[] {
  const byKey = new Map<string, TeamSession[]>();
  for (const s of sessions) {
    if (!s.teamOrigin) continue;
    const kind = teamRowKind(s.teamOrigin);
    const key =
      kind === 'subagent'
        ? NO_TEAM_GROUP_KEY
        : safeTeamText(s.teamOrigin.team) ?? UNNAMED_TEAM_KEY;
    const ts = s as TeamSession;
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(ts);
  }

  const groups: TeamSessionGroup[] = [];
  for (const [key, rows] of byKey) {
    rows.sort((a, b) => (rowTs(a) < rowTs(b) ? 1 : rowTs(a) > rowTs(b) ? -1 : 0));
    const kind = key === NO_TEAM_GROUP_KEY ? 'noTeam' : 'team';
    // A single agreed-on spawner names the orchestrator for the whole team; a
    // mix (or none) leaves it unset rather than claiming a wrong parent.
    const parents = new Set(
      rows.map((r) => r.teamOrigin.parentSessionId).filter((p): p is string => !!p),
    );
    groups.push({
      key,
      kind,
      team: kind === 'team' && key !== UNNAMED_TEAM_KEY ? key : undefined,
      spawnerSessionId: parents.size === 1 ? [...parents][0] : undefined,
      sessions: rows,
      maxTs: rowTs(rows[0]),
      firstSpawnTs: rows.map(spawnTs).sort()[0],
    });
  }

  // Newest-active team first; the no-team bucket always sinks to the bottom.
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'noTeam' ? 1 : -1;
    return a.maxTs < b.maxTs ? 1 : a.maxTs > b.maxTs ? -1 : a.key.localeCompare(b.key);
  });
  return groups;
}
