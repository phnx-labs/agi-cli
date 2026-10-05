import { describe, it, expect } from 'vitest';
import {
  buildLinearImportCandidates,
  slugifyProjectName,
  validateImportOpts,
  type LinearImportDeps,
} from './project-import.js';
import { matchLocalCheckoutExact } from './linear-projects.js';
import type { ProjectDef } from './projects.js';

const names = (r: { defs: ProjectDef[] }) => r.defs.map((d) => d.name);

describe('validateImportOpts', () => {
  it('requires --from-linear', () => {
    expect(() => validateImportOpts({})).toThrow(/Pick an import source/);
    expect(validateImportOpts({ fromLinear: true }).source).toBe('linear');
  });
});

describe('slugifyProjectName', () => {
  it('turns a Linear display name into a safe slug', () => {
    expect(slugifyProjectName('Agents CLI')).toBe('agents-cli');
    expect(slugifyProjectName('Rush / Web')).toBe('rush-web');
    expect(slugifyProjectName('  Q3 — Growth!  ')).toBe('q3-growth');
    expect(slugifyProjectName('x'.repeat(80))).toHaveLength(64);
  });

  it('returns empty when nothing usable survives', () => {
    expect(slugifyProjectName('!!!')).toBe('');
    expect(slugifyProjectName('')).toBe('');
  });
});

describe('matchLocalCheckoutExact', () => {
  const dirs = ['agents-cli', 'agents-cli-web', 'rush'];

  it('binds only on an exact normalized match', () => {
    expect(matchLocalCheckoutExact('Agents CLI', dirs)).toBe('agents-cli');
    expect(matchLocalCheckoutExact('agents_cli', dirs)).toBe('agents-cli');
  });

  it('refuses the containment match that would bind the wrong checkout', () => {
    expect(matchLocalCheckoutExact('Agents CLI Website', dirs)).toBeUndefined();
    expect(matchLocalCheckoutExact('Nothing Here', dirs)).toBeUndefined();
  });

  it('refuses an ambiguous match', () => {
    expect(matchLocalCheckoutExact('Agents CLI', ['agents-cli', 'agents_cli'])).toBeUndefined();
  });

  it('treats a slash in a display name as punctuation, not a path boundary', () => {
    // "Rush / Web" is one name, not `rush/web`. Keying it the path way (last
    // segment) yields `web`, which exact-matches an unrelated `web/` checkout.
    expect(matchLocalCheckoutExact('Rush / Web', ['web', 'agents-cli'])).toBeUndefined();
    expect(matchLocalCheckoutExact('Rush / Web', ['rush-web', 'web'])).toBe('rush-web');
  });
});

