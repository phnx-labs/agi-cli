import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildExecEnv } from './exec.js';
import { CONFIG_DIR_ENV_KEYS } from './harness/adapter.js';
import type { AgentId } from './types.js';
import type { ExecOptions } from './exec.js';

const PINNED: AgentId[] = ['claude', 'codex', 'grok', 'opencode', 'kimi', 'copilot', 'muse', 'cursor'];

function execOpts(over: Partial<ExecOptions> & { agent: AgentId }): ExecOptions {
  return { mode: 'edit', effort: 'auto', cwd: os.tmpdir(), ...over };
}

describe('cross-account config-dir leak (PHNX-3940 T5)', () => {
  it('strips every foreign config-dir var for a slot run of each pinned harness', () => {
    const slotA = path.join(os.tmpdir(), 't5-slot-a');
    const slotB = path.join(os.tmpdir(), 't5-slot-b');
    const leaked: NodeJS.ProcessEnv = {
      CLAUDE_CONFIG_DIR: '/leaked/claude',
      CODEX_HOME: '/leaked/codex',
      COPILOT_HOME: '/leaked/copilot',
      KIMI_CODE_HOME: '/leaked/kimi',
      GROK_HOME: '/leaked/grok',
      OPENCODE_CONFIG_DIR: '/leaked/opencode',
      XDG_CONFIG_HOME: '/leaked/xdg-config',
      XDG_DATA_HOME: '/leaked/xdg-data',
    };
    const prev: Record<string, string | undefined> = {};
    for (const key of Object.keys(leaked)) {
      prev[key] = process.env[key];
      process.env[key] = leaked[key];
    }
    try {
      for (const agent of PINNED) {
        const a = buildExecEnv(execOpts({ agent, version: 'main', execHome: slotA }));
        const b = buildExecEnv(execOpts({ agent, version: 'main', execHome: slotB }));
        for (const key of CONFIG_DIR_ENV_KEYS) {
          const leakedVal = leaked[key];
          expect(a[key], `${agent} slot A leaked ${key}`).not.toBe(leakedVal);
          expect(b[key], `${agent} slot B leaked ${key}`).not.toBe(leakedVal);
        }
        for (const key of CONFIG_DIR_ENV_KEYS) {
          if (a[key] && a[key] !== b[key]) {
            expect(String(a[key])).toContain('t5-slot-a');
            expect(String(b[key])).toContain('t5-slot-b');
            expect(String(a[key])).not.toContain('t5-slot-b');
            expect(String(b[key])).not.toContain('t5-slot-a');
          }
        }
      }
    } finally {
      for (const key of Object.keys(leaked)) {
        if (prev[key] === undefined) delete process.env[key];
        else process.env[key] = prev[key];
      }
    }
  });

  it('opencode pins OPENCODE_CONFIG_DIR and XDG_DATA_HOME at the slot', () => {
    const slot = path.join(os.tmpdir(), 't5-opencode-slot');
    const env = buildExecEnv(execOpts({ agent: 'opencode', version: 'main', execHome: slot }));
    expect(env.OPENCODE_CONFIG_DIR).toBe(path.join(slot, '.config', 'opencode'));
    expect(env.XDG_DATA_HOME).toBe(path.join(slot, '.local', 'share'));
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.GROK_HOME).toBeUndefined();
  });

  it('grok pins GROK_HOME at execHome even without a configVersion overlay', () => {
    const slot = path.join(os.tmpdir(), 't5-grok-slot');
    const env = buildExecEnv(execOpts({ agent: 'grok', version: 'main', execHome: slot }));
    expect(env.GROK_HOME).toBe(path.join(slot, '.grok'));
  });
});
