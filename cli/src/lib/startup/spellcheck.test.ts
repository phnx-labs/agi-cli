import { describe, expect, it } from 'vitest';
import { closestTopLevelCommand } from './spellcheck.js';
import { KNOWN_TOP_LEVEL_COMMANDS } from './command-registry.js';

describe('closestTopLevelCommand', () => {
  it('auto-correct candidates for known typos use the full known-name set', () => {
    const { closest, minDist } = closestTopLevelCommand('devics', KNOWN_TOP_LEVEL_COMMANDS);
    expect(minDist).toBe(1);
    expect(closest).toBe('devices');
  });

  it('finds doctor for docto', () => {
    const { closest, minDist } = closestTopLevelCommand('docto', KNOWN_TOP_LEVEL_COMMANDS);
    expect(minDist).toBe(1);
    expect(closest).toBe('doctor');
  });

  it('preserves first-seen order on distance ties', () => {
    const { closest, minDist } = closestTopLevelCommand('aa', ['ab', 'ac', 'zz']);
    expect(minDist).toBe(1);
    expect(closest).toBe('ab');
  });

  it('returns null closest only when the candidate set is empty', () => {
    const { closest, minDist } = closestTopLevelCommand('anything', []);
    expect(closest).toBeNull();
    expect(minDist).toBe(Infinity);
  });

  it('suggests within distance 3 for near-misses that are not auto-corrected', () => {
    const { closest, minDist } = closestTopLevelCommand('devcs', KNOWN_TOP_LEVEL_COMMANDS);
    expect(minDist).toBeGreaterThan(1);
    expect(minDist).toBeLessThanOrEqual(3);
    expect(closest).toBe('devices');
  });
});
