import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeCheckpoint, readCheckpoint, type Checkpoint } from './checkpoint.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-checkpoint-test-'));
  return path.join(dir, 'checkpoint.json');
}

function sample(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: 'loop-123-abc',
    agent: 'claude',
    version: '2.1.170',
    prompt: 'do the thing',
    sessionId: '11111111-2222-3333-4444-555555555555',
    iteration: 2,
    loop: { until: 'signal', maxIterations: 5, budget: 100000, interval: '0' },
    loopSignal: { continue: true, reason: 'more work' },
    cumulativeTokens: 4242,
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:01:00.000Z',
    ...overrides,
  };
}

describe('checkpoint round-trip', () => {
  it('writes and reads back every field intact', () => {
    const file = tmpFile();
    const cp = sample();
    writeCheckpoint(cp, file);
    const back = readCheckpoint(file);
    expect(back).toEqual(cp);
  });

  it('preserves the loop config (the resume-critical state)', () => {
    const file = tmpFile();
    const cp = sample({ iteration: 7, cumulativeTokens: 999 });
    writeCheckpoint(cp, file);
    const back = readCheckpoint(file)!;
    expect(back.iteration).toBe(7);
    expect(back.cumulativeTokens).toBe(999);
    expect(back.loop.maxIterations).toBe(5);
    expect(back.loop.budget).toBe(100000);
    expect(back.sessionId).toBe(cp.sessionId);
  });
});

describe('atomic write', () => {
  it('leaves no .tmp file behind after a successful write', () => {
    const file = tmpFile();
    writeCheckpoint(sample(), file);
    const dir = path.dirname(file);
    const leftover = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftover).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('overwrites an existing checkpoint in place (rename, not append)', () => {
    const file = tmpFile();
    writeCheckpoint(sample({ iteration: 1 }), file);
    writeCheckpoint(sample({ iteration: 2 }), file);
    const back = readCheckpoint(file)!;
    expect(back.iteration).toBe(2);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf-8'))).not.toThrow();
  });
});

describe('readCheckpoint corruption handling', () => {
  it('returns null for a missing file', () => {
    const file = tmpFile();
    expect(readCheckpoint(file)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not valid json', 'utf-8');
    expect(readCheckpoint(file)).toBeNull();
  });

  it('returns null when required fields are missing (shape guard)', () => {
    const file = tmpFile();
    fs.writeFileSync(file, JSON.stringify({ agent: 'claude' }), 'utf-8');
    expect(readCheckpoint(file)).toBeNull();
  });
});
