import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isSafeProjectName,
  loadProjectDef,
  listProjectDefs,
  writeProjectDef,
  removeProjectDef,
  validateProjectDef,
  projectBasePath,
  projectDirsAbs,
  resolveDefinedProjectPath,
  projectNameForCwd,
  resolveProjectNameForCwd,
  confirmedProjectForCwd,
  listProjectDefsCached,
  resetProjectDefsCache,
  type ProjectDef,
} from './projects.js';

const HOME = process.env.HOME ?? os.homedir();
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-test-'));
  process.env.AGENTS_PROJECTS_DIR = dir;
});
afterEach(() => {
  delete process.env.AGENTS_PROJECTS_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isSafeProjectName', () => {
  it('accepts slugs, rejects separators and traversal', () => {
    expect(isSafeProjectName('rush')).toBe(true);
    expect(isSafeProjectName('rush-web.2')).toBe(true);
    expect(isSafeProjectName('..')).toBe(false);
    expect(isSafeProjectName('a/b')).toBe(false);
    expect(isSafeProjectName('.hidden')).toBe(false);
    expect(isSafeProjectName('')).toBe(false);
  });
});

describe('validateProjectDef', () => {
  it('throws when name is missing or unsafe', () => {
    expect(() => validateProjectDef({})).toThrow(/valid "name"/);
    expect(() => validateProjectDef({ name: '../evil' })).toThrow(/valid slug/);
    expect(() => validateProjectDef('nope')).toThrow(/mapping/);
  });

  it('throws when the in-file name disagrees with the filename', () => {
    // The filename is the stable id — a def that names itself otherwise would
    // resolve under one name and list under another.
    expect(() => validateProjectDef({ name: 'other' }, 'rush')).toThrow(/must match the filename/);
    expect(validateProjectDef({ name: 'rush' }, 'rush').name).toBe('rush');
    expect(validateProjectDef({ root: '~/x' }, 'rush').name).toBe('rush'); // no name field → filename wins
  });

  it('keeps well-formed nested fields and drops malformed list entries', () => {
    const def = validateProjectDef({
      name: 'rush',
      repos: [{ slug: 'phnx-labs/rush', subpath: 'apps/web' }, { bad: true }, 'nope'],
      contexts: [{ path: 'apps/web', purpose: 'the app' }, { path: 'x' }],
      integrations: [{ kind: 'gdrive', url: 'https://d', label: 'docs' }, { kind: 'x' }],
      linear: { projectId: 'abc', url: 'https://linear' },
    });
    expect(def.repos).toEqual([{ slug: 'phnx-labs/rush', subpath: 'apps/web' }]);
    expect(def.contexts).toEqual([{ path: 'apps/web', purpose: 'the app' }]);
    expect(def.integrations).toEqual([{ kind: 'gdrive', url: 'https://d', label: 'docs' }]);
    expect(def.linear).toEqual({ projectId: 'abc', url: 'https://linear' });
  });

  it('parses linear.name alongside existing linear fields', () => {
    const def = validateProjectDef({
      name: 'rush',
      linear: { projectId: 'lin_1', url: 'https://linear.app/x', name: 'Rush' },
    });
    expect(def.linear).toEqual({ projectId: 'lin_1', url: 'https://linear.app/x', name: 'Rush' });
  });

  it('parses dispatch block with all optional subfields', () => {
    const def = validateProjectDef({
      name: 'rush',
      dispatch: { enabled: true, maxAgents: 3, provider: 'codex', host: 'mac-mini' },
    });
    expect(def.dispatch).toEqual({ enabled: true, maxAgents: 3, provider: 'codex', host: 'mac-mini' });
  });

  it('accepts a partial dispatch block', () => {
    const def = validateProjectDef({ name: 'rush', dispatch: { enabled: false } });
    expect(def.dispatch).toEqual({ enabled: false });
    expect(def.dispatch?.maxAgents).toBeUndefined();
  });

  it('ignores a non-finite or non-number maxAgents', () => {
    const def1 = validateProjectDef({ name: 'rush', dispatch: { maxAgents: 'five' } });
    expect(def1.dispatch?.maxAgents).toBeUndefined();
    const def2 = validateProjectDef({ name: 'rush', dispatch: { maxAgents: Infinity } });
    expect(def2.dispatch?.maxAgents).toBeUndefined();
  });

  it('omits dispatch entirely when the field is absent', () => {
    const def = validateProjectDef({ name: 'rush' });
    expect(def.dispatch).toBeUndefined();
  });

  it('accepts repos[].path (string) and drops an entry whose path is malformed', () => {
    const def = validateProjectDef({
      name: 'rush',
      repos: [
        { slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' },
        { slug: 'phnx-labs/bad', path: 42 },
      ],
    });
    expect(def.repos).toEqual([{ slug: 'phnx-labs/rush-infra', path: '~/src/rush-infra' }]);
  });

  it('keeps well-formed goals (measure optional) and drops entries without a string objective', () => {
    const def = validateProjectDef({
      name: 'rush',
      goals: [
        { objective: 'Ship agents-cli 2.0', measure: 'fleet on 2.x' },
        { objective: 'Grow adoption' },
        { measure: 'no objective' },
        { objective: 42 },
        'nope',
      ],
    });
    expect(def.goals).toEqual([
      { objective: 'Ship agents-cli 2.0', measure: 'fleet on 2.x' },
      { objective: 'Grow adoption' },
    ]);
  });
});

describe('write/load roundtrip', () => {
  it('normalizes root/defaultPath to home-relative and reads back', () => {
    const abs = path.join(HOME, 'src', 'github.com', 'me', 'rush');
    writeProjectDef({ name: 'rush', root: abs, defaultPath: path.join(abs, 'apps/web') });
    const raw = fs.readFileSync(path.join(dir, 'rush.yaml'), 'utf8');
    expect(raw).toContain('root: ~/src/github.com/me/rush');
    expect(raw).toContain('defaultPath: ~/src/github.com/me/rush/apps/web');

    const loaded = loadProjectDef('rush');
    expect(loaded?.name).toBe('rush');
    expect(loaded?.root).toBe('~/src/github.com/me/rush');
  });

  it('normalizes repos[].path to home-relative and preserves it through the roundtrip', () => {
    const abs = path.join(HOME, 'src', 'github.com', 'me', 'rush-infra');
    writeProjectDef({
      name: 'rush',
      root: path.join(HOME, 'src', 'github.com', 'me', 'rush'),
      repos: [{ slug: 'phnx-labs/rush-infra', subpath: 'deploy', path: abs }],
    });
    const raw = fs.readFileSync(path.join(dir, 'rush.yaml'), 'utf8');
    expect(raw).toContain('path: ~/src/github.com/me/rush-infra');

    const loaded = loadProjectDef('rush');
    expect(loaded?.repos).toEqual([
      { slug: 'phnx-labs/rush-infra', subpath: 'deploy', path: '~/src/github.com/me/rush-infra' },
    ]);
  });

  it('loadProjectDef returns undefined for an absent project', () => {
    expect(loadProjectDef('ghost')).toBeUndefined();
  });

  it('loadProjectDef throws on a bad name field and on a non-mapping (fail loud)', () => {
    fs.writeFileSync(path.join(dir, 'badname.yaml'), 'name: 123\n', 'utf8');
    expect(() => loadProjectDef('badname')).toThrow(/must be a valid slug/);
    fs.writeFileSync(path.join(dir, 'seq.yaml'), '- a\n- b\n', 'utf8');
    expect(() => loadProjectDef('seq')).toThrow(/mapping/);
  });
});

describe('listProjectDefs', () => {
  it('lists valid defs sorted', () => {
    writeProjectDef({ name: 'zeta' });
    writeProjectDef({ name: 'alpha' });
    const names = listProjectDefs().map((d) => d.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('surfaces a malformed definition instead of returning a false empty state', () => {
    writeProjectDef({ name: 'valid' });
    fs.writeFileSync(path.join(dir, 'broken.yaml'), '- a\n- b\n', 'utf8');
    expect(() => listProjectDefs()).toThrow(/mapping/);
  });

  it('ignores a .yml file so list and load agree on .yaml (no silent-drop)', () => {
    writeProjectDef({ name: 'real' });
    fs.writeFileSync(path.join(dir, 'ghost.yml'), 'name: ghost\n', 'utf8');
    // listed set is exactly the .yaml files...
    expect(listProjectDefs().map((d) => d.name)).toEqual(['real']);
    // ...and loadProjectDef agrees: the .yml is not loadable, so it's not "there".
    expect(loadProjectDef('ghost')).toBeUndefined();
  });

  it('is empty when the dir does not exist', () => {
    process.env.AGENTS_PROJECTS_DIR = path.join(dir, 'nope');
    expect(listProjectDefs()).toEqual([]);
  });
});

describe('removeProjectDef', () => {
  it('removes an existing def and reports false for a missing one', () => {
    writeProjectDef({ name: 'gone' });
    expect(removeProjectDef('gone')).toBe(true);
    expect(loadProjectDef('gone')).toBeUndefined();
    expect(removeProjectDef('gone')).toBe(false);
  });

  it('surfaces filesystem failures instead of reporting a missing project', () => {
    fs.mkdirSync(path.join(dir, 'blocked.yaml'));
    expect(() => removeProjectDef('blocked')).toThrow();
  });
});

describe('projectBasePath', () => {
  const def: ProjectDef = { name: 'rush', root: '~/src/rush', defaultPath: '~/src/rush/apps/web' };
  it('prefers defaultPath, keeps ~ for remote, expands for local', () => {
    expect(projectBasePath(def, true)).toBe('~/src/rush/apps/web');
    expect(projectBasePath(def, false)).toBe(path.join(HOME, 'src/rush/apps/web'));
  });
  it('falls back to root, and undefined when neither set', () => {
    expect(projectBasePath({ name: 'x', root: '~/r' }, true)).toBe('~/r');
    expect(projectBasePath({ name: 'x' }, true)).toBeUndefined();
  });
});

describe('resolveDefinedProjectPath', () => {
  const def: ProjectDef = { name: 'rush', root: '~/src/rush', defaultPath: '~/src/rush/apps/web' };
  it('no worktree → defaultPath, ~ kept for remote', () => {
    expect(resolveDefinedProjectPath(def, undefined, true)).toBe('~/src/rush/apps/web');
    expect(resolveDefinedProjectPath(def, undefined, false)).toBe(path.join(HOME, 'src/rush/apps/web'));
  });
  it('worktree hangs off the repo ROOT, not the defaultPath subdir', () => {
    expect(resolveDefinedProjectPath(def, 'fix', true)).toBe('~/src/rush/.agents/worktrees/fix');
    expect(resolveDefinedProjectPath(def, 'fix', false)).toBe(
      path.join(HOME, 'src/rush/.agents/worktrees/fix'),
    );
  });
  it('undefined when the definition has no root/defaultPath', () => {
    expect(resolveDefinedProjectPath({ name: 'bare' }, undefined, true)).toBeUndefined();
    expect(resolveDefinedProjectPath({ name: 'bare' }, 'wt', true)).toBeUndefined();
  });
});

describe('projectNameForCwd', () => {
  const defs: ProjectDef[] = [
    { name: 'rush', root: '~/src/rush' },
    { name: 'rush-web', root: '~/src/rush/apps/web' }, // nested — must win over rush
    { name: 'other', root: '~/src/other' },
  ];
  it('matches a cwd inside a project root, longest (nested) wins', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/rush/packages/api'), defs)).toBe('rush');
    expect(projectNameForCwd(path.join(HOME, 'src/rush/apps/web/components'), defs)).toBe('rush-web');
    expect(projectNameForCwd(path.join(HOME, 'src/rush'), defs)).toBe('rush');
  });
  it('matches a worktree under the project root', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/rush/.agents/worktrees/fix'), defs)).toBe('rush');
  });
  it('undefined for a cwd outside every project, or a sibling-prefix false match', () => {
    expect(projectNameForCwd(path.join(HOME, 'src/unrelated'), defs)).toBeUndefined();
    // ~/src/rush-extra must NOT match ~/src/rush (segment-aware, not string prefix)
    expect(projectNameForCwd(path.join(HOME, 'src/rush-extra/x'), defs)).toBeUndefined();
    expect(projectNameForCwd(undefined, defs)).toBeUndefined();
  });
});

/**
 * PHNX-3999 F08/F09 — what counts as a CONFIRMED project association, and what
 * must stay Uncategorized. The owner's recording (01:30–01:56) shows sessions
 * filed under groups nobody created, because the old answer was the basename of
 * the working directory, which always answers something.
 */
describe('confirmedProjectForCwd', () => {
  it('confirms a registered definition, including a nested one and a worktree', () => {
    const defs: ProjectDef[] = [
      { name: 'rush', root: '~/src/rush' },
      { name: 'rush-web', root: '~/src/rush/apps/web' },
    ];
    expect(confirmedProjectForCwd(path.join(HOME, 'src/rush/packages/api'), defs)).toBe('rush');
    expect(confirmedProjectForCwd(path.join(HOME, 'src/rush/apps/web/x'), defs)).toBe('rush-web');
    expect(confirmedProjectForCwd(path.join(HOME, 'src/rush/.agents/worktrees/fix'), defs)).toBe('rush');
  });

  it('leaves an unregistered GIT REPO unconfirmed — repository identity is not project membership', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unregistered-repo-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      // resolveProjectNameForCwd answers with the folder name; the confirmed
      // association deliberately does not.
      expect(resolveProjectNameForCwd(repo, [])).toBe(path.basename(repo));
      expect(confirmedProjectForCwd(repo, [])).toBeUndefined();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('leaves a loose directory and a spoofed worktree-shaped path unconfirmed', () => {
    const defs: ProjectDef[] = [{ name: 'rush', root: '~/src/rush' }];
    expect(confirmedProjectForCwd('/tmp/some-loose-dir', defs)).toBeUndefined();
    // A path that merely LOOKS like a worktree of a project is not membership.
    expect(confirmedProjectForCwd('/tmp/fake/.agents/worktrees/rush', defs)).toBeUndefined();
    expect(confirmedProjectForCwd(undefined, defs)).toBeUndefined();
  });
});

describe('listProjectDefsCached', () => {
  it('picks up an IN-PLACE edit of a definition, not only an add or a remove', () => {
    // The stamp is per FILE (mtime + size): retargeting a project's root rewrites
    // the file without touching the directory's mtime, and that is exactly the
    // edit that changes which sessions belong to the project.
    resetProjectDefsCache();
    writeProjectDef({ name: 'rush', root: '~/src/rush' });
    expect(confirmedProjectForCwd(path.join(HOME, 'src/rush/pkg'), listProjectDefsCached())).toBe('rush');
    expect(confirmedProjectForCwd(path.join(HOME, 'work/rush/pkg'), listProjectDefsCached())).toBeUndefined();

    writeProjectDef({ name: 'rush', root: '~/work/rush' });
    expect(confirmedProjectForCwd(path.join(HOME, 'work/rush/pkg'), listProjectDefsCached())).toBe('rush');
    expect(confirmedProjectForCwd(path.join(HOME, 'src/rush/pkg'), listProjectDefsCached())).toBeUndefined();
  });

  it('returns [] with no projects dir and re-reads once one appears', () => {
    resetProjectDefsCache();
    const missing = path.join(dir, 'not-created-yet');
    process.env.AGENTS_PROJECTS_DIR = missing;
    try {
      expect(listProjectDefsCached()).toEqual([]);
      fs.mkdirSync(missing, { recursive: true });
      writeProjectDef({ name: 'later', root: '~/src/later' });
      expect(listProjectDefsCached().map((d) => d.name)).toEqual(['later']);
    } finally {
      process.env.AGENTS_PROJECTS_DIR = dir;
      resetProjectDefsCache();
    }
  });
});

describe('resolveProjectNameForCwd', () => {
  it('prefers the defined project over the repo key', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-canonical-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      const sub = path.join(repo, 'apps', 'web');
      fs.mkdirSync(sub, { recursive: true });
      const defs: ProjectDef[] = [{ name: 'rush', root: repo }];
      expect(resolveProjectNameForCwd(sub, defs)).toBe('rush'); // def name, not the repo basename
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('falls back to the repository key for a cwd no definition contains — and with no defs at all', () => {
    // Real temp repo: the fallback does the fs walk and names the repo dir.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-fallback-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      const sub = path.join(repo, 'apps', 'cli');
      fs.mkdirSync(sub, { recursive: true });
      const elsewhere: ProjectDef[] = [{ name: 'rush', root: path.join(repo, 'elsewhere-def-root') }];
      expect(resolveProjectNameForCwd(sub, elsewhere)).toBe(path.basename(repo));
      expect(resolveProjectNameForCwd(sub, [])).toBe(path.basename(repo)); // == today's behavior
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('undefined for an empty cwd', () => {
    expect(resolveProjectNameForCwd(undefined, [])).toBeUndefined();
    expect(resolveProjectNameForCwd('', [])).toBeUndefined();
  });
});

describe('projectNameForCwd — monorepo subprojects', () => {
  const HOME_ = process.env.HOME ?? os.homedir();
  const mono = path.join(HOME_, 'src', 'rush');
  // Two projects sharing ONE checkout: the umbrella and a subdir project.
  const defs: ProjectDef[] = [
    { name: 'rush', root: '~/src/rush' },
    { name: 'rush-cli', root: '~/src/rush', defaultPath: '~/src/rush/apps/cli' },
  ];

  it('attributes work in the subdir to the SUBPROJECT, not the umbrella', () => {
    // `root ?? defaultPath` gave both defs the same anchor (~/src/rush), so the
    // longest-match tiebreak had nothing to separate them and the first listed
    // def won regardless of where the session actually was.
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli', 'src'), defs)).toBe('rush-cli');
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli'), defs)).toBe('rush-cli');
  });

  it('still attributes work outside the subdir to the umbrella', () => {
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), defs)).toBe('rush');
    expect(projectNameForCwd(mono, defs)).toBe('rush');
  });

  it('does not depend on definition order', () => {
    const reversed = [...defs].reverse();
    expect(projectNameForCwd(path.join(mono, 'apps', 'cli', 'x'), reversed)).toBe('rush-cli');
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), reversed)).toBe('rush');
  });

  it('anchors a bound repo checkout and its subpath too', () => {
    const withRepos: ProjectDef[] = [
      { name: 'umbrella', root: '~/src/rush' },
      { name: 'infra', root: '~/src/rush', repos: [{ slug: 'o/infra', path: '~/src/rush/infra', subpath: 'deploy' }] },
    ];
    expect(projectNameForCwd(path.join(mono, 'infra', 'deploy', 'k8s'), withRepos)).toBe('infra');
    expect(projectNameForCwd(path.join(mono, 'infra'), withRepos)).toBe('infra');
    expect(projectNameForCwd(path.join(mono, 'docs'), withRepos)).toBe('umbrella');
  });

  it('matches nothing outside every anchor', () => {
    expect(projectNameForCwd(path.join(HOME_, 'src', 'elsewhere'), defs)).toBeUndefined();
  });

  it('a lone narrowed project still owns the rest of its own checkout', () => {
    // The subdir claim must not shrink a project that has no umbrella beside it:
    // `--path` picks where an agent starts, not which work counts. Narrowing to
    // the subdir alone silently orphaned every session in the repo root and in
    // sibling subdirs.
    const solo: ProjectDef[] = [{ name: 'foo', root: '~/src/foo', defaultPath: '~/src/foo/apps/web' }];
    const repo = path.join(HOME_, 'src', 'foo');
    expect(projectNameForCwd(path.join(repo, 'apps', 'web'), solo)).toBe('foo');
    expect(projectNameForCwd(repo, solo)).toBe('foo');
    expect(projectNameForCwd(path.join(repo, 'apps', 'api'), solo)).toBe('foo');
    // Still bounded by the root.
    expect(projectNameForCwd(path.join(HOME_, 'src', 'bar'), solo)).toBeUndefined();
  });

  it('the umbrella outranks a subproject root even when listed second', () => {
    // The fallback must lose to any outright claim, in either definition order.
    const reversed = [...defs].reverse();
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), defs)).toBe('rush');
    expect(projectNameForCwd(path.join(mono, 'apps', 'web'), reversed)).toBe('rush');
    expect(projectNameForCwd(mono, defs)).toBe('rush');
    expect(projectNameForCwd(mono, reversed)).toBe('rush');
  });
});

