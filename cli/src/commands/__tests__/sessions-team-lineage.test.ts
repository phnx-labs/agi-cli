/**
 * Team lineage + the `--device` browser gate.
 *
 * Two links that existed on disk but never reached the listing: the team a
 * session spawned (derived at scan time, dropped at the DB write) and the team a
 * teammate belongs to (parsed from its meta.json, then discarded). Plus the flag
 * gate that decides whether an explicit `--device` opens the interactive browser
 * or falls back to the legacy per-host SSH stream.
 */

import { describe, it, expect } from 'vitest';
import { applyScopeFilters, artifactLookupScope, buildRoutineChoices, buildRoutineRunGroups, filterSessionsByRoutine, formatPickerLabel, hasNoBrowserDisqualifyingFlags, matchesTeam, resolveRoutineName, teamBadge } from '../sessions.js';
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

describe('hasNoBrowserDisqualifyingFlags — which views the browser can represent', () => {
  it('a bare listing qualifies', () => {
    expect(hasNoBrowserDisqualifyingFlags({}, undefined)).toBe(true);
  });

  it('a positional query does not — the peer runs FTS the browser cannot', () => {
    // The browser's `s` search is a cheap substring test over visible fields;
    // routing a query there would silently weaken it to less than the peer does.
    expect(hasNoBrowserDisqualifyingFlags({}, 'auth bug')).toBe(false);
  });

  it('every render/filter flag the picker cannot express disqualifies', () => {
    for (const opts of [
      { flat: true },
      { tree: true },
      { markdown: true },
      { until: '2026-01-01' },
      { project: 'agents-cli' },
      { sort: 'cost' },
      { artifacts: true },
      { artifact: 'x' },
    ]) {
      expect(hasNoBrowserDisqualifyingFlags(opts, undefined)).toBe(false);
    }
  });

  it('keeps routine views grouped while routing a named team view through the shared browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ routine: true }, undefined)).toBe(false);
    expect(hasNoBrowserDisqualifyingFlags({ routine: 'nightly-review' }, undefined)).toBe(false);
    expect(hasNoBrowserDisqualifyingFlags({ teams: true, inTeam: 'redesign' }, undefined)).toBe(true);
  });

  it('keeps the bare grouped --teams report out of the flat browser', () => {
    expect(hasNoBrowserDisqualifyingFlags({ teams: true }, undefined)).toBe(false);
  });

  it('--cloud disqualifies: it lists provider tasks and has no host scope', () => {
    // Without this, `--device box --cloud` fell through the device routing guard and
    // reached runCloudSessions, which silently drops the device the user named.
    expect(hasNoBrowserDisqualifyingFlags({ cloud: true }, undefined)).toBe(false);
  });

  it('one host qualifies; two do not, because `y` can only copy back one --device', () => {
    expect(hasNoBrowserDisqualifyingFlags({ host: ['zion'] }, undefined)).toBe(true);
    expect(hasNoBrowserDisqualifyingFlags({ host: ['zion', 'mac-mini'] }, undefined)).toBe(false);
  });
});

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

  it('removes another routine before a positional session ID can resolve', async () => {
    const wanted = meta({ id: 'wanted-id', shortId: 'wanted', origin: 'routine', routineName: 'nightly-review' });
    const other = meta({ id: 'other-id', shortId: 'other', origin: 'routine', routineName: 'security-scan' });
    const filtered = await filterSessionsByRoutine([wanted, other], 'nightly', false);

    expect(filtered).not.toBeNull();
    expect(resolveSessionById(filtered!, 'other-id')).toEqual([]);
    expect(resolveSessionById(filtered!, 'wanted-id')).toEqual([wanted]);
    const globallyScoped = applyScopeFilters([wanted, other], { routine: 'nightly' });
    expect(resolveSessionById(globallyScoped, 'other-id')).toEqual([]);
    expect(resolveSessionById(globallyScoped, 'wanted-id')).toEqual([wanted]);
  });
});

