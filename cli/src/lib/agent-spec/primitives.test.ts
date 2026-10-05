import { describe, it, expect } from 'vitest';
import { compareVersions, VERSION_RE } from './primitives.js';

describe('compareVersions — semver-ish numeric ordering', () => {
  it('orders by numeric segment, not lexical', () => {
    expect(compareVersions('2.1.187', '2.1.143')).toBeGreaterThan(0);
    expect(compareVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
  });

  it('sorts a claude version list ascending', () => {
    const sorted = ['2.1.187', '2.1.143', '2.1.90'].sort(compareVersions);
    expect(sorted).toEqual(['2.1.90', '2.1.143', '2.1.187']);
  });
});

describe('compareVersions — OpenClaw date-style versions', () => {
  it('orders yyyy.m.d correctly (real installed set)', () => {
    const sorted = ['2026.3.8', '2026.5.7', '2026.2.19-2'].sort(compareVersions);
    expect(sorted).toEqual(['2026.2.19-2', '2026.3.8', '2026.5.7']);
    expect(sorted[sorted.length - 1]).toBe('2026.5.7');
    expect(sorted[0]).toBe('2026.2.19-2');
  });

  it('breaks same-day -N ties deterministically (higher -N is newer)', () => {
    expect(compareVersions('2026.2.19-2', '2026.2.19-1')).toBeGreaterThan(0);
    expect(compareVersions('2026.2.19-2', '2026.2.19')).toBeGreaterThan(0);
    const sorted = ['2026.2.19', '2026.2.19-2', '2026.2.19-1'].sort(compareVersions);
    expect(sorted).toEqual(['2026.2.19', '2026.2.19-1', '2026.2.19-2']);
  });

  it('preserves legacy equality for numeric-equal versions (segment count / non-numeric tail)', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.beta', '1.0.0')).toBe(0);
  });
});

describe('VERSION_RE', () => {
  it('accepts latest, semver, and date-style versions', () => {
    for (const v of ['latest', '2.1.187', '0.130.0', '2026.2.19-2', '1.0.0-rc.1']) {
      expect(VERSION_RE.test(v)).toBe(true);
    }
  });

  it('rejects traversal, empty, and over-long strings', () => {
    expect(VERSION_RE.test('../../etc')).toBe(false);
    expect(VERSION_RE.test('a..b')).toBe(false);
    expect(VERSION_RE.test('')).toBe(false);
    expect(VERSION_RE.test('a'.repeat(65))).toBe(false);
    expect(VERSION_RE.test('a b')).toBe(false);
  });
});
