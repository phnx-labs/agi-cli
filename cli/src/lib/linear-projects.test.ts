import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeProjectKey,
  linearSpawnEnv,
  listLinearProjects,
  matchLinearProject,
  nextLinearLink,
  pickLinearProject,
  type LinearProjectLite,
} from './linear-projects.js';


describe('normalizeProjectKey', () => {
  it('collapses name / slug / folder to one key', () => {
    expect(normalizeProjectKey('Agents CLI')).toBe('agentscli');
    expect(normalizeProjectKey('phnx-labs/agents-cli')).toBe('agentscli');
    expect(normalizeProjectKey('/Users/me/src/github.com/phnx-labs/agents-cli')).toBe('agentscli');
    expect(normalizeProjectKey('rush_app')).toBe('rushapp');
    expect(normalizeProjectKey('')).toBe('');
  });
});

const PROJECTS: LinearProjectLite[] = [
  { id: 'a', name: 'Agents CLI' },
  { id: 'b', name: 'Rush App' },
  { id: 'c', name: 'Prix' },
];

describe('matchLinearProject', () => {
  it('exact normalized match wins', () => {
    expect(matchLinearProject('phnx-labs/agents-cli', PROJECTS)?.id).toBe('a');
    expect(matchLinearProject('rush-app', PROJECTS)?.id).toBe('b');
  });

  it('containment fallback for near names', () => {
    expect(matchLinearProject('agents-cli-web', PROJECTS)?.id).toBe('a');
  });

  it('no match returns undefined', () => {
    expect(matchLinearProject('totally-unrelated', PROJECTS)).toBeUndefined();
    expect(matchLinearProject('', PROJECTS)).toBeUndefined();
  });
});

describe('pickLinearProject', () => {
  it('matches an exact id', () => {
    expect(pickLinearProject('b', PROJECTS)).toEqual({ kind: 'match', project: PROJECTS[1] });
  });

  it('matches an exact normalized name (case / separators ignored)', () => {
    expect(pickLinearProject('agents-cli', PROJECTS)).toEqual({ kind: 'match', project: PROJECTS[0] });
    expect(pickLinearProject('Rush App', PROJECTS)).toEqual({ kind: 'match', project: PROJECTS[1] });
  });

  it('matches a repo slug via its last segment', () => {
    expect(pickLinearProject('phnx-labs/agents-cli', PROJECTS)).toEqual({ kind: 'match', project: PROJECTS[0] });
  });

  it('two exact-name peers are candidates, never a guess', () => {
    const dupes = [...PROJECTS, { id: 'a2', name: 'agents cli' }];
    const pick = pickLinearProject('Agents CLI', dupes);
    expect(pick.kind).toBe('candidates');
    expect((pick as { projects: LinearProjectLite[] }).projects.map((p) => p.id)).toEqual(['a', 'a2']);
  });

  it('containment-only matches come back as candidates', () => {
    const pick = pickLinearProject('agents-cli-web', PROJECTS);
    expect(pick).toEqual({ kind: 'candidates', projects: [PROJECTS[0]] });
  });

  it('no match is none, and an empty query is none', () => {
    expect(pickLinearProject('totally-unrelated', PROJECTS)).toEqual({ kind: 'none' });
    expect(pickLinearProject('   ', PROJECTS)).toEqual({ kind: 'none' });
  });
});


