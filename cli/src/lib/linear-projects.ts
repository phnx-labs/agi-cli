
import { execFileSync } from 'child_process';

export interface LinearProjectLite {
  id: string;
  name: string;
  url?: string;
}

export function normalizeProjectKey(s: string): string {
  const last = s.toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/[-_\s.]/g, '');
}

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

function checkoutMatchKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function matchLocalCheckoutExact(name: string, dirNames: string[]): string | undefined {
  // Write paths require one exact normalized key; containment is suggestion-only and '/' in display names is punctuation.
  const key = checkoutMatchKey(name);
  if (!key) return undefined;
  const hits = dirNames.filter((d) => checkoutMatchKey(d) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

export type LinearPick =
  | { kind: 'match'; project: LinearProjectLite }
  | { kind: 'candidates'; projects: LinearProjectLite[] }
  | { kind: 'none' };

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

export function nextLinearLink(
  prior: { projectId?: string; url?: string; name?: string } | undefined,
  project: LinearProjectLite,
): { projectId: string; url?: string; name: string } {
  // Refresh the name; preserve a stored URL only while the project ID is unchanged.
  const next: { projectId: string; url?: string; name: string } = { projectId: project.id, name: project.name };
  const url = project.url ?? (prior?.projectId === project.id ? prior?.url : undefined);
  if (url) next.url = url;
  return next;
}
