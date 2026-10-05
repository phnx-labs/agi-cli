import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

let TEST_ROOT: string;
let SYSTEM_DIR: string;
let USER_DIR: string;

vi.mock('../state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state.js')>();
  return {
    ...actual,
    getAgentsDir: () => SYSTEM_DIR,
    getSystemAgentsDir: () => SYSTEM_DIR,
    getUserAgentsDir: () => USER_DIR,
    getHooksDir: () => path.join(SYSTEM_DIR, 'hooks'),
    getSystemHooksDir: () => path.join(SYSTEM_DIR, 'hooks'),
    getUserHooksDir: () => path.join(USER_DIR, 'hooks'),
    getProjectAgentsDir: () => null,
    getEnabledExtraRepos: () => [],
  };
});

import { listHookEntriesFromDir, resolveHookScriptPath, registerHooksToSettings } from '../hooks/install.js';
import { resolveHookSource } from '../staleness/writers/sources.js';
import type { ManifestHook } from '../types.js';

function writeHook(rel: string, body = '#!/bin/sh\nexit 0\n'): string {
  const abs = path.join(SYSTEM_DIR, 'hooks', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, { mode: 0o755 });
  fs.chmodSync(abs, 0o755);
  return abs;
}

describe('hooks group subdirs (session-starts layout)', () => {
  beforeEach(() => {
    TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-nested-'));
    SYSTEM_DIR = path.join(TEST_ROOT, '.agents-system');
    USER_DIR = path.join(TEST_ROOT, '.agents');
    fs.mkdirSync(path.join(SYSTEM_DIR, 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(USER_DIR, 'hooks'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('listHookEntriesFromDir discovers scripts one level under a group dir', () => {
    writeHook('top.sh');
    writeHook('session-starts/04-session-identity.sh');
    writeHook('session-starts/05-session-start-autosync.sh');
    const fixtures = path.join(SYSTEM_DIR, 'hooks', 'tests', 'fixtures');
    fs.mkdirSync(fixtures, { recursive: true });
    fs.writeFileSync(path.join(fixtures, 'input.json'), '{"ok":true}\n');

    const entries = listHookEntriesFromDir(path.join(SYSTEM_DIR, 'hooks'));
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual([
      '04-session-identity',
      '05-session-start-autosync',
      'top',
    ]);
    const id = entries.find((e) => e.name === '04-session-identity')!;
    expect(id.scriptPath).toBe(path.join(SYSTEM_DIR, 'hooks', 'session-starts', '04-session-identity.sh'));
  });

  it('top-level basename wins over nested on collision', () => {
    writeHook('guard.sh', '#!/bin/sh\necho top\n');
    writeHook('session-starts/guard.sh', '#!/bin/sh\necho nested\n');
    const entries = listHookEntriesFromDir(path.join(SYSTEM_DIR, 'hooks'));
    const guard = entries.find((e) => e.name === 'guard')!;
    expect(fs.readFileSync(guard.scriptPath, 'utf-8')).toContain('top');
  });

  it('resolveHookSource finds nested scripts by basename and relative path', () => {
    const abs = writeHook('session-starts/08-inject-repo-inflight.sh');
    expect(resolveHookSource('08-inject-repo-inflight.sh')).toBe(abs);
    expect(resolveHookSource('session-starts/08-inject-repo-inflight.sh')).toBe(abs);
  });

  it('resolveHookScriptPath finds nested scripts by basename', () => {
    const abs = writeHook('session-starts/07-inject-device-topology.sh');
    expect(resolveHookScriptPath('07-inject-device-topology.sh')).toBe(abs);
    expect(resolveHookScriptPath('session-starts/07-inject-device-topology.sh')).toBe(abs);
  });

  it('registerHooksToSettings resolves nested script path from the manifest', () => {
    const abs = writeHook('session-starts/04-session-identity.sh');
    const versionHome = path.join(TEST_ROOT, 'vh');
    fs.mkdirSync(path.join(versionHome, '.codex'), { recursive: true });
    const manifest: Record<string, ManifestHook> = {
      'session-identity': {
        script: 'session-starts/04-session-identity.sh',
        events: ['SessionStart'],
        timeout: 5,
      },
    };
    const result = registerHooksToSettings('codex', versionHome, manifest, SYSTEM_DIR);
    expect(result.errors).toEqual([]);
    expect(result.registered.some((r) => r.includes('session-identity'))).toBe(true);
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(versionHome, '.codex', 'hooks.json'), 'utf-8'),
    );
    const cmd = hooksJson.hooks.SessionStart[0].hooks[0].command as string;
    const expanded = cmd.startsWith('~/') ? path.join(os.homedir(), cmd.slice(2)) : cmd;
    expect(path.resolve(expanded)).toBe(path.resolve(abs));
  });
});
