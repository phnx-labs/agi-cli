
import { describe, it, expect } from 'vitest';
import { applyScopeFilters, matchesTeam } from '../../lib/session/selection.js';
import { formatPickerLabel, teamBadge } from '../../lib/session/presentation.js';
import { resolveRoutineName } from '../ps-roster.js';
import { resolveSessionById } from '../../lib/session/discover.js';
import { formatTeamLineage } from '../sessions-picker.js';
import type { SessionMeta } from '@phnx-labs/sessions-cli/reader';

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abcdef01-2345-6789-abcd-ef0123456789',
    shortId: 'abcdef01',
    agent: 'claude',
    timestamp: '2026-08-01T12:00:00.000Z',
    filePath: '/tmp/sess.jsonl',
    ...over,
  };
}

describe('resolveRoutineName', () => {
  const names = ['nightly-review', 'release-notes', 'security-scan'];

  it('resolves exact, unique substring, and unambiguous typo matches', () => {
    expect(resolveRoutineName('NIGHTLY-REVIEW', names)).toBe('nightly-review');
    expect(resolveRoutineName('release', names)).toBe('release-notes');
    expect(resolveRoutineName('securty-scan', names)).toBe('security-scan');
  });

  it('rejects missing and ambiguous selectors', () => {
    expect(resolveRoutineName('missing', names)).toBeNull();
    expect(resolveRoutineName('notes', ['release-notes', 'meeting-notes'])).toBeNull();
  });

  it('removes another routine before a positional session ID can resolve', () => {
    const wanted = meta({ id: 'wanted-id', shortId: 'wanted', origin: 'routine', routineName: 'nightly-review' });
    const other = meta({ id: 'other-id', shortId: 'other', origin: 'routine', routineName: 'security-scan' });
    const globallyScoped = applyScopeFilters([wanted, other], { routine: 'nightly' });
    expect(resolveSessionById(globallyScoped, 'other-id')).toEqual([]);
    expect(resolveSessionById(globallyScoped, 'wanted-id')).toEqual([wanted]);
  });
});

describe('matchesTeam — --in-team spans both ends of the lineage', () => {
  it('matches the session that spawned the team', () => {
    expect(matchesTeam(meta({ spawnedTeam: 'redesign' }), 'redesign')).toBe(true);
  });

  it('matches a teammate of that team', () => {
    expect(matchesTeam(meta({ teamOrigin: { handle: 'ui', team: 'redesign' } }), 'redesign')).toBe(true);
  });

  it('is case-insensitive, like the SQL predicate behind querySessions', () => {
    expect(matchesTeam(meta({ spawnedTeam: 'ReDesign' }), 'redesign')).toBe(true);
  });

  it('rejects an unrelated session and a different team', () => {
    expect(matchesTeam(meta(), 'redesign')).toBe(false);
    expect(matchesTeam(meta({ spawnedTeam: 'other' }), 'redesign')).toBe(false);
  });
});

describe('formatTeamLineage — the preview pane Team: line', () => {
  it('names the team an orchestrator spawned, and where to get its counts', () => {
    const line = strip(formatTeamLineage(meta({ spawnedTeam: 'redesign' })));
    expect(line).toContain('spawned team redesign');
    expect(line).toContain('agents teams status redesign');
  });

  it('names a teammate\'s team, handle, mode, and the session that spawned it', () => {
    const line = strip(
      formatTeamLineage(
        meta({
          teamOrigin: {
            handle: 'resume-picker',
            mode: 'edit',
            team: 'redesign',
            parentSessionId: '21805f5f-1111-2222-3333-444444444444',
          },
        })
      )
    );
    expect(line).toContain('redesign');
    expect(line).toContain('teammate resume-picker (edit)');
    expect(line).toContain('spawned by 21805f5f');
  });

  it('omits the orchestrator when the record carries no parent session', () => {
    const line = strip(formatTeamLineage(meta({ teamOrigin: { handle: 'ui', team: 'redesign' } })));
    expect(line).toContain('redesign');
    expect(line).not.toContain('spawned by');
  });

  it('is empty for a session with no team involvement', () => {
    expect(formatTeamLineage(meta())).toBe('');
  });
});

describe('peer-supplied team data is neither trusted nor rendered raw', () => {
  it('does not throw on a non-string spawnedTeam or team', () => {
    const bad = { ...meta(), spawnedTeam: 99 as unknown as string };
    expect(() => teamBadge(bad)).not.toThrow();
    expect(teamBadge(bad).plain).toBe('');
    expect(() => matchesTeam(bad, 'redesign')).not.toThrow();
    expect(matchesTeam(bad, 'redesign')).toBe(false);

    const badOrigin = { ...meta(), teamOrigin: { team: 42 as unknown as string, handle: 7 as unknown as string } };
    expect(() => formatTeamLineage(badOrigin)).not.toThrow();
  });

  it('strips terminal escapes out of the team name on the row', () => {
    const row = formatPickerLabel(meta({ spawnedTeam: '\x1b[31mEVIL' }), '', {});
    expect(row).not.toContain('\x1b[31m');
    expect(strip(row)).toContain('EVIL');
  });

  it('strips terminal escapes out of a teammate tag and the lineage line', () => {
    const row = formatPickerLabel(
      meta({ teamOrigin: { team: '\x1b[31mred', handle: 'ui' } }),
      '',
      {}
    );
    expect(row).not.toContain('\x1b[31m');

    const line = formatTeamLineage(meta({ teamOrigin: { team: '\x1b]0;pwned\x07t', handle: 'ui' } }));
    expect(line).not.toContain('\x1b]0;');
  });
});

describe('matchesTeam guards its needle, not just the row', () => {
  it('does not throw when the team argument is not a string', () => {
    expect(() => matchesTeam(meta({ spawnedTeam: 'redesign' }), 42 as unknown as string)).not.toThrow();
    expect(matchesTeam(meta({ spawnedTeam: 'redesign' }), 42 as unknown as string)).toBe(true);
  });

  it('treats an all-whitespace needle as no filter', () => {
    expect(matchesTeam(meta(), '   ')).toBe(true);
  });
});
