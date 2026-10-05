import { describe, it, expect } from 'vitest';
import { detectRepeatedGuardBlocks } from './friction-heuristics.js';
import type { EventRecord } from './feed/events.js';

function friction(overrides: Partial<EventRecord> & { surface: string; failureId: string }): EventRecord {
  return {
    ts: '2026-01-01T00:00:00.000Z',
    tz: '+00:00',
    tzName: 'UTC',
    hostname: 'zion',
    platform: 'linux',
    arch: 'x64',
    pid: 1,
    ppid: 1,
    event: 'friction',
    level: 'audit',
    caller: 'cli',
    osUser: 'muqsit',
    transport: 'local',
    ...overrides,
  } as EventRecord;
}

describe('detectRepeatedGuardBlocks', () => {
  it('flags a session that hits the same guard block 3+ times', () => {
    const events = [
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard', ts: '2026-01-01T00:00:00Z' }),
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard', ts: '2026-01-01T00:01:00Z' }),
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard', ts: '2026-01-01T00:02:00Z' }),
    ];
    const findings = detectRepeatedGuardBlocks(events);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      session: 's1', surface: 'guard', failureId: 'git.reset-hard', count: 3,
      firstTs: '2026-01-01T00:00:00Z', lastTs: '2026-01-01T00:02:00Z',
    });
  });

  it('does not flag a single block, or blocks under the threshold', () => {
    const events = [
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard' }),
    ];
    expect(detectRepeatedGuardBlocks(events)).toEqual([]);
  });

  it('keeps different sessions, surfaces, and failure ids as separate groups', () => {
    const events = [
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's1', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's2', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's2', surface: 'guard', failureId: 'git.reset-hard' }),
      friction({ session: 's1', surface: 'guard', failureId: 'rm.recursive-force' }),
    ];
    const findings = detectRepeatedGuardBlocks(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].session).toBe('s1');
    expect(findings[0].failureId).toBe('git.reset-hard');
  });

  it('ignores non-friction events and events missing surface/failureId', () => {
    const events = [
      { ...friction({ session: 's1', surface: 'guard', failureId: 'x' }), event: 'command.end' } as EventRecord,
      friction({ session: 's1', surface: '', failureId: 'x' }),
      friction({ session: 's1', surface: 'guard', failureId: 'x' }),
      friction({ session: 's1', surface: 'guard', failureId: 'x' }),
      friction({ session: 's1', surface: 'guard', failureId: 'x' }),
    ];
    const findings = detectRepeatedGuardBlocks(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].count).toBe(3);
  });

  it('groups friction events with no session under "unknown"', () => {
    const events = [
      friction({ surface: 'guard', failureId: 'x' }),
      friction({ surface: 'guard', failureId: 'x' }),
      friction({ surface: 'guard', failureId: 'x' }),
    ];
    const findings = detectRepeatedGuardBlocks(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].session).toBe('unknown');
  });

  it('respects a custom minRepeats threshold', () => {
    const events = [
      friction({ session: 's1', surface: 'guard', failureId: 'x' }),
      friction({ session: 's1', surface: 'guard', failureId: 'x' }),
    ];
    expect(detectRepeatedGuardBlocks(events, { minRepeats: 2 })).toHaveLength(1);
    expect(detectRepeatedGuardBlocks(events, { minRepeats: 3 })).toHaveLength(0);
  });
});
