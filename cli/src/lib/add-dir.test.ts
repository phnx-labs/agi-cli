import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADD_DIR_STRATEGY,
  GROK_PROJECT_SANDBOX_PROFILE,
  addDirUnsupportedNote,
  applyAddDirs,
  ensureGrokProjectSandboxProfile,
  grokAddDirRules,
  grokNeedsSandboxWiden,
  normalizeAddDirs,
  supportsAddDir,
} from './add-dir.js';
import type { AgentId } from './types.js';
import { AGENTS } from './agents.js';

describe('ADD_DIR_STRATEGY completeness', () => {
  it('covers every registered AgentId', () => {
    const ids = Object.keys(AGENTS) as AgentId[];
    for (const id of ids) {
      expect(ADD_DIR_STRATEGY[id], `missing strategy for ${id}`).toBeDefined();
    }
  });

  it('supportsAddDir matches non-none strategies', () => {
    expect(supportsAddDir('claude')).toBe(true);
    expect(supportsAddDir('kimi')).toBe(true);
    expect(supportsAddDir('cursor')).toBe(true);
    expect(supportsAddDir('codex')).toBe(true);
    expect(supportsAddDir('grok')).toBe(true);
    expect(supportsAddDir('opencode')).toBe(false);
    expect(supportsAddDir('droid')).toBe(false);
  });

  it('addDirUnsupportedNote names the consumers', () => {
    expect(addDirUnsupportedNote('claude')).toBeNull();
    expect(addDirUnsupportedNote('opencode')).toMatch(/OpenCode|opencode/i);
    expect(addDirUnsupportedNote('opencode')).toMatch(/Claude/);
  });
});

describe('normalizeAddDirs', () => {
  it('expands ~ and dedupes', () => {
    const home = process.env.HOME ?? os.homedir();
    const out = normalizeAddDirs(['~/.agents', '~/.agents', '/abs/x']);
    expect(out).toEqual([path.join(home, '.agents'), '/abs/x']);
  });

  it('returns empty for undefined / empty', () => {
    expect(normalizeAddDirs(undefined)).toEqual([]);
    expect(normalizeAddDirs([])).toEqual([]);
  });
});

describe('applyAddDirs — native-flag harnesses', () => {
  it('claude / kimi / cursor get --add-dir per directory', () => {
    for (const agent of ['claude', 'kimi', 'cursor'] as const) {
      const cmd = ['bin'];
      expect(applyAddDirs(agent, cmd, ['/a', '/b'])).toBe(true);
      expect(cmd).toEqual(['bin', '--add-dir', '/a', '--add-dir', '/b']);
    }
  });

  it('opencode makes no argv change', () => {
    const cmd = ['opencode', 'run'];
    expect(applyAddDirs('opencode', cmd, ['/a'])).toBe(false);
    expect(cmd).toEqual(['opencode', 'run']);
  });

  it('codex is handled outside applyAddDirs (policy path)', () => {
    const cmd = ['codex'];
    expect(applyAddDirs('codex', cmd, ['/a'])).toBe(false);
    expect(cmd).toEqual(['codex']);
  });
});

describe('applyAddDirs — grok', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-add-dir-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('always injects --rules naming the sibling dirs', () => {
    const cmd = ['grok'];
    applyAddDirs('grok', cmd, ['/sib/a', '/sib/b'], {
      cwd: tmp,
      env: {},
    });
    const i = cmd.indexOf('--rules');
    expect(i).toBeGreaterThan(-1);
    expect(cmd[i + 1]).toContain('/sib/a');
    expect(cmd[i + 1]).toContain('/sib/b');
    expect(cmd).not.toContain('--sandbox');
  });

  it('when GROK_SANDBOX=workspace, writes project profile and selects it', () => {
    const cmd = ['grok'];
    applyAddDirs('grok', cmd, ['/sib/a'], {
      cwd: tmp,
      env: { GROK_SANDBOX: 'workspace' },
    });
    expect(cmd).toContain('--sandbox');
    expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe(GROK_PROJECT_SANDBOX_PROFILE);

    const toml = fs.readFileSync(path.join(tmp, '.grok', 'sandbox.toml'), 'utf-8');
    expect(toml).toContain(`[profiles.${GROK_PROJECT_SANDBOX_PROFILE}]`);
    expect(toml).toContain('extends = "workspace"');
    expect(toml).toContain('"/sib/a"');
    expect(toml).toContain('read_write');
  });

  it('when GROK_SANDBOX=strict, extends strict (does not widen to workspace)', () => {
    const cmd = ['grok'];
    applyAddDirs('grok', cmd, ['/sib/a'], {
      cwd: tmp,
      env: { GROK_SANDBOX: 'strict' },
    });
    const toml = fs.readFileSync(path.join(tmp, '.grok', 'sandbox.toml'), 'utf-8');
    expect(toml).toContain('extends = "strict"');
    expect(toml).not.toContain('extends = "workspace"');
  });

  it('replaces a prior --sandbox pair when widening', () => {
    const cmd = ['grok', '--sandbox', 'workspace'];
    applyAddDirs('grok', cmd, ['/sib'], {
      cwd: tmp,
      env: { GROK_SANDBOX: 'workspace' },
    });
    const sandboxes = cmd.filter((c) => c === '--sandbox');
    expect(sandboxes).toHaveLength(1);
    expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe(GROK_PROJECT_SANDBOX_PROFILE);
  });

  it('ensureGrokProjectSandboxProfile is idempotent on re-write', () => {
    ensureGrokProjectSandboxProfile(tmp, ['/a']);
    ensureGrokProjectSandboxProfile(tmp, ['/a', '/b']);
    const toml = fs.readFileSync(path.join(tmp, '.grok', 'sandbox.toml'), 'utf-8');
    expect(toml.match(/# BEGIN agents-cli managed/g)).toHaveLength(1);
    expect(toml).toContain('"/b"');
  });

  it('grokNeedsSandboxWiden is false for off/empty/devbox', () => {
    expect(grokNeedsSandboxWiden({})).toBe(false);
    expect(grokNeedsSandboxWiden({ GROK_SANDBOX: 'off' })).toBe(false);
    expect(grokNeedsSandboxWiden({ GROK_SANDBOX: 'devbox' })).toBe(false);
    expect(grokNeedsSandboxWiden({ GROK_SANDBOX: 'workspace' })).toBe(true);
    expect(grokNeedsSandboxWiden({ GROK_SANDBOX: 'strict' })).toBe(true);
  });

  it('grokAddDirRules lists every dir', () => {
    const text = grokAddDirRules(['/x', '/y']);
    expect(text).toContain('- /x');
    expect(text).toContain('- /y');
    expect(text).toMatch(/read \+ write/i);
  });

  it('refuses to append a second agents-project when a bare hand-written block exists', () => {
    const grokDir = path.join(tmp, '.grok');
    fs.mkdirSync(grokDir, { recursive: true });
    fs.writeFileSync(
      path.join(grokDir, 'sandbox.toml'),
      `[profiles.${GROK_PROJECT_SANDBOX_PROFILE}]\nextends = "workspace"\n`,
      'utf-8',
    );
    expect(ensureGrokProjectSandboxProfile(tmp, ['/a'])).toBeNull();
    const toml = fs.readFileSync(path.join(tmp, '.grok', 'sandbox.toml'), 'utf-8');
    expect(toml.match(/\[profiles\.agents-project\]/g)).toHaveLength(1);
    expect(toml).not.toContain('# BEGIN agents-cli managed');
  });
});
