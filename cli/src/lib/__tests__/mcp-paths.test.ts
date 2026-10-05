import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getUserMcpConfigPath,
  getMcpConfigPathForHome,
  listInstalledMcpsWithScope,
} from '../agents.js';

describe('getUserMcpConfigPath copilot', () => {
  it('returns mcp-config.json for copilot (not settings.json)', () => {
    const p = getUserMcpConfigPath('copilot');
    expect(path.basename(p)).toBe('mcp-config.json');
    expect(p).toContain('.copilot');
    expect(path.basename(p)).not.toBe('settings.json');
  });
});

describe('getMcpConfigPathForHome copilot', () => {
  it('points at <home>/.copilot/mcp-config.json', () => {
    const home = '/tmp/fake-home';
    const p = getMcpConfigPathForHome('copilot', home);
    expect(p).toBe(path.join(home, '.copilot', 'mcp-config.json'));
  });
});

describe('listInstalledMcpsWithScope copilot — round-trip via real fixture', () => {
  it('reads user-scoped MCPs from <home>/.copilot/mcp-config.json', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-'));
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cwd-'));
    try {
      const copilotDir = path.join(tempHome, '.copilot');
      fs.mkdirSync(copilotDir, { recursive: true });
      fs.writeFileSync(
        path.join(copilotDir, 'mcp-config.json'),
        JSON.stringify({
          mcpServers: {
            'demo-server': {
              command: 'npx',
              args: ['-y', 'demo-mcp@1.2.3'],
            },
          },
        }),
        'utf-8'
      );

      const mcps = listInstalledMcpsWithScope('copilot', tempCwd, { home: tempHome });
      const userMcps = mcps.filter((m) => m.scope === 'user');

      expect(userMcps).toHaveLength(1);
      expect(userMcps[0]).toMatchObject({
        name: 'demo-server',
        scope: 'user',
      });
      expect(userMcps[0].command).toContain('npx');
      expect(userMcps[0].command).toContain('demo-mcp@1.2.3');
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });

  it('returns empty when only the wrong filename exists (settings.json regression guard)', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-'));
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cwd-'));
    try {
      const copilotDir = path.join(tempHome, '.copilot');
      fs.mkdirSync(copilotDir, { recursive: true });
      fs.writeFileSync(
        path.join(copilotDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            'wrong-file-server': { command: 'echo' },
          },
        }),
        'utf-8'
      );

      const mcps = listInstalledMcpsWithScope('copilot', tempCwd, { home: tempHome });
      expect(mcps.find((m) => m.name === 'wrong-file-server')).toBeUndefined();
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempCwd, { recursive: true, force: true });
    }
  });
});
