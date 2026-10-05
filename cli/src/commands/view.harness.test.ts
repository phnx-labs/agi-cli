import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHarnessBlocks } from './view.js';
import { profileSummary } from '../lib/profiles.js';
import * as versions from '../lib/installations/versions.js';
import type { AgentId } from '../lib/types.js';

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function plain(): string {
  // eslint-disable-next-line no-control-regex
  return lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

const deepseek = profileSummary({
  name: 'deepseek-flash',
  host: { agent: 'claude' },
  env: {
    ANTHROPIC_MODEL: 'deepseek/deepseek-v4-flash-0731',
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
  },
  provider: 'openrouter',
  forkedFrom: 'claude',
});

const installed = new Set<AgentId>(['claude']);

describe('renderHarnessBlocks — a custom harness is its own agent type', () => {
  it('prints the harness name as a block header, not as a row under its host', () => {
    renderHarnessBlocks([deepseek], installed, false);
    const out = plain();
    expect(out).toMatch(/^ {2}DeepSeek Flash \(custom\)$/m);
    expect(out).toMatch(/deepseek\/deepseek-v4-flash-0731/);
    expect(out).toMatch(/forked from claude/);
  });

  it('derives the header from the name and ignores a stored label field', () => {
    renderHarnessBlocks(
      [profileSummary({ name: 'spark', label: 'Muse Spark', host: { agent: 'opencode' }, env: { OPENCODE_MODEL: 'meta/muse-spark-1.1' } })],
      new Set<AgentId>(['opencode']),
      false,
    );
    expect(plain()).toMatch(/^ {2}Spark \(custom\)$/m);
  });

  it('leads the row with the pinned version followed by (forked from <host>)', () => {
    renderHarnessBlocks(
      [profileSummary({ name: 'spark', host: { agent: 'opencode', version: '1.16.0' }, env: { OPENCODE_MODEL: 'm' } })],
      new Set<AgentId>(['opencode']),
      false,
    );
    expect(plain()).toMatch(/1\.16\.0.*forked from opencode/);
    expect(plain()).not.toMatch(/via opencode/);
  });

  it('shows "tracks default" when the harness is unpinned and the host has a global default', () => {
    vi.spyOn(versions, 'getGlobalDefault').mockReturnValue('2.1.219');
    renderHarnessBlocks([deepseek], installed, false);
    const out = plain();
    expect(out).toMatch(/2\.1\.219.*forked from claude.*tracks default/);
  });

  it('shows fork lineage only when the parent is another custom harness', () => {
    renderHarnessBlocks(
      [profileSummary({ name: 'chat', host: { agent: 'claude' }, env: { ANTHROPIC_MODEL: 'm' }, forkedFrom: 'deepseek-flash' })],
      installed,
      false,
    );
    expect(plain()).toMatch(/\(custom · forked from deepseek-flash\)/);
  });

  it('shows chained lineage when the parent is itself a fork of a different host', () => {
    const parent = profileSummary({
      name: 'deepseek-flash',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'deepseek/m' },
      forkedFrom: 'claude',
    });
    const child = profileSummary({
      name: 'chat',
      host: { agent: 'claude' },
      env: { ANTHROPIC_MODEL: 'm' },
      forkedFrom: 'deepseek-flash',
    });
    renderHarnessBlocks([child, parent], installed, false);
    expect(plain()).toMatch(/forked from deepseek-flash -> claude/);
  });

  it('flags a harness whose host CLI is not installed instead of listing it as runnable', () => {
    renderHarnessBlocks([deepseek], new Set<AgentId>(), false);
    expect(plain()).toMatch(/host claude not installed/);
  });

  it('prints the YAML path only when paths were requested', () => {
    renderHarnessBlocks([deepseek], installed, false);
    expect(plain()).not.toMatch(/deepseek-flash\.yml/);
    lines = [];
    renderHarnessBlocks([deepseek], installed, true);
    expect(plain()).toMatch(/deepseek-flash\.yml/);
  });

  it('prints nothing when there are no custom harnesses', () => {
    renderHarnessBlocks([], installed, false);
    expect(lines).toEqual([]);
  });

  it('3-arg calls compile and run without a budget column', () => {
    expect(() => renderHarnessBlocks([deepseek], installed, false)).not.toThrow();
    expect(plain()).not.toMatch(/\$:/);
  });
});
