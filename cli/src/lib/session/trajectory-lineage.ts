/**
 * Team lineage for `agents sessions trace <parent> --tree` — the third and last
 * layout of the trace surface (PR3/3), after the single trajectory and the
 * two-session compare.
 *
 * A lineage is the delegation graph of an orchestrator and the sessions it
 * spawned. The edges are not invented here: they already exist in the session
 * index as `teamOrigin.parentSessionId` (the orchestrator recorded in a
 * teammate's `meta.json`, `team-filter.ts:151`), with a second pass over
 * `groupSessionsByTeam`'s agreed-on `spawnerSessionId` (`team-filter.ts:317`)
 * for teammates whose own record carries no parent. This module only resolves
 * and orders them.
 *
 * **A node is a SESSION, never an inline sub-agent.** A `Task`/`Agent` tool call
 * is a step inside ONE transcript (`trajectory.ts` marks it
 * `delegation: 'inline-task'`) and produces no session row, so it can never
 * become a node here — the graph is built strictly from `SessionMeta` rows that
 * `discoverSessions` returned.
 *
 * Pure and framework-free like `trajectory.ts` / `trajectory-compare.ts`: it
 * takes session metadata (no transcript parsing, no clock of its own — `now` is
 * an option) and returns a plain object the HTML/text/JSON renderers project.
 */
import { enrichTeamOrigins, groupSessionsByTeam, teamRowKind } from './team-filter.js';
import type { SessionMeta } from './types.js';

/**
 * What a node is in the graph, decided from real signals only:
 *   - `orchestrator` — it spawned at least one other session in this graph.
 *   - `teammate`     — an `agents teams` teammate (a `meta.json` record backs it).
 *   - `subagent`     — an SDK/`sdk-cli` spawn with no teammate record.
 *   - `session`      — an ordinary session: no children, not team-spawned.
 */
export type LineageRole = 'orchestrator' | 'teammate' | 'subagent' | 'session';

/**
 * How recently the node's session did anything, relative to `now`. This is a
 * RECENCY signal, not a verdict: nothing on `SessionMeta` records whether the
 * work succeeded, so the graph never claims "merged" or "crashed". A node that
 * opened a PR carries {@link LineageNode.prNumber}, which is a fact.
 */
export type LineageActivity = 'active' | 'idle' | 'stale';

/** One session in the lineage graph. */
export interface LineageNode {
  session: SessionMeta;
  id: string;
  shortId: string;
  agent: string;
  /** Teammate handle from its team record, when it has one. */
  handle?: string;
  /** Team name (`task_name`) from its team record, when it has one. */
  team?: string;
  /** Teammate launch mode (plan/edit/auto/skip) from its team record. */
  mode?: string;
  role: LineageRole;
  /** Hops from the root: 0 for the root itself. */
  depth: number;
  /** Indexed tool calls (`SessionMeta.toolCallCount`), 0 when unrecorded. */
  toolCount: number;
  /** Wall-clock span in ms (`SessionMeta.durationMs`), 0 when unrecorded. */
  durationMs: number;
  activity: LineageActivity;
  /** PR the session opened, when it opened one. */
  prNumber?: number;
  /** How many children this node has in this graph. */
  childCount: number;
}

/** A parent → child delegation edge, and which record established it. */
export interface LineageEdge {
  parent: string;
  child: string;
  /**
   * `parentSessionId` — the child's own team record named this orchestrator.
   * `teamSpawner`     — the child's record named none, but its whole team agreed
   *                     on one spawner (`groupSessionsByTeam.spawnerSessionId`).
   */
  source: 'parentSessionId' | 'teamSpawner';
}

/** The resolved delegation graph rooted at one session. */
export interface SessionLineage {
  rootId: string;
  /** The root first, then breadth-first; siblings ordered by spawn time. */
  nodes: LineageNode[];
  edges: LineageEdge[];
  /** Distinct team names across the graph, for the header line. */
  teams: string[];
  /**
   * Parent session ids a node pointed at that are not in the pool (the
   * orchestrator's transcript was never indexed, or the scan window cut it off).
   * Surfaced rather than dropped so a missing edge is never silent.
   */
  unresolvedParentIds: string[];
}