describe('nextLinearLink', () => {
  it('refreshes a stale name when the Linear project was renamed', () => {
    const prior = { projectId: 'lin_1', name: 'Agents CLI' };
    expect(nextLinearLink(prior, { id: 'lin_1', name: 'AGI' })).toEqual({ projectId: 'lin_1', name: 'AGI' });
  });

  it('writes name and id on a first link', () => {
    expect(nextLinearLink(undefined, { id: 'lin_1', name: 'AGI' })).toEqual({ projectId: 'lin_1', name: 'AGI' });
  });

  it('keeps a stored url when re-linking the SAME project without one', () => {
    const prior = { projectId: 'lin_1', name: 'AGI', url: 'https://linear.app/x/project/agi' };
    expect(nextLinearLink(prior, { id: 'lin_1', name: 'AGI' })).toEqual({
      projectId: 'lin_1',
      name: 'AGI',
      url: 'https://linear.app/x/project/agi',
    });
  });

  it('drops the old url when re-linking to a DIFFERENT project that has none', () => {
    const prior = { projectId: 'lin_old', name: 'Rush CLI', url: 'https://linear.app/x/project/rush-cli' };
    expect(nextLinearLink(prior, { id: 'lin_new', name: 'Rush' })).toEqual({ projectId: 'lin_new', name: 'Rush' });
  });

  it('drops a url the prior block carried WITHOUT a projectId', () => {
    const prior = { url: 'https://linear.app/acme/project/old-thing' };
    expect(nextLinearLink(prior, { id: 'lin_new', name: 'New Thing' })).toEqual({
      projectId: 'lin_new',
      name: 'New Thing',
    });
  });

  it('takes the incoming url when the new row carries one', () => {
    const prior = { projectId: 'lin_old', name: 'Rush CLI', url: 'https://linear.app/x/project/rush-cli' };
    expect(nextLinearLink(prior, { id: 'lin_new', name: 'Rush', url: 'https://linear.app/x/project/rush' })).toEqual({
      projectId: 'lin_new',
      name: 'Rush',
      url: 'https://linear.app/x/project/rush',
    });
  });
});

describe('nextLinearLink profile', () => {
  const talora = { id: 'lin_t', name: 'Talora' };
  it('writes the profile it is given, and keeps a stored one when re-linked without it', () => {
    expect(nextLinearLink(undefined, talora, 'personal')).toEqual({ projectId: 'lin_t', name: 'Talora', profile: 'personal' });
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora', profile: 'personal' }, talora)).toEqual({ projectId: 'lin_t', name: 'Talora', profile: 'personal' });
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora', profile: 'personal' }, talora, 'work').profile).toBe('work');
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora' }, talora)).toEqual({ projectId: 'lin_t', name: 'Talora' });
  });
});

describe('linearSpawnEnv', () => {
  it('returns the base env untouched without a profile, and adds LINEAR_PROFILE with one', () => {
    const base = { PATH: '/usr/bin', LINEAR_API_KEY: 'k' };
    expect(linearSpawnEnv(undefined, base)).toBe(base);
    expect(linearSpawnEnv('personal', base)).toEqual({ PATH: '/usr/bin', LINEAR_API_KEY: 'k', LINEAR_PROFILE: 'personal' });
    expect(base).toEqual({ PATH: '/usr/bin', LINEAR_API_KEY: 'k' });
  });
});

describe.skipIf(process.platform === 'win32')('listLinearProjects', () => {
  let bin: string;
  let priorPath: string | undefined;
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-bin-'));
    // A real executable standing in for linear-cli: echoes its argv back as a project row.
    fs.writeFileSync(path.join(bin, 'linear'), [
      '#!/bin/sh',
      'if [ "$2" = "gone" ]; then echo "linear: error: unknown profile gone" >&2; exit 2; fi',
      'printf \'[{"id":"%s","name":"Row"}]\' "$*"',
      '',
    ].join('\n'), { mode: 0o755 });
    priorPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${priorPath ?? ''}`;
  });
  afterEach(() => {
    process.env.PATH = priorPath;
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it('asks the default workspace without a profile and the named one with it', () => {
    expect(listLinearProjects()).toEqual([{ id: 'projects --json', name: 'Row' }]);
    expect(listLinearProjects('personal')).toEqual([{ id: '--profile personal projects --json', name: 'Row' }]);
  });

  it('fails naming the profile and linear\'s own reason when the profile cannot be read', () => {
    expect(() => listLinearProjects('gone')).toThrow(/profile "gone".*unknown profile gone/);
  });
});
