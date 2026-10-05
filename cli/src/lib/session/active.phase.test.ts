import { describe, it, expect } from 'vitest';
import { derivePhase, foldPhase, type ActiveSession, type ActiveStatus, type SessionPhase } from './active.js';

describe('derivePhase', () => {
  const cases: Array<[ActiveStatus, SessionPhase]> = [
    ['running', 'running'],
    ['queued', 'running'],
    ['input_required', 'waiting'],
    ['abandoned', 'failed'],
    ['orphaned', 'failed'],
    ['crashed', 'failed'],
    ['closed', 'done'],
    ['idle', 'idle'],
    ['unknown', 'idle'],
  ];
  for (const [status, phase] of cases) {
    it(`maps ${status} -> ${phase}`, () => {
      expect(derivePhase(status)).toBe(phase);
    });
  }

  it('buckets orphaned/crashed to failed, never idle', () => {
    expect(derivePhase('orphaned')).not.toBe('idle');
    expect(derivePhase('crashed')).not.toBe('idle');
  });

  it('treats an absent status as idle rather than throwing', () => {
    expect(derivePhase(undefined)).toBe('idle');
  });
});

describe('foldPhase', () => {
  it('projects phase onto every row from its finalized status', () => {
    const rows = [
      { context: 'cli', kind: 'claude', status: 'running' },
      { context: 'cli', kind: 'claude', status: 'crashed' },
      { context: 'cli', kind: 'claude', status: 'input_required' },
    ] as unknown as ActiveSession[];
    foldPhase(rows);
    expect(rows.map((r) => r.phase)).toEqual(['running', 'failed', 'waiting']);
  });
});
