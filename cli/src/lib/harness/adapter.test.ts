import { describe, it, expect } from 'vitest';
import { ALL_AGENT_IDS } from '../agents.js';
import type { AgentId } from '../types.js';
import {
  resolveHarnessAdapter,
  listHarnessAdapters,
  stripForeignConfigDir,
  CONFIG_DIR_ENV_KEYS,
} from './index.js';

describe('harness adapter registry', () => {
  it('resolves an adapter for every AgentId (never throws, id preserved)', () => {
    for (const id of ALL_AGENT_IDS) {
      const adapter = resolveHarnessAdapter(id);
      expect(adapter.id).toBe(id);
    }
  });

  it('only registers valid AgentIds', () => {
    const all = new Set<AgentId>(ALL_AGENT_IDS);
    for (const id of listHarnessAdapters()) {
      expect(all.has(id)).toBe(true);
    }
  });
});

describe('stripForeignConfigDir', () => {
  it('deletes every config-dir key by default (the old `else` arm)', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: 'a',
      CODEX_HOME: 'b',
      COPILOT_HOME: 'c',
      KIMI_CODE_HOME: 'd',
      GROK_HOME: 'e',
      OPENCODE_CONFIG_DIR: 'f',
      XDG_CONFIG_HOME: 'g',
      XDG_DATA_HOME: 'h',
      UNRELATED: 'keep',
    };
    stripForeignConfigDir(env);
    for (const key of CONFIG_DIR_ENV_KEYS) expect(env[key]).toBeUndefined();
    expect(env.UNRELATED).toBe('keep');
  });

  it('keeps the one this harness sets', () => {
    const env: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: 'a',
      CODEX_HOME: 'b',
      COPILOT_HOME: 'c',
      KIMI_CODE_HOME: 'd',
      GROK_HOME: 'e',
    };
    stripForeignConfigDir(env, ['CODEX_HOME']);
    expect(env.CODEX_HOME).toBe('b');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.COPILOT_HOME).toBeUndefined();
    expect(env.KIMI_CODE_HOME).toBeUndefined();
    expect(env.GROK_HOME).toBeUndefined();
  });
});

describe('launch-arg quirks (behavior parity with the old name-chain)', () => {
  const baseCtx = { resolvedMode: 'edit' as const, interactive: false, cwd: '/tmp', addDirs: [] };

  it('cursor emits --trust for headless edit and plan, never interactive or skip', () => {
    const cursor = resolveHarnessAdapter('cursor');
    expect(cursor.execPreModeArgs?.(baseCtx)).toEqual(['--trust']);
    expect(cursor.execPreModeArgs?.({ ...baseCtx, resolvedMode: 'plan' })).toEqual(['--trust']);
    expect(cursor.execPreModeArgs?.({ ...baseCtx, interactive: true })).toBeUndefined();
    expect(cursor.execPreModeArgs?.({ ...baseCtx, resolvedMode: 'skip' })).toBeUndefined();
  });

  it('kimi emits no mode flag headless, defers when interactive, throws on headless plan', () => {
    const kimi = resolveHarnessAdapter('kimi');
    expect(kimi.execModeArgs?.(baseCtx)).toEqual([]);
    expect(kimi.execModeArgs?.({ ...baseCtx, interactive: true })).toBeUndefined();
    expect(() => kimi.execModeArgs?.({ ...baseCtx, resolvedMode: 'plan' })).toThrow(/resolved mode 'plan'/);
  });

  it('codex returns policy args carrying the edit profile', () => {
    const codex = resolveHarnessAdapter('codex');
    const args = codex.execModeArgs?.(baseCtx);
    expect(args).toContain('approval_policy="on-request"');
  });
});