interface BuildLineageOptions {
  /**
   * Which session the graph is about. The graph is always rooted at that
   * session's TOPMOST ancestor in the pool, so passing a child still renders its
   * whole team. Defaults to the first session in `sessions`.
   */
  rootId?: string;
  /** Epoch ms used to classify {@link LineageActivity}. Defaults to `Date.now()`. */
  now?: number;
  /** Last activity within this many ms is `active`. Default 5 minutes. */
  activeWithinMs?: number;
  /** Last activity within this many ms is `idle`; older is `stale`. Default 24 hours. */
  idleWithinMs?: number;
}

const DEFAULT_ACTIVE_WITHIN_MS = 5 * 60_000;
const DEFAULT_IDLE_WITHIN_MS = 24 * 60 * 60_000;

/** Recency signal for a row: last activity, else the creation timestamp. */
function rowTs(session: SessionMeta): string {
  return session.lastActivity ?? session.timestamp;
}

/** Spawn time for ordering siblings: the team record's `started_at`, else creation. */
function spawnTs(session: SessionMeta): string {
  return session.teamOrigin?.startedAt ?? session.timestamp;
}

function classifyActivity(session: SessionMeta, now: number, activeWithin: number, idleWithin: number): LineageActivity {
  const ts = new Date(rowTs(session)).getTime();
  if (Number.isNaN(ts)) return 'stale';
  const age = now - ts;
  if (age <= activeWithin) return 'active';
  if (age <= idleWithin) return 'idle';
  return 'stale';
}

/**
 * How far outside a run's own spawn window a parentless teammate may still be
 * adopted by that run's spawner.
 *
 * `groupSessionsByTeam` buckets by team NAME alone (`team-filter.ts:292`), and
 * `--tree` scans the pool all-time, so two separate runs of a team called
 * `fleet-resume` land in one group — without a window, the older run's
 * parentless teammates get adopted by the newer run's orchestrator and render as
 * its children. A teams run spawns its teammates within minutes of each other,
 * so an hour is generous for the first or last of them and still far tighter
 * than the all-time scan that caused the misattribution.
 */
const SPAWNER_ADOPTION_SLACK_MS = 60 * 60_000;

function spawnMs(session: SessionMeta): number {
  return new Date(spawnTs(session)).getTime();
}

/**
 * Resolve every parent → child edge the session index knows about.
 *
 * Two passes, in priority order: a teammate's own `parentSessionId` wins, and
 * only a teammate that carries none inherits its team's agreed-on spawner —
 * and then only if it was spawned inside that run's own window (see
 * {@link SPAWNER_ADOPTION_SLACK_MS}). A self-edge (a record naming its own
 * session) is dropped: it would make the root its own child and hang the walk.
 */
function resolveParents(sessions: SessionMeta[]): Map<string, LineageEdge> {
  const parentOf = new Map<string, LineageEdge>();
  for (const session of sessions) {
    const parent = session.teamOrigin?.parentSessionId;
    if (parent && parent !== session.id) {
      parentOf.set(session.id, { parent, child: session.id, source: 'parentSessionId' });
    }
  }
  for (const group of groupSessionsByTeam(sessions)) {
    const spawner = group.spawnerSessionId;
    if (!spawner) continue;
    // The window of the teammates that actually named this spawner — the run.
    const named = group.sessions.filter((r) => r.teamOrigin.parentSessionId === spawner).map(spawnMs).filter((t) => !Number.isNaN(t));
    if (named.length === 0) continue;
    const from = Math.min(...named) - SPAWNER_ADOPTION_SLACK_MS;
    const to = Math.max(...named) + SPAWNER_ADOPTION_SLACK_MS;
    for (const row of group.sessions) {
      if (parentOf.has(row.id) || row.id === spawner) continue;
      const ts = spawnMs(row);
      if (Number.isNaN(ts) || ts < from || ts > to) continue;
      parentOf.set(row.id, { parent: spawner, child: row.id, source: 'teamSpawner' });
    }
  }
  return parentOf;
}

/** Walk up from `startId` to the topmost ancestor present in the pool. */
function topmostAncestor(startId: string, parentOf: Map<string, LineageEdge>, byId: Map<string, SessionMeta>): string {
  let current = startId;
  const seen = new Set<string>([current]);
  for (;;) {
    const edge = parentOf.get(current);
    if (!edge || !byId.has(edge.parent) || seen.has(edge.parent)) return current;
    current = edge.parent;
    seen.add(current);
  }
}