describe('projectDirsAbs', () => {
  // Real directories on disk: the local branch filters by existence, so a
  // fixture that only pretends to exist would test nothing.
  let realA: string;
  let realB: string;

  beforeEach(() => {
    realA = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-dir-a-'));
    realB = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-dir-b-'));
  });
  afterEach(() => {
    fs.rmSync(realA, { recursive: true, force: true });
    fs.rmSync(realB, { recursive: true, force: true });
  });

  it('puts the cwd first, then each bound repo', () => {
    const def: ProjectDef = {
      name: 'multi',
      root: realA,
      repos: [{ slug: 'o/b', path: realB }],
    };
    expect(projectDirsAbs(def, { forRemote: false })).toEqual([realA, realB]);
  });

  it('collapses a repo row that points back at the primary', () => {
    // The natural way to declare a project is to list every directory including
    // the main one; that must not produce a duplicate grant.
    const def: ProjectDef = {
      name: 'dup',
      root: realA,
      repos: [{ slug: 'o/a', path: realA }, { slug: 'o/b', path: realB }],
    };
    expect(projectDirsAbs(def, { forRemote: false })).toEqual([realA, realB]);
  });

  it('drops a directory absent from THIS box, but keeps it for a remote spawn', () => {
    const missing = path.join(os.tmpdir(), 'proj-dir-does-not-exist-9f3a');
    const def: ProjectDef = {
      name: 'partial',
      root: realA,
      repos: [{ slug: 'o/gone', path: missing }],
    };
    // Local: a grant for a path that is not here is noise.
    expect(projectDirsAbs(def, { forRemote: false })).toEqual([realA]);
    // Remote: the target host has its own checkouts — this box's filesystem
    // must not decide what exists there.
    expect(projectDirsAbs(def, { forRemote: true })).toContain(missing);
  });

  it('joins subpath onto the bound directory', () => {
    const sub = path.join(realB, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    const def: ProjectDef = {
      name: 'mono',
      root: realA,
      repos: [{ slug: 'o/b', path: realB, subpath: 'apps/web' }],
    };
    expect(projectDirsAbs(def, { forRemote: false })).toEqual([realA, sub]);
  });

  it('keeps home-relative form for a remote spawn so ~ re-roots on the host', () => {
    const def: ProjectDef = {
      name: 'remote',
      root: '~/src/thing',
      repos: [{ slug: 'o/sys', path: '~/.agents/.system' }],
    };
    expect(projectDirsAbs(def, { forRemote: true })).toEqual([
      '~/src/thing',
      '~/.agents/.system',
    ]);
  });

  it('honors an explicit primary so a worktree run still grants the siblings', () => {
    // `--project slug@worktree` lands in the worktree, not in `root`; the
    // sibling repos must still come along.
    const wt = path.join(realA, '.agents', 'worktrees', 'feature');
    fs.mkdirSync(wt, { recursive: true });
    const def: ProjectDef = {
      name: 'wt',
      root: realA,
      repos: [{ slug: 'o/b', path: realB }],
    };
    expect(projectDirsAbs(def, { forRemote: false, primary: wt })).toEqual([wt, realB]);
  });

  it('is just the cwd when the project binds no extra directories', () => {
    expect(projectDirsAbs({ name: 'solo', root: realA }, { forRemote: false })).toEqual([realA]);
  });

  it('ignores a repo row that carries only a slug', () => {
    // `repos[].path` is the opt-in; a slug-only row is PR/CI metadata and names
    // nothing on disk to grant.
    const def: ProjectDef = {
      name: 'slugonly',
      root: realA,
      repos: [{ slug: 'o/no-checkout' }],
    };
    expect(projectDirsAbs(def, { forRemote: false })).toEqual([realA]);
  });
});