describe('artifact lookup routine scope', () => {
  it('excludes a session from another routine before resolving its artifacts', () => {
    const wanted = meta({ id: 'wanted-id', origin: 'routine', routineName: 'nightly-review' });
    const other = meta({ id: 'other-id', origin: 'routine', routineName: 'release-notes' });
    const scoped = applyScopeFilters(
      [wanted, other],
      artifactLookupScope(undefined, undefined, 'nightly-review'),
    );
    expect(resolveSessionById(scoped, 'other-id')).toEqual([]);
    expect(resolveSessionById(scoped, 'wanted-id')).toEqual([wanted]);
  });
});

describe('routine picker and run grouping', () => {
  const sessions = [
    meta({ id: 'a', shortId: 'a', origin: 'routine', routineName: 'nightly', routineRunId: 'run-2', timestamp: '2026-08-05T02:00:00.000Z' }),
    meta({ id: 'b', shortId: 'b', origin: 'routine', routineName: 'nightly', routineRunId: 'run-2', timestamp: '2026-08-05T02:01:00.000Z' }),
    meta({ id: 'c', shortId: 'c', origin: 'routine', routineName: 'nightly', routineRunId: 'run-1', timestamp: '2026-08-04T02:00:00.000Z' }),
    meta({ id: 'd', shortId: 'd', origin: 'routine', routineName: 'weekly', routineRunId: 'weekly-1', timestamp: '2026-08-03T02:00:00.000Z' }),
  ];

  it('summarizes last run, run count, and session count for each routine', () => {
    expect(buildRoutineChoices(sessions)).toEqual([
      { name: 'nightly', lastRunAt: '2026-08-05T02:01:00.000Z', runCount: 2, latestRunSessionCount: 2 },
      { name: 'weekly', lastRunAt: '2026-08-03T02:00:00.000Z', runCount: 1, latestRunSessionCount: 1 },
    ]);
  });

  it('groups selected sessions by run id and newest timestamp', () => {
    const groups = buildRoutineRunGroups(sessions.slice(0, 3));
    expect(groups.map((group) => [group.runId, group.timestamp, group.sessions.length])).toEqual([
      ['run-2', '2026-08-05T02:01:00.000Z', 2],
      ['run-1', '2026-08-04T02:00:00.000Z', 1],
    ]);
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
    // A team started outside any agent session records no parent_session_id.
    const line = strip(formatTeamLineage(meta({ teamOrigin: { handle: 'ui', team: 'redesign' } })));
    expect(line).toContain('redesign');
    expect(line).not.toContain('spawned by');
  });

  it('is empty for a session with no team involvement', () => {
    expect(formatTeamLineage(meta())).toBe('');
  });
});

describe('peer-supplied team data is neither trusted nor rendered raw', () => {
  // parseRemoteList copies a peer's JSON through without inspecting its fields
  // (lib/session/remote-list.ts), and enrichTeamOrigins deliberately leaves an
  // already-populated teamOrigin alone — so both the type and the content of these
  // fields belong to another machine.
  it('does not throw on a non-string spawnedTeam or team', () => {
    // teamBadge runs on EVERY picker row, so one malformed row used to take down
    // the whole listing rather than degrade a single entry.
    const bad = { ...meta(), spawnedTeam: 99 as unknown as string };
    expect(() => teamBadge(bad)).not.toThrow();
    expect(teamBadge(bad).plain).toBe('');
    expect(() => matchesTeam(bad, 'redesign')).not.toThrow();
    expect(matchesTeam(bad, 'redesign')).toBe(false);

    const badOrigin = { ...meta(), teamOrigin: { team: 42 as unknown as string, handle: 7 as unknown as string } };
    expect(() => formatTeamLineage(badOrigin)).not.toThrow();
  });

  it('strips terminal escapes out of the team name on the row', () => {
    // The row path never went through sanitizeMeta (that is preview-only), so a
    // peer's escape sequence reached the terminal through the new team: badge.
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
    // In the browser the needle is `f.team`, taken off a cycle built from rows
    // another machine sent — so it is peer-derived exactly like the fields it is
    // compared against, and it runs over every row in the pool.
    expect(() => matchesTeam(meta({ spawnedTeam: 'redesign' }), 42 as unknown as string)).not.toThrow();
    expect(matchesTeam(meta({ spawnedTeam: 'redesign' }), 42 as unknown as string)).toBe(true);
  });

  it('treats an all-whitespace needle as no filter', () => {
    expect(matchesTeam(meta(), '   ')).toBe(true);
  });
});
