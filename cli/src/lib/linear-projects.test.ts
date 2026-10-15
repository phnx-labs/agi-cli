import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeProjectKey,
  linearProfileError,
  linearSpawnEnv,
  listLinearProjects,
  matchLinearProject,
  nextLinearLink,
  pickLinearProject,
  profileForIssueId,
  type LinearProjectLite,
} from './linear-projects.js';
import { installFakeLinear, type FakeLinear } from './__tests__/fake-linear.js';


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
  it('writes the profile it is given, keeps a stored one when re-linked without it, and clears it on false', () => {
    expect(nextLinearLink(undefined, talora, 'personal')).toEqual({ projectId: 'lin_t', name: 'Talora', profile: 'personal' });
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora', profile: 'personal' }, talora)).toEqual({ projectId: 'lin_t', name: 'Talora', profile: 'personal' });
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora', profile: 'personal' }, talora, 'work').profile).toBe('work');
    expect(nextLinearLink({ projectId: 'lin_t', name: 'Talora', profile: 'personal' }, talora, false)).toEqual({ projectId: 'lin_t', name: 'Talora' });
  });
});

describe('linearSpawnEnv', () => {
  it('pins the default workspace without a profile, and the profile with one', () => {
    const base = { PATH: '/usr/bin', LINEAR_API_KEY: 'k', LINEAR_PROFILE: 'exported-in-shell' };
    expect(linearSpawnEnv(undefined, base)).toEqual({ PATH: '/usr/bin', LINEAR_API_KEY: 'k', LINEAR_PROFILE: 'default' });
    expect(linearSpawnEnv('personal', base)).toEqual({ PATH: '/usr/bin', LINEAR_API_KEY: 'k', LINEAR_PROFILE: 'personal' });
    expect(base.LINEAR_PROFILE).toBe('exported-in-shell');
  });
});

describe('linearProfileError', () => {
  it('reserves default and refuses a name that is not a slug', () => {
    expect(linearProfileError('personal')).toBeNull();
    expect(linearProfileError('default')).toMatch(/reserved.*omit the profile/);
    expect(linearProfileError('../x')).toMatch(/profile name matches/);
  });
});

describe('profileForIssueId', () => {
  let home: string;
  const config = (dir: string, teamKey: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ teamKey }));
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-home-'));
    config(path.join(home, '.linear-cli'), 'PHNX');
    config(path.join(home, '.linear-cli', 'profiles', 'personal'), 'TAL');
    config(path.join(home, '.linear-cli', 'profiles', 'client'), 'ACME');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('maps an issue to the profile whose team owns it, and everything else to the default workspace', () => {
    expect(profileForIssueId('TAL-12', home)).toBe('personal');
    expect(profileForIssueId('ACME-3', home)).toBe('client');
    expect(profileForIssueId('PHNX-4235', home)).toBeUndefined();
    expect(profileForIssueId('NOPE-1', home)).toBeUndefined();
    expect(profileForIssueId('TAL-12', path.join(home, 'empty'))).toBeUndefined();
  });

  it('lets the default workspace win a team key it shares, and refuses a key two profiles claim', () => {
    config(path.join(home, '.linear-cli', 'profiles', 'old'), 'PHNX');
    expect(profileForIssueId('PHNX-1', home)).toBeUndefined();
    config(path.join(home, '.linear-cli', 'profiles', 'twin'), 'TAL');
    expect(() => profileForIssueId('TAL-1', home)).toThrow(/TAL is in more than one linear-cli profile/);
  });
});

describe.skipIf(process.platform === 'win32')('listLinearProjects', () => {
  let linear: FakeLinear;
  beforeEach(() => {
    linear = installFakeLinear({
      'projects --json': '[{"id":"lin_d","name":"Default"}]',
      '--profile personal projects --json': '[{"id":"lin_p","name":"Personal"}]',
      '--profile gone projects --json': { stderr: 'linear: error: unknown profile gone\n', code: 2 },
    });
  });
  afterEach(() => linear.restore());

  it('asks the default workspace without a profile and the named one with it, pinning LINEAR_PROFILE', () => {
    expect(listLinearProjects()).toEqual([{ id: 'lin_d', name: 'Default' }]);
    expect(listLinearProjects('personal')).toEqual([{ id: 'lin_p', name: 'Personal' }]);
    expect(linear.calls()).toEqual([
      { profile: 'default', argv: 'projects --json' },
      { profile: 'personal', argv: '--profile personal projects --json' },
    ]);
  });

  it('fails naming the profile and linear\'s own reason when the profile cannot be read', () => {
    expect(() => listLinearProjects('gone')).toThrow(/profile "gone".*unknown profile gone/);
  });
});
