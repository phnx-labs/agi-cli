import chalk from 'chalk';
import type { AgentId } from '../types.js';
import type { SessionAgentId, SessionMeta } from '@phnx-labs/sessions-cli/reader';
import { SESSION_AGENTS, isAgentTmuxAlias, resolveRoutineName, safeTeamText } from '@phnx-labs/sessions-cli/reader';
import { shortIdFromName, type ActiveSession } from './active.js';
import { machineId } from './sync/config.js';
import { loadLocalActiveSessions, readActiveSessionsCache } from './session-cache.js';
import { gatherRemoteList, runOnPeer, shouldIncludeLocal } from './remote/remote-list.js';
import {
  findLocalSessionTranscripts,
  hydrateSessionTranscript,
  isCompleteSessionId,
  looksLikeSessionId,
  resolveSessionById,
  scanSessionsIncremental,
  searchContentIndex,
  waitForScanToSettle,
} from './discover.js';
import { findSessionsById, querySessions } from './db.js';
import { liveSessionMetas, fleetExecutionMachineById, reconcileLiveMetaMachine } from './live-metadata.js';
import { resolveSessionAlias } from './actor-sidecar.js';
import { AGENTS, resolveAgentName } from '../agents.js';
import { fuzzyMatch, FUZZY_PRESETS } from '../fuzzy.js';
import { listInstalledVersions, resolveVersionAliasLoose } from '../installations/versions.js';

export interface SessionFilterOptions {
  agent?: string;
  version?: string;
  sessionVersion?: string;
  project?: string;
  all?: boolean;
  teams?: boolean;
  inTeam?: string;
  routine?: boolean | string;
  since?: string;
  until?: string;
}

type InstalledVersionsForAgent = (agent: SessionAgentId) => string[];

export function parseInstalledAgentVersionQuery(
  query: string | undefined,
  installedVersions: InstalledVersionsForAgent = (agent) => (
    agent in AGENTS ? listInstalledVersions(agent as AgentId) : []
  ),
): string | undefined {
  const trimmed = query?.trim();
  if (!trimmed) return undefined;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@') || at === trimmed.length - 1) return undefined;

  const agentName = trimmed.slice(0, at).toLowerCase();
  if (!SESSION_AGENTS.includes(agentName as SessionAgentId)) return undefined;
  const agent = agentName as SessionAgentId;
  const version = trimmed.slice(at + 1);
  return installedVersions(agent).includes(version) ? `${agent}@${version}` : undefined;
}

export function ticketLabel(s: Pick<SessionMeta, 'ticketId' | 'prNumber'>): string {
  return s.ticketId ?? (s.prNumber ? `PR#${s.prNumber}` : '');
}

