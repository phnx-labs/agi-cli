import { describe, expect, test } from 'bun:test';
import { exactPercentile, gatedPercentile, minSamplesForPercentile } from './percentile';

describe('minSamplesForPercentile', () => {
  test('P99 / P99.9 / P99.99 require 100 / 1000 / 10000 observations', () => {
    expect(minSamplesForPercentile(99)).toBe(100);
    expect(minSamplesForPercentile(99.9)).toBe(1000);
    expect(minSamplesForPercentile(99.99)).toBe(10_000);
  });

  test('P50 needs 2 and P90 needs 10', () => {
    expect(minSamplesForPercentile(50)).toBe(2);
    expect(minSamplesForPercentile(90)).toBe(10);
  });

  test('rejects a percentile outside [0, 100]', () => {
    expect(() => minSamplesForPercentile(-1)).toThrow(RangeError);
    expect(() => minSamplesForPercentile(101)).toThrow(RangeError);
  });
});

describe('exactPercentile', () => {
  test('returns an observed sample — never interpolates the midpoint', () => {
    expect(exactPercentile([10, 20], 50)).toBe(10);
    expect(exactPercentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  test('P99 of 1..100 is the 99th observed value', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(exactPercentile(sorted, 99)).toBe(99);
    expect(exactPercentile(sorted, 100)).toBe(100);
    expect(exactPercentile(sorted, 0)).toBe(1);
  });

  test('P99.99 of 10000 samples is the last observed value', () => {
    const sorted = Array.from({ length: 10_000 }, (_, i) => i + 1);
    expect(exactPercentile(sorted, 99.99)).toBe(9999);
    expect(exactPercentile(sorted, 99.9)).toBe(9990);
    expect(exactPercentile(sorted, 100)).toBe(10_000);
  });
});

describe('gatedPercentile', () => {
  test('refuses P99.99 when n is 200', () => {
    const values = Array.from({ length: 200 }, (_, i) => i);
    const gated = gatedPercentile(values, 99.99);
    expect(gated).toEqual({
      p: 99.99,
      n: 200,
      required: 10_000,
      status: 'insufficient-sample',
      valueMs: null,
      rank: null,
    });
  });

  test('refuses P99 when n is 99 and emits the observed rank at n=100', () => {
    expect(gatedPercentile(Array.from({ length: 99 }, (_, i) => i), 99).status)
      .toBe('insufficient-sample');
    const ok = gatedPercentile(Array.from({ length: 100 }, (_, i) => (i + 1) * 10), 99);
    expect(ok.status).toBe('ok');
    expect(ok.valueMs).toBe(990);
    expect(ok.rank).toBe(99);
  });
});
