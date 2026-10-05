import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractAllPhaseTimes, extractPhaseTimes, isSetupStep } from './phases';
import type { BenchInput } from './types';

const fixtures = join(import.meta.dir, 'fixtures');

function load(name: string): BenchInput {
  return JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as BenchInput;
}

describe('extractPhaseTimes', () => {
  test('splits queue / setup / execution / report / e2e on the recorded Tests run', () => {
    const times = extractPhaseTimes(load('required-ci-run.json').runs[0]);
    expect(times).not.toBeNull();
    expect(times!.kind).toBe('required-ci');
    expect(times!.provider).toBe('github-hosted');
    expect(times!.excludedJobNames).toEqual(['windows']);
    expect(times!.includedJobNames).toEqual(['scope', 'cli-test-shard (1)', 'test']);

    expect(times!.queueMs).toBe(3_000);
    expect(times!.setupMs).toBe(27_000);
    expect(times!.executionMs).toBe(501_000);
    expect(times!.reportMs).toBe(27_000);
    expect(times!.e2eMs).toBe(582_000);
  });

  test('does not fold the Windows job into required-path e2e', () => {
    const times = extractPhaseTimes(load('required-ci-run.json').runs[0])!;
    expect(times.e2eMs).toBe(582_000);
    expect(times.excludedJobNames).toContain('windows');
  });

  test('drops cancelled runs', () => {
    const run = structuredClone(load('required-ci-run.json').runs[0]);
    run.conclusion = 'cancelled';
    expect(extractPhaseTimes(run)).toBeNull();
  });

  test('release fixture is tagged release and measured event-to-terminal', () => {
    const times = extractPhaseTimes(load('release-run.json').runs[0])!;
    expect(times.kind).toBe('release');
    expect(times.e2eMs).toBe(190_000);
    expect(times.queueMs).toBe(4_000);
  });

  test('classifies checkout / bun install as setup, not execution', () => {
    expect(isSetupStep('Run actions/checkout@sha')).toBe(true);
    expect(isSetupStep('Run bun install --frozen-lockfile')).toBe(true);
    expect(isSetupStep('Run node ./node_modules/vitest/vitest.mjs run --shard=1/3')).toBe(false);
  });
});

describe('extractAllPhaseTimes', () => {
  test('keeps github-hosted and crabbox runs as separate samples', () => {
    const times = extractAllPhaseTimes(load('provider-compare.json').runs);
    expect(times.map((t) => t.provider).sort()).toEqual(['crabbox', 'github-hosted']);
    const gh = times.find((t) => t.provider === 'github-hosted')!;
    const crab = times.find((t) => t.provider === 'crabbox')!;
    expect(gh.e2eMs).toBe(150_000);
    expect(crab.e2eMs).toBe(32_000);
  });
});
