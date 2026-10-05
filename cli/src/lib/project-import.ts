// Bind only an exact normalized checkout and preserve existing definition fields.

import { isSafeProjectName, type ProjectDef } from './projects.js';
import { matchLocalCheckoutExact, type LinearProjectLite } from './linear-projects.js';

export interface ImportSkip {
  name: string;
  reason: string;
}

export interface ImportPlan {
  defs: ProjectDef[];
  skipped: ImportSkip[];
}

export interface ImportOptions {
  source: 'linear';
  force: boolean;
}

export interface RawImportFlags {
  fromLinear?: boolean;
  force?: boolean;
}

export function validateImportOpts(flags: RawImportFlags): ImportOptions {
  if (!flags.fromLinear) throw new Error('Pick an import source: --from-linear.');
  return { source: 'linear', force: flags.force === true };
}

export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64)
    .replace(/[-._]+$/g, '');
  return isSafeProjectName(slug) ? slug : '';
}

export interface LinearImportDeps {
  localDirs: string[];
  resolveRoot: (dir: string) => string | undefined;
  resolveOrigin: (dir: string) => string | undefined;
}

export function buildLinearImportCandidates(
  projects: LinearProjectLite[],
  existing: Map<string, ProjectDef>,
  deps: LinearImportDeps,
  opts: Pick<ImportOptions, 'force'>,
): ImportPlan {
  const defs: ProjectDef[] = [];
  const skipped: ImportSkip[] = [];
  const seen = new Set<string>();
  for (const p of projects) {
    const name = slugifyProjectName(p.name);
    if (!name) {
      skipped.push({ name: p.name, reason: 'no usable project name (letters, digits, ., _, - only)' });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name: p.name, reason: `another Linear project already claimed the name "${name}"` });
      continue;
    }
    const prior = existing.get(name);
    if (prior && (prior.root || prior.repo) && !opts.force) {
      skipped.push({ name, reason: 'existing def already has root/repo — pass --force to relink' });
      continue;
    }
    seen.add(name);
    const def: ProjectDef = { ...prior, name, linear: { projectId: p.id, name: p.name } };
    if (p.url) def.linear!.url = p.url;
    const dir = matchLocalCheckoutExact(p.name, deps.localDirs);
    if (dir) {
      const root = deps.resolveRoot(dir);
      if (root) def.root = root;
      const repo = deps.resolveOrigin(dir);
      if (repo) def.repo = repo;
    }
    defs.push(def);
  }
  return { defs, skipped };
}
