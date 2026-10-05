/**
 * Per-project Linear issue counts for the `agents projects status` card.
 *
 * When a project definition carries `linear.projectId` (set via
 * `agents projects link <name> --linear`), the card shows one outcome line —
 * `12/30 done · 5 in progress` — counted from the Linear GraphQL API by state
 * TYPE (triage / backlog / unstarted / started / completed / canceled), never
 * hardcoded state names.
 *
 * The same fetch also yields the **next milestone** — the earliest-dated
 * milestone with unfinished issues — because each issue node carries its
 * `projectMilestone`. A percentage tells you how far along a project is; the
 * milestone tells you what it is due to hit next, which is the thing a person
 * actually plans around. Deriving it here costs no extra request.
 *
 * This is a best-effort card enrichment, not an explicit command: every failure
 * (no credential, offline, API error, timeout) degrades to `undefined` and the
 * card simply omits the line — never a hang, never a throw. `--no-remote`
 * skips it (it's network). The API key resolves through the same chain the rest
 * of the stack uses: $LINEAR_API_KEY → macOS Keychain (`resolveLinearApiKey`)
 * → the linear-cli config (`~/.linear-cli/config.json` `apiKey`).
 *
 * Paging is capped (10 × 250 issues) so a pathological project can't burn the
 * budget; a capped fetch reports `truncated: true` and the card renders the
 * total as a lower bound (`2500+ done`), never as the complete count.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isRateLimited, noteRateLimited, parseRateLimitReset, readCached, writeCached, resolveLinearApiKey } from './linear-cache.js';
import { reserveLinearRequest } from './linear-rate-limit.js';

const LINEAR_API = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 8_000;
const PAGE_SIZE = 250;
const MAX_PAGES = 10;

export interface LinearMilestone {
  name: string;
  targetDate?: string;
  done: number;
  total: number;
  isNext?: boolean;
}

export interface LinearMilestoneNode {
  id?: string;
  name?: string;
  targetDate?: string | null;
  status?: string | null;
}

export interface LinearProjectCounts {
  done: number;
  total: number;
  inProgress: number;
  truncated?: boolean;
  stale?: boolean;
  milestones?: LinearMilestone[];
  nextMilestone?: LinearMilestone;
}

export interface LinearIssueNode {
  state?: { type?: string } | null;
  projectMilestone?: { id?: string; name?: string; targetDate?: string | null } | null;
}

export interface LinearIssuesResponse {
  issues?: {
    nodes?: LinearIssueNode[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  };
  project?: { projectMilestones?: { nodes?: LinearMilestoneNode[] } } | null;
}

export function countsFromIssuesResponse(data: LinearIssuesResponse): LinearProjectCounts {
  const nodes = data.issues?.nodes ?? [];
  let done = 0;
  let inProgress = 0;
  for (const n of nodes) {
    const type = n?.state?.type;
    if (type === 'completed') done++;
    else if (type === 'started') inProgress++;
  }
  const counts: LinearProjectCounts = { done, total: nodes.length, inProgress };
  const declared = data.project?.projectMilestones?.nodes ?? [];
  const ordered = orderedMilestones(declared, nodes);
  if (ordered.length) counts.milestones = ordered;
  const next = nextMilestone(declared, nodes);
  if (next) counts.nextMilestone = next;
  return counts;
}

export function orderedMilestones(
  declared: LinearMilestoneNode[],
  nodes: LinearIssueNode[],
): LinearMilestone[] {
  // Declared milestones are authoritative; zero issues means unfinished.
  const progress = new Map<string, { done: number; total: number }>();
  for (const n of nodes) {
    const id = n?.projectMilestone?.id;
    if (!id) continue;
    const p = progress.get(id) ?? { done: 0, total: 0 };
    p.total++;
    if (n.state?.type === 'completed') p.done++;
    progress.set(id, p);
  }
  const all = declared
    .map((d, order) => {
      if (!d?.id || typeof d.name !== 'string' || !d.name) return undefined;
      const p = progress.get(d.id) ?? { done: 0, total: 0 };
      const m: LinearMilestone & { order: number } = { name: d.name, done: p.done, total: p.total, order };
      if (d.targetDate) m.targetDate = d.targetDate;
      if (d.status === 'next') m.isNext = true;
      return m;
    })
    .filter((m): m is LinearMilestone & { order: number } => m !== undefined);
  const open = (m: LinearMilestone) => m.total === 0 || m.done < m.total;
  all.sort((a, b) => {
    if (open(a) !== open(b)) return open(a) ? -1 : 1;
    if (a.targetDate && b.targetDate) return a.targetDate < b.targetDate ? -1 : a.targetDate > b.targetDate ? 1 : a.order - b.order;
    if (a.targetDate) return -1;
    if (b.targetDate) return 1;
    return a.order - b.order;
  });
  return all.map(({ order: _order, ...m }) => m);
}

export function nextMilestone(
  declared: LinearMilestoneNode[],
  nodes: LinearIssueNode[],
): LinearMilestone | undefined {
  const ordered = orderedMilestones(declared, nodes);
  const open = ordered.filter((m) => m.total === 0 || m.done < m.total);
  // Linear's explicit next wins; otherwise choose the earliest unfinished milestone.
  return open.find((m) => m.isNext) ?? open[0];
}

function resolveApiKey(): string | null {
  const fromChain = resolveLinearApiKey();
  if (fromChain) return fromChain;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.linear-cli', 'config.json'), 'utf8'),
    ) as { apiKey?: string };
    return cfg.apiKey?.trim() || null;
  } catch {
    return null;
  }
}

export async function fetchLinearProjectCounts(
  projectId: string,
  fetchPage: (projectId: string, after: string | undefined, signal: AbortSignal) => Promise<LinearIssuesResponse | undefined> = fetchLinearIssuesPage,
  nowMs: number = Date.now(),
): Promise<LinearProjectCounts | undefined> {
  const cached = readCached<LinearProjectCounts>(projectId, nowMs);
  if (cached && !cached.stale) return cached.value;
  if (isRateLimited(nowMs)) return cached ? { ...cached.value, stale: true } : undefined;
  // One abort budget covers all pages; milestones are fetched only on page zero.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const all: LinearIssueNode[] = [];
    let declared: LinearMilestoneNode[] = [];
    let after: string | undefined;
    let truncated = false;
    for (let page = 0; ; page++) {
      const data = await fetchPage(projectId, after, ctrl.signal);
      if (!data) return cached ? { ...cached.value, stale: true } : undefined;
      if (page === 0) declared = data.project?.projectMilestones?.nodes ?? [];
      all.push(...(data.issues?.nodes ?? []));
      const pi = data.issues?.pageInfo;
      if (!pi?.hasNextPage || !pi.endCursor) break;
      if (page + 1 >= MAX_PAGES) {
        truncated = true;
        break;
      }
      after = pi.endCursor;
    }
    const counts: LinearProjectCounts = {
      ...countsFromIssuesResponse({
        issues: { nodes: all },
        project: { projectMilestones: { nodes: declared } },
      }),
      ...(truncated ? { truncated } : {}),
    };
    writeCached(projectId, counts, nowMs);
    return counts;
  } catch {
    return cached ? { ...cached.value, stale: true } : undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLinearIssuesPage(
  projectId: string,
  after: string | undefined,
  signal: AbortSignal,
): Promise<LinearIssuesResponse | undefined> {
  const apiKey = resolveApiKey();
  if (!apiKey) return undefined;
  // Fresh/stale cache, shared reservation, and 429 backoff protect the shared quota.
  if (!reserveLinearRequest(apiKey)) return undefined;
  const issuesSelection =
    'issues(filter:{ project:{ id:{ eq:$p } } }, first:' +
    PAGE_SIZE +
    ', after:$after){ nodes{ state{ type } projectMilestone{ id } } pageInfo{ hasNextPage endCursor } }';
  const milestonesSelection = 'project(id:$pid){ projectMilestones(first:50){ nodes{ id name targetDate status } } }';
  const first = after === undefined;
  const res = await fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: first
        ? `query($p:ID!, $pid:String!, $after:String){ ${issuesSelection} ${milestonesSelection} }`
        : `query($p:ID!, $after:String){ ${issuesSelection} }`,
      variables: first
        ? { p: projectId, pid: projectId, after: null }
        : { p: projectId, after },
    }),
    signal,
  });
  if (res.status === 429) {
    const now = Date.now();
    noteRateLimited(parseRateLimitReset(res.headers.get('x-ratelimit-requests-reset'), now), now);
    return undefined;
  }
  if (!res.ok) return undefined;
  const json = (await res.json()) as { data?: LinearIssuesResponse; errors?: unknown[] };
  if (json.errors?.length || !json.data) return undefined;
  return json.data;
}
