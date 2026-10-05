// Linear project matching for `agents projects link --linear`: normalizeProjectKey() collapses a
// Linear name, repo slug or folder path to one key. Ported from
// apps/ext/src/core/linearProjects.ts; keep in sync. Matcher is pure.

import { execFileSync } from 'child_process';

/** The minimal Linear project shape the link flow needs (id + name + url). */
export interface LinearProjectLite {
  id: string;
  name: string;
  /** Project URL, when the `linear` CLI JSON carries one. Never fabricated. */
  url?: string;
}

/** Collapses a Linear name, repo slug or folder path to one key: lowercase, last path segment only,
 * separators stripped ("Agents CLI" and "phnx-labs/agents-cli" both give "agentscli"). */
export function normalizeProjectKey(s: string): string {
  const last = s.toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[-_\s.]/g, '');
}

/** Finds the Linear project best matching a repo slug or folder name: exact normalized match, then
 * containment either way. Returns the FIRST match, so `link` uses pickLinearProject for writes. */
export function matchLinearProject(
  slugOrName: string,
  projects: LinearProjectLite[],
): LinearProjectLite | undefined {
  const key = normalizeProjectKey(slugOrName);
  if (!key) return undefined;
  const exact = projects.find((p) => normalizeProjectKey(p.name) === key);
  if (exact) return exact;
  return projects.find((p) => {
    const pk = normalizeProjectKey(p.name);
    return pk.length > 0 && (pk.includes(key) || key.includes(pk));
  });
}

/** Collapses a Linear display name or directory basename to a key. Not normalizeProjectKey: that
 * keeps only the last `/` segment, so "Rush / Web" would become `web` and mis-bind an unrelated
 * `web/` checkout. */
function checkoutMatchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Finds the local checkout for a Linear project on EXACT key equality only: `projects import
 * --from-linear` writes root/repo unattended, so "Agents CLI" must not bind `agents-cli-web`.
 * Undefined on no match or several (ambiguous). */
export function matchLocalCheckoutExact(name: string, dirNames: string[]): string | undefined {
  const key = checkoutMatchKey(name);
  if (!key) return undefined;
  const hits = dirNames.filter((d) => checkoutMatchKey(d) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/** The outcome of picking one Linear project out of the workspace list. */
export type LinearPick =
  | { kind: 'match'; project: LinearProjectLite }
  | { kind: 'candidates'; projects: LinearProjectLite[] }
  | { kind: 'none' };

/** Picks the Linear project a query refers to. An exact id or exact normalized name is confident
 * enough to write; weaker matches (duplicate names, containment only) return a candidate list for
 * the user to choose. */
export function pickLinearProject(query: string, projects: LinearProjectLite[]): LinearPick {
  const q = query.trim();
  if (!q) return { kind: 'none' };
  const byId = projects.find((p) => p.id === q);
  if (byId) return { kind: 'match', project: byId };
  const key = normalizeProjectKey(q);
  if (!key) return { kind: 'none' };
  const exact = projects.filter((p) => normalizeProjectKey(p.name) === key);
  if (exact.length === 1) return { kind: 'match', project: exact[0] };
  if (exact.length > 1) return { kind: 'candidates', projects: exact };
  const containment = projects.filter((p) => {
    const pk = normalizeProjectKey(p.name);
    return pk.length > 0 && (pk.includes(key) || key.includes(pk));
  });
  return containment.length > 0 ? { kind: 'candidates', projects: containment } : { kind: 'none' };
}

/** Lists Linear projects via the `linear` CLI on PATH. Throws on a missing binary, error or
 * unusable shape, since this backs an explicit command and a silent empty list would mislead the
 * user. */
export function listLinearProjects(): LinearProjectLite[] {
  let out: string;
  try {
    out = execFileSync('linear', ['projects', '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(
      'Could not list Linear projects — is the `linear` CLI installed and logged in? (`brew install linear-cli`, `linear auth login`)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('`linear projects --json` returned invalid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('`linear projects --json` did not return a list');
  return parsed.flatMap((x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      const o = x as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.name === 'string') {
        const p: LinearProjectLite = { id: o.id, name: o.name };
        if (typeof o.url === 'string') p.url = o.url;
        return [p];
      }
    }
    return [];
  });
}

/** The `linear` block a def carries after binding to `project`. Pure so the write rule is testable.
 * `name` is refreshed, not preserved (a renamed project kept its old label). `url` is dropped when
 * projectId changes and the new row has none; re-linking the same id keeps it. */
export function nextLinearLink(
  prior: { projectId?: string; url?: string; name?: string } | undefined,
  project: LinearProjectLite,
): { projectId: string; url?: string; name: string } {
  const next: { projectId: string; url?: string; name: string } = { projectId: project.id, name: project.name };
  // Keep a stored url only when the prior block names the same project. `projects add --linear
  // <url>` writes `{ url }` with no projectId, which must not count as the same project.
  const url = project.url ?? (prior?.projectId === project.id ? prior?.url : undefined);
  if (url) next.url = url;
  return next;
}
