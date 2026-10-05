/** Pure builders behind `agents projects import` (currently Linear only), funneling through
 * `writeProjectDef`. No fs, shell or env, so they test against plain fixtures; the command layer
 * shells out to `linear`. The one exception is `toHomeRelative`, a string rewrite against `$HOME`. */

import { isSafeProjectName, type ProjectDef } from './projects.js';
import { matchLocalCheckoutExact, type LinearProjectLite } from './linear-projects.js';

/** A row the import declined to write, with the reason to print. */
export interface ImportSkip {
  name: string;
  reason: string;
}

/** What an import would write, and what it declined. */
export interface ImportPlan {
  defs: ProjectDef[];
  skipped: ImportSkip[];
}

/** The validated shape of the `import` flags. */
export interface ImportOptions {
  source: 'linear';
  force: boolean;
}

/** The raw commander flags, before validation. */
export interface RawImportFlags {
  fromLinear?: boolean;
  force?: boolean;
}

/** Validate the flag combination, throwing a user-facing message on the first problem. */
export function validateImportOpts(flags: RawImportFlags): ImportOptions {
  if (!flags.fromLinear) throw new Error('Pick an import source: --from-linear.');
  return { source: 'linear', force: flags.force === true };
}

/** Turn a Linear project name into a def slug: lowercase, unusable runs collapsed to one `-`,
 * trimmed, capped at the 64 chars `isSafeProjectName` allows; `''` if nothing survives (caller
 * skips loudly). */
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

/** The local-checkout lookups the Linear builder needs, injected so it stays pure. */
export interface LinearImportDeps {
  /** Directory names directly under the configured projects root. */
  localDirs: string[];
  /** Home-relative root path for one of `localDirs`. */
  resolveRoot: (dir: string) => string | undefined;
  /** `owner/repo` from that checkout's origin remote, when it has one. */
  resolveOrigin: (dir: string) => string | undefined;
}

/** Plan the Linear import: each project becomes a def with its `linear` link; the checkout binds
 * only on an exact normalized-name match, since containment would silently set a wrong `root`.
 * Existing defs keep all but `name` and `linear`. */
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
    // The Linear display name is recorded verbatim (`p.name`), not the
    // slugified def name: `agi` is the local id, "AGI" is what the board calls
    // it, and agents read the latter when they name the project.
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