function roleFor(session: SessionMeta, childCount: number): LineageRole {
  if (childCount > 0) return 'orchestrator';
  if (session.teamOrigin) return teamRowKind(session.teamOrigin);
  return 'session';
}

/**
 * Build the delegation graph rooted at one session.
 *
 * `sessions` is the discovery pool WITH team sessions included — team-origin
 * rows are hidden from the ordinary listing by default (`AGENTS.md` invariant 7),
 * so a caller that filters them out first would resolve an empty graph. It MUST
 * contain the `rootId` row (a root outside the pool throws rather than rooting
 * the graph somewhere else). The returned graph is the root's subtree: unrelated
 * sessions in the pool supply edges but never become nodes.
 */
export function buildLineage(sessions: SessionMeta[], options: BuildLineageOptions = {}): SessionLineage {
  const now = options.now ?? Date.now();
  const activeWithin = options.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS;
  const idleWithin = options.idleWithinMs ?? DEFAULT_IDLE_WITHIN_MS;

  const enriched = enrichTeamOrigins(sessions);
  const byId = new Map(enriched.map((s) => [s.id, s]));
  const parentOf = resolveParents(enriched);

  const childrenOf = new Map<string, SessionMeta[]>();
  const unresolved = new Set<string>();
  for (const edge of parentOf.values()) {
    if (!byId.has(edge.parent)) {
      unresolved.add(edge.parent);
      continue;
    }
    const child = byId.get(edge.child)!;
    (childrenOf.get(edge.parent) ?? childrenOf.set(edge.parent, []).get(edge.parent)!).push(child);
  }
  for (const kids of childrenOf.values()) {
    kids.sort((a, b) => (spawnTs(a) < spawnTs(b) ? -1 : spawnTs(a) > spawnTs(b) ? 1 : a.id.localeCompare(b.id)));
  }

  // A rootId the pool does not contain is a CALLER bug — silently rooting the
  // graph at some unrelated first row is how a lineage renders the wrong team.
  if (options.rootId && !byId.has(options.rootId)) {
    throw new Error(
      `buildLineage: root session ${options.rootId} is not in the pool — the caller must include the root row.`,
    );
  }
  const requested = options.rootId ?? enriched[0]?.id;
  const rootId = requested ? topmostAncestor(requested, parentOf, byId) : '';
  const root = rootId ? byId.get(rootId) : undefined;
  if (!root) {
    return { rootId: '', nodes: [], edges: [], teams: [], unresolvedParentIds: [...unresolved] };
  }

  // Breadth-first from the root, so the render order IS the drawing order:
  // depth 0 on top, each level below it. `seen` guards a cyclic record.
  const nodes: LineageNode[] = [];
  const seen = new Set<string>([rootId]);
  const queue: Array<{ session: SessionMeta; depth: number }> = [{ session: root, depth: 0 }];
  const subtreeEdges: LineageEdge[] = [];
  while (queue.length > 0) {
    const { session, depth } = queue.shift()!;
    const kids = (childrenOf.get(session.id) ?? []).filter((k) => !seen.has(k.id));
    nodes.push({
      session,
      id: session.id,
      shortId: session.shortId || session.id.slice(0, 8),
      agent: session.agent,
      handle: session.teamOrigin?.handle,
      team: session.teamOrigin?.team,
      mode: session.teamOrigin?.mode ?? session.mode,
      role: roleFor(session, kids.length),
      depth,
      toolCount: session.toolCallCount ?? 0,
      durationMs: session.durationMs ?? 0,
      activity: classifyActivity(session, now, activeWithin, idleWithin),
      prNumber: session.prNumber,
      childCount: kids.length,
    });
    for (const kid of kids) {
      seen.add(kid.id);
      subtreeEdges.push(parentOf.get(kid.id)!);
      queue.push({ session: kid, depth: depth + 1 });
    }
  }

  const teams = [...new Set(nodes.map((n) => n.team).filter((t): t is string => !!t))].sort();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const unresolvedForSubtree = [...unresolved].filter((parent) =>
    enriched.some((s) => nodeIds.has(s.id) && parentOf.get(s.id)?.parent === parent),
  );

  return { rootId, nodes, edges: subtreeEdges, teams, unresolvedParentIds: unresolvedForSubtree };
}
