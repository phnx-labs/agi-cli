import { describe, expect, it } from 'vitest';
import { ALL_AGENT_IDS, AGENTS } from './agents.js';
import { AGENT_COMMANDS } from './exec.js';
import {
  formatModeSupportTable,
  getAgentModesCatalog,
  MODE_DESCRIPTIONS,
} from './agent-modes.js';
import { ALL_MODES } from './types.js';

describe('getAgentModesCatalog', () => {
  it('lists every capability mode for claude with native flags', () => {
    const cat = getAgentModesCatalog('claude');
    expect(cat.modes.map((m) => m.mode)).toEqual(['plan', 'edit', 'auto', 'skip']);
    expect(cat.defaultMode).toBe('plan');
    expect(cat.modes.find((m) => m.mode === 'plan')!.isDefault).toBe(true);
    expect(cat.modes.find((m) => m.mode === 'auto')!.flags).toEqual(['--permission-mode', 'auto']);
    expect(cat.modes.find((m) => m.mode === 'skip')!.flags).toEqual(['--dangerously-skip-permissions']);
    expect(cat.unsupported).toEqual([]);
    expect(cat.headlessPlan).toBe(true);
  });

  it('lists plan/edit/skip for cursor with --plan flag', () => {
    const cat = getAgentModesCatalog('cursor');
    expect(cat.modes.map((m) => m.mode)).toEqual(['plan', 'edit', 'skip']);
    expect(cat.defaultMode).toBe('plan');
    expect(cat.unsupported).toEqual(['auto']);
    expect(cat.modes.find((m) => m.mode === 'plan')!.flags).toEqual(['--plan']);
    expect(cat.modes.find((m) => m.mode === 'skip')!.flags).toEqual(['-f']);
  });

  it('agrees with AGENTS.capabilities.modes and AGENT_COMMANDS.modeFlags for every agent', () => {
    for (const agent of ALL_AGENT_IDS) {
      if (AGENTS[agent].deprecated?.hard) continue;
      const cat = getAgentModesCatalog(agent);
      expect(cat.modes.map((m) => m.mode)).toEqual(AGENTS[agent].capabilities.modes);
      expect(cat.defaultMode).toBe(AGENTS[agent].capabilities.modes[0]);
      for (const entry of cat.modes) {
        expect(AGENT_COMMANDS[agent].modeFlags[entry.mode]).toEqual(entry.flags);
        expect(entry.description).toBe(MODE_DESCRIPTIONS[entry.mode]);
      }
      for (const mode of ALL_MODES) {
        const supported = AGENTS[agent].capabilities.modes.includes(mode);
        expect(cat.unsupported.includes(mode)).toBe(!supported);
      }
    }
  });
});

describe('formatModeSupportTable', () => {
  it('lists every non-deprecated harness with its supported modes and starred default', () => {
    const lines = formatModeSupportTable().split('\n');
    const live = ALL_AGENT_IDS.filter((id) => !AGENTS[id].deprecated?.hard);
    expect(lines).toHaveLength(live.length);
    for (const agent of live) {
      const row = lines.find((line) => line.split(/\s+/)[0] === agent);
      expect(row, agent).toBeDefined();
      const cat = getAgentModesCatalog(agent);
      expect(row!.trim().split(/\s+/).slice(1)).toEqual(cat.modes.map((m) => (m.isDefault ? `${m.mode}*` : m.mode)));
    }
  });
});