export function sessionMatchesQuery(s: SessionMeta, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [
    s.shortId,
    s.agent,
    s.project,
    s.cwd,
    s.topic,
    (s as { label?: string }).label,
    ticketLabel(s),
    s.machine,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export function mergeLocalFirst(sessions: SessionMeta[], localMachine: string): SessionMeta[] {
  const byMachine = new Map<string, SessionMeta[]>();
  const seen = new Set<string>();
  for (const s of sessions) {
    const machine = s.machine || localMachine;
    if (s.id) {
      const dedupeKey = `${machine}:${s.id}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
    }
    (byMachine.get(machine) ?? byMachine.set(machine, []).get(machine)!).push(s);
  }
  const keys = Array.from(byMachine.keys()).sort((a, b) => {
    if (a === localMachine) return -1;
    if (b === localMachine) return 1;
    const ac = byMachine.get(a)!.length, bc = byMachine.get(b)!.length;
    if (ac !== bc) return bc - ac;
    return a.localeCompare(b);
  });
  return keys.flatMap((k) => byMachine.get(k)!);
}

// Peer resolution exposes launch identity only; paths, plans, costs, and content stay local.
export function serializeResolvedSessionsJson(sessions: SessionMeta[]): string {
  const safe = sessions.map((session) => ({
    id: session.id,
    shortId: session.shortId,
    agent: session.agent,
    harness: session.harness,
    origin: session.origin,
    timestamp: session.timestamp,
    lastActivity: session.lastActivity,
    project: session.project,
    version: session.version,
    mode: session.mode,
    label: session.label,
    topic: session.topic,
    machine: session.machine,
  }));
  return JSON.stringify(safe, null, 2) + '\n';
}

interface AgentFilter {
  agent?: SessionAgentId;
  version?: string;
}

export function resolveSessionAgentName(name: string): SessionAgentId | null {
  const normalized = name.toLowerCase();
  if (SESSION_AGENTS.includes(normalized as SessionAgentId)) {
    return normalized as SessionAgentId;
  }
  const resolved = resolveAgentName(normalized);
  if (resolved && SESSION_AGENTS.includes(resolved as SessionAgentId)) {
    return resolved as SessionAgentId;
  }
  return fuzzyMatch(normalized, SESSION_AGENTS, FUZZY_PRESETS.agents);
}

export function parseAgentFilter(agentName?: string): AgentFilter {
  if (!agentName) return {};
  const [name, version] = agentName.split('@', 2);
  const agent = resolveSessionAgentName(name);
  if (!agent) {
    console.error(chalk.red(`Unknown agent: ${name}. Use: ${SESSION_AGENTS.join(', ')}`));
    process.exit(1);
  }
  return { agent, version };
}

export type SessionSearchScope = {
  agent?: string;
  project?: string;
  routine?: boolean | string;
};

interface SessionQueryResolution {
  matches: SessionMeta[];
  byId: boolean;
  completeId: boolean;
}

export function resolveSessionQuery(
  pool: SessionMeta[],
  query: string,
  options: { indexFallback?: boolean; scope?: SessionSearchScope } = {},
): SessionQueryResolution {
  const normalized = query.trim();
  const completeId = isCompleteSessionId(normalized);
  const byIdMatches = resolveSessionById(pool, normalized);
  if (byIdMatches.length > 0) return { matches: byIdMatches, byId: true, completeId };

  if (looksLikeSessionId(normalized)) {
    const matches = options.indexFallback === false ? [] : findSessionsById(normalized);
    return { matches, byId: true, completeId };
  }
  return { matches: filterSessionsByQuery(pool, normalized, options.scope), byId: false, completeId };
}

export function filterSessionsByQuery(
  sessions: SessionMeta[],
  query: string | undefined,
  scope?: SessionSearchScope,
): SessionMeta[] {
  const trimmed = query?.trim().toLowerCase() || '';
  if (!trimmed) return sessions;

  const installedAgentVersion = parseInstalledAgentVersionQuery(trimmed);
  if (installedAgentVersion) {
    const { agent, version } = parseAgentFilter(installedAgentVersion);
    return sessions.filter((session) => session.agent === agent && session.version === version);
  }

  const terms = trimmed.split(/\s+/).filter(Boolean);
  const contentIndex = scopedContentIndex(sessions, trimmed, scope);

  const EXACT_LABEL_SCORE = 1_000_000;
  const exactLabelHits = [...contentIndex.values()].filter(
    s => (s._bm25Score ?? 0) >= EXACT_LABEL_SCORE,
  );
  if (exactLabelHits.length > 0) {
    return exactLabelHits.sort(
      (a, b) => (b._bm25Score ?? 0) - (a._bm25Score ?? 0),
    );
  }

  const poolById = new Map(sessions.map(s => [s.id, s]));
  for (const [id, hit] of contentIndex) {
    if (!poolById.has(id)) poolById.set(id, hit);
  }

  return [...poolById.values()]
    .map(session => ({ session, score: scoreSessionQuery(session, terms) }))
    .filter(entry => {
      if (entry.score > 0) return true;
      const contentMatch = contentIndex.get(entry.session.id);
      if (contentMatch && contentMatch._matchedTerms && contentMatch._matchedTerms.length > 0) {
        return true;
      }
      return false;
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const cmA = contentIndex.get(a.session.id);
      const cmB = contentIndex.get(b.session.id);
      const bmA = cmA?._bm25Score ?? 0;
      const bmB = cmB?._bm25Score ?? 0;
      if (bmB !== bmA) return bmB - bmA;
      return new Date(b.session.timestamp).getTime() - new Date(a.session.timestamp).getTime();
    })
    .map(entry => {
      const cm = contentIndex.get(entry.session.id);
      if (cm && cm._matchedTerms) {
        return { ...cm };
      }
      return entry.session;
    });
}

function scoreSessionQuery(session: SessionMeta, terms: string[]): number {
  let score = 0;

  for (const term of terms) {
    const exactId = session.id.toLowerCase() === term || session.shortId.toLowerCase() === term;
    const prefixId = session.id.toLowerCase().startsWith(term) || session.shortId.toLowerCase().startsWith(term);
    const topic = session.topic?.toLowerCase() || '';
    const project = session.project?.toLowerCase() || '';
    const account = session.account?.toLowerCase() || '';
    const cwd = session.cwd?.toLowerCase() || '';
    const agent = session.agent.toLowerCase();
    const version = session.version?.toLowerCase() || '';

    let termScore = 0;
    if (exactId) termScore = 1000;
    else if (prefixId) termScore = 900;
    else if (topic.startsWith(term)) termScore = 700;
    else if (project.startsWith(term)) termScore = 600;
    else if (account.startsWith(term)) termScore = 550;
    else if (agent.startsWith(term) || version.startsWith(term)) termScore = 500;
    else if (topic.includes(term)) termScore = 400;
    else if (project.includes(term)) termScore = 300;
    else if (account.includes(term)) termScore = 250;
    else if (cwd.includes(term)) termScore = 200;
    else if (version.includes(term) || agent.includes(term)) termScore = 150;
    else return 0;

    score += termScore;
  }

  return score;
}

export function applyScopeFilters(
  sessions: SessionMeta[],
  scope: SessionSearchScope,
): SessionMeta[] {
  let filtered = sessions;

  if (scope.project) {
    const projectQuery = scope.project.toLowerCase();
    filtered = filtered.filter((s) => {
      const project = (s.project || '').toLowerCase();
      const cwd = (s.cwd || '').toLowerCase();
      return project.includes(projectQuery) || cwd.includes(projectQuery);
    });
  }

  if (scope.agent) {
    const [wantAgent, rawVersion] = scope.agent.split('@');
    const resolvedAgent = resolveAgentName(wantAgent);
    const wantVersion = resolvedAgent ? resolveVersionAliasLoose(resolvedAgent, rawVersion) : rawVersion;
    filtered = filtered.filter((s) => {
      if (s.agent !== wantAgent) return false;
      if (wantVersion && s.version !== wantVersion) return false;
      return true;
    });
  }

  if (scope.routine) {
    filtered = filtered.filter((session) => session.origin === 'routine');
    if (typeof scope.routine === 'string') {
      const names = [...new Set(
        filtered.map((session) => session.routineName).filter((name): name is string => !!name),
      )];
      const selected = resolveRoutineName(scope.routine, names);
      filtered = selected
        ? filtered.filter((session) => session.routineName === selected)
        : [];
    }
  }

  return filtered;
}

export function scopedContentIndex(
  sessions: SessionMeta[],
  query: string,
  scope?: SessionSearchScope,
): Map<string, SessionMeta> {
  const hits = searchContentIndex(sessions, query);
  if (!scope || (!scope.agent && !scope.project && !scope.routine)) return hits;
  const kept = new Map<string, SessionMeta>();
  for (const [id, session] of hits) {
    if (applyScopeFilters([session], scope).length > 0) kept.set(id, session);
  }
  return kept;
}

export interface FleetResolveDeps {
  gatherRemoteList: typeof gatherRemoteList;
  runOnPeer: typeof runOnPeer;
}

interface FleetHit {
  machine: string;
  session: SessionMeta;
}

export interface FleetSessionCandidate {
  id: string;
  hits: FleetHit[];
}

export type MetadataResolveOutcome =
  | { kind: 'resolved'; session: SessionMeta }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; candidates: FleetSessionCandidate[] }
  | { kind: 'partial'; failedPeers: string[] };

const FULL_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHORT_SESSION_ID_RE = /^[0-9a-f]{8}$/i;


export function isDefinitiveMatch(session: SessionMeta, selector: string): boolean {
  const trimmed = selector.trim();
  if (FULL_SESSION_ID_RE.test(trimmed)) {
    return session.id.toLowerCase() === trimmed.toLowerCase();
  }
  const shortId = shortIdFromName(trimmed) ?? (SHORT_SESSION_ID_RE.test(trimmed) ? trimmed : undefined);
  return !!shortId && session.shortId.toLowerCase() === shortId.toLowerCase();
}

export function selectorAllowsEarlyExit(selector: string): boolean {
  const trimmed = selector.trim();
  return FULL_SESSION_ID_RE.test(trimmed) || isAgentTmuxAlias(trimmed) || SHORT_SESSION_ID_RE.test(trimmed);
}

export function fleetCandidatesByQuery(rows: SessionMeta[], query: string, trustResolvedRows = false): FleetSessionCandidate[] {
  const matched = !trustResolvedRows && looksLikeSessionId(query)
    ? resolveSessionQuery(rows, query, { indexFallback: false }).matches
    : rows;
  const byId = new Map<string, Map<string, SessionMeta>>();
  for (const session of matched) {
    const machine = session.machine;
    if (!machine) continue;
    const logicalId = session.id.toLowerCase();
    let byMachine = byId.get(logicalId);
    if (!byMachine) {
      byMachine = new Map();
      byId.set(logicalId, byMachine);
    }
    if (!byMachine.has(machine)) byMachine.set(machine, session);
  }

  return Array.from(byId.values()).map(byMachine => {
    const hits = Array.from(byMachine.entries()).map(([machine, session]) => ({ machine, session }));
    return { id: hits[0].session.id, hits };
  });
}

function resolveIndexedMetadataRows(
  indexed: SessionMeta[],
  selector: string,
  scope?: SessionSearchScope,
): SessionMeta[] {
  const alias = resolveSessionAlias(selector);
  if (alias.kind === 'resolved') {
    return resolveSessionQuery(indexed, alias.sessionId, { indexFallback: false, scope }).matches;
  }
  if (alias.kind === 'ambiguous') {
    const ids = new Set(alias.sessionIds.map(id => id.toLowerCase()));
    return indexed.filter(session => ids.has(session.id.toLowerCase()));
  }
  return resolveSessionQuery(indexed, selector, { indexFallback: false, scope }).matches;
}

function indexedRowsForSelector(
  selector: string,
  scope: { agent?: string; project?: string },
): SessionMeta[] {
  const indexed = looksLikeSessionId(selector)
    ? findSessionsById(selector)
    : querySessions();
  return applyScopeFilters(indexed, scope);
}

export function metadataResolveForwardedArgs(
  selector: string,
  scope: Pick<SessionFilterOptions, 'agent' | 'project'>,
): string[] {
  const args = ['sessions', '--resolve-safe-v1', selector, '--json', '--all', '--local'];
  if (scope.agent) args.push('--agent', scope.agent);
  if (scope.project) args.push('--project', scope.project);
  return args;
}

const SHORT_SESSION_ID_WIDTH = 8;

export function isUniqueEnoughSelector(selector: string): boolean {
  const trimmed = selector.trim();
  if (isCompleteSessionId(trimmed)) return true;
  return /^[0-9a-f-]+$/i.test(trimmed)
    && trimmed.replace(/-/g, '').length >= SHORT_SESSION_ID_WIDTH;
}

export function metadataResolveOutcome(
  localMatches: SessionMeta[],
  remote: { sessions: SessionMeta[]; unreachable: string[] },
  selector: string,
): MetadataResolveOutcome {
  const candidates = fleetCandidatesByQuery([...localMatches, ...remote.sessions], selector, true);
  if (isUniqueEnoughSelector(selector) && candidates.length === 1) {
    return { kind: 'resolved', session: candidates[0].hits[0].session };
  }
  if (remote.unreachable.length > 0) return { kind: 'partial', failedPeers: remote.unreachable };
  if (candidates.length === 0) return { kind: 'not-found' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidates };
  return { kind: 'resolved', session: candidates[0].hits[0].session };
}

export function isLocallyDefinitiveMatch(session: SessionMeta, self: string): boolean {
  if (session.filePath) return true;
  return !!session.machine && session.machine !== self;
}

export function preferOwnerAttribution(
  localMatches: SessionMeta[],
  remoteSessions: SessionMeta[],
  self: string,
): SessionMeta[] {
  if (remoteSessions.length === 0) return localMatches;
  const answeredByPeer = new Set(remoteSessions.map(session => session.id.toLowerCase()));
  return localMatches.filter(session =>
    isLocallyDefinitiveMatch(session, self) || !answeredByPeer.has(session.id.toLowerCase()));
}

export type LiveMetadataDeps = {
  loadActive?: typeof loadLocalActiveSessions;
  loadFleetActive?: () => ActiveSession[];
};

export async function computeLocalMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] },
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const localMachine = machineId();
  const includeLocal = !scope.hosts?.length || shouldIncludeLocal(scope.hosts, localMachine);
  if (!includeLocal) return [];

  let indexed = resolveIndexedMetadataRows(indexedRowsForSelector(selector, scope), selector, scope);
  if (!looksLikeSessionId(selector)) {
    return indexed.map(session => ({ ...session, machine: session.machine || localMachine }));
  }
  if (indexed.length === 0) {
    const disk = await findLocalSessionTranscripts(selector, scope.agent as SessionMeta['agent'] | undefined);
    const live = disk.length ? [] : await liveMetadataMatches(selector, scope, localMachine, deps);
    if (disk.length > 0) indexed = resolveIndexedMetadataRows(disk, selector, scope);
    else if (live.length > 0) indexed = live;
    else if (scope.agent !== 'claude' && scope.agent !== 'codex') {
      const { claimed } = await scanSessionsIncremental({ agent: scope.agent as SessionMeta['agent'] | undefined });
      if (!claimed) {
        if (!await waitForScanToSettle()) throw new Error('Session lookup is incomplete: another index scan is still running. Retry when it finishes.');
        const retry = await scanSessionsIncremental({ agent: scope.agent as SessionMeta['agent'] | undefined });
        if (!retry.claimed) throw new Error('Session lookup is incomplete: the session index is busy. Retry when the scan finishes.');
      }
      indexed = resolveIndexedMetadataRows(indexedRowsForSelector(selector, scope), selector, scope);
    }
  }
  const hydrated: SessionMeta[] = [];
  for (const session of indexed) {
    hydrated.push(await hydrateSessionTranscript({ ...session, machine: session.machine || localMachine }));
  }
  return hydrated;
}

export async function liveMetadataMatches(
  selector: string,
  scope: { agent?: string; project?: string },
  self: string,
  deps: LiveMetadataDeps = {},
): Promise<SessionMeta[]> {
  const load = deps.loadActive ?? loadLocalActiveSessions;
  const loadFleet = deps.loadFleetActive ?? (() => readActiveSessionsCache('fleet')?.sessions ?? []);
  let fleetExecMachine: Map<string, string>;
  try {
    fleetExecMachine = fleetExecutionMachineById(loadFleet());
  } catch {
    fleetExecMachine = new Map();
  }
  const match = (metas: SessionMeta[]): SessionMeta[] =>
    resolveIndexedMetadataRows(
      applyScopeFilters(reconcileLiveMetaMachine(metas, fleetExecMachine, self), scope),
      selector,
      scope,
    );
  try {
    const cached = liveSessionMetas((await load()).sessions, self, Date.now());
    const hit = match(cached);
    if (hit.length > 0) return hit;
    const fresh = liveSessionMetas((await load({ forceRefresh: true })).sessions, self, Date.now());
    return match(fresh);
  } catch {
    return [];
  }
}

export async function resolveSessionMetadataValue(
  selector: string,
  scope: { agent?: string; project?: string; local?: boolean; hosts?: string[] } = {},
  deps: Pick<FleetResolveDeps, 'gatherRemoteList'> & LiveMetadataDeps = { gatherRemoteList },
): Promise<MetadataResolveOutcome> {
  const localMatches = await computeLocalMetadataMatches(selector, scope, deps);
  const localMachine = machineId();

  if (FULL_SESSION_ID_RE.test(selector)) {
    const localOutcome = metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);
    if (localOutcome.kind === 'resolved' && isLocallyDefinitiveMatch(localOutcome.session, localMachine)) {
      return localOutcome;
    }
  }

  if (scope.local === true) return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [] }, selector);

  try {
    const forwarded = metadataResolveForwardedArgs(selector, scope);
    const remote = await deps.gatherRemoteList(
      forwarded,
      scope.hosts,
      selectorAllowsEarlyExit(selector)
        ? { isDefinitive: (session) => isDefinitiveMatch(session, selector) }
        : undefined,
    );
    return metadataResolveOutcome(
      preferOwnerAttribution(localMatches, remote.sessions, localMachine),
      remote,
      selector,
    );
  } catch (error: any) {
    return metadataResolveOutcome(localMatches, { sessions: [], unreachable: [error?.message ?? 'fleet fan-out'] }, selector);
  }
}

export function matchesTeam(session: SessionMeta, team: string): boolean {
  const want = safeTeamText(team)?.trim().toLowerCase();
  if (!want) return true;
  return (
    safeTeamText(session.spawnedTeam)?.toLowerCase() === want ||
    safeTeamText(session.teamOrigin?.team)?.toLowerCase() === want
  );
}