describe('buildLinearImportCandidates', () => {
  const deps: LinearImportDeps = {
    localDirs: ['agents-cli', 'agents-cli-web'],
    resolveRoot: (d) => `~/src/${d}`,
    resolveOrigin: (d) => `muqsitnawaz/${d}`,
  };
  const noLocal: LinearImportDeps = { localDirs: [], resolveRoot: () => undefined, resolveOrigin: () => undefined };

  it('binds root and repo on an exact local match', () => {
    const r = buildLinearImportCandidates(
      [{ id: 'lin_1', name: 'Agents CLI', url: 'https://linear.app/x/project/agents-cli' }],
      new Map(),
      deps,
      { force: false },
    );
    expect(r.defs[0]).toEqual({
      name: 'agents-cli',
      root: '~/src/agents-cli',
      repo: 'muqsitnawaz/agents-cli',
      linear: { projectId: 'lin_1', name: 'Agents CLI', url: 'https://linear.app/x/project/agents-cli' },
    });
  });

  it('writes name + linear only when no local checkout matches', () => {
    const r = buildLinearImportCandidates([{ id: 'lin_2', name: 'Marketing Site' }], new Map(), deps, { force: false });
    expect(r.defs[0]).toEqual({ name: 'marketing-site', linear: { projectId: 'lin_2', name: 'Marketing Site' } });
  });

  it('does NOT auto-bind on a containment-only match', () => {
    const r = buildLinearImportCandidates([{ id: 'lin_3', name: 'Agents' }], new Map(), deps, { force: false });
    expect(r.defs[0]).toEqual({ name: 'agents', linear: { projectId: 'lin_3', name: 'Agents' } });
  });

  it('does NOT bind a slashed display name to the checkout after the slash', () => {
    const r = buildLinearImportCandidates(
      [{ id: 'lin_rw', name: 'Rush / Web' }],
      new Map(),
      { localDirs: ['web', 'agents-cli'], resolveRoot: (d) => `~/src/${d}`, resolveOrigin: (d) => `someone/${d}` },
      { force: false },
    );
    expect(r.defs[0]).toEqual({ name: 'rush-web', linear: { projectId: 'lin_rw', name: 'Rush / Web' } });
  });

  it('preserves hand-set fields on an existing def and overwrites only linear', () => {
    const existing = new Map<string, ProjectDef>([
      ['agents-cli', { name: 'agents-cli', description: 'the CLI', contexts: [{ path: 'cli', purpose: 'the package' }], linear: { projectId: 'old' } }],
    ]);
    const r = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, noLocal, { force: false });
    expect(r.defs[0]).toEqual({
      name: 'agents-cli',
      description: 'the CLI',
      contexts: [{ path: 'cli', purpose: 'the package' }],
      linear: { projectId: 'lin_1', name: 'Agents CLI' },
    });
  });

  it('refreshes a stale linear.name when the Linear project was renamed', () => {
    // Bug on this path: import never wrote `linear.name`, so a def re-imported after a board rename
    // ("Agents CLI" -> "AGI") kept a stale label. The sibling `link` command had the same outcome
    // by spreading the prior block (covered in linear-projects.test.ts).
    const existing = new Map<string, ProjectDef>([
      ['agents-cli', { name: 'agents-cli', linear: { projectId: 'lin_1', name: 'Agents CLI' } }],
    ]);
    const r = buildLinearImportCandidates([{ id: 'lin_1', name: 'AGI' }], existing, noLocal, { force: false });
    expect(r.defs[0].linear).toEqual({ projectId: 'lin_1', name: 'AGI' });
  });

  it('re-imports idempotently — the same name overwrites in place', () => {
    const first = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], new Map(), deps, { force: false });
    const second = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], new Map(first.defs.map((d) => [d.name, d])), deps, { force: true });
    expect(second.defs).toEqual(first.defs);
  });

  it('refuses to relink a def that already has root/repo without --force', () => {
    const existing = new Map<string, ProjectDef>([['agents-cli', { name: 'agents-cli', root: '~/elsewhere', repo: 'me/mine' }]]);
    const r = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, deps, { force: false });
    expect(r.defs).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'agents-cli', reason: 'existing def already has root/repo — pass --force to relink' }]);
    const forced = buildLinearImportCandidates([{ id: 'lin_1', name: 'Agents CLI' }], existing, deps, { force: true });
    expect(forced.defs[0].root).toBe('~/src/agents-cli');
  });

  it('skips a slug collision instead of silently overwriting the first', () => {
    const r = buildLinearImportCandidates(
      [{ id: 'a', name: 'Rush Web' }, { id: 'b', name: 'rush/web' }],
      new Map(),
      noLocal,
      { force: false },
    );
    expect(names(r)).toEqual(['rush-web']);
    expect(r.defs[0].linear).toEqual({ projectId: 'a', name: 'Rush Web' });
    expect(r.skipped).toEqual([{ name: 'rush/web', reason: 'another Linear project already claimed the name "rush-web"' }]);
  });

  it('skips a project whose name has no safe slug', () => {
    const r = buildLinearImportCandidates([{ id: 'a', name: '!!!' }], new Map(), noLocal, { force: false });
    expect(r.defs).toEqual([]);
    expect(r.skipped[0].reason).toMatch(/no usable project name/);
  });
});
