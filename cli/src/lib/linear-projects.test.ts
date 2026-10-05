import { describe, expect, it } from 'vitest';
import {
  normalizeProjectKey,
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
