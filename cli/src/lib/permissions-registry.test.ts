
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_RULES_FILENAME, PERMISSION_TARGETS, readCanonicalPermissions } from './permissions-registry.js';
import { capableAgents } from './capabilities.js';
import {
  applyPermissionsToVersion,
  convertDenyToCodexRules,
  detectPermissionAgentFromPath,
  exportPermissionsFromPath,
} from './permissions.js';
import type { AgentId, PermissionSet } from './types.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-perm-registry-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('PERMISSION_TARGETS completeness', () => {
  it('has exactly one entry per allowlist-capable agent', () => {
    const capable = [...capableAgents('allowlist')].sort();
    const registered = (Object.keys(PERMISSION_TARGETS) as AgentId[]).sort();
    expect(registered).toEqual(capable);
  });

  it('states what each harness loses on the way back', () => {
    for (const [agent, target] of Object.entries(PERMISSION_TARGETS)) {
      expect(target!.lossyBecause, `${agent} has no lossyBecause`).toBeTruthy();
    }
  });

  it('resolves a distinct config path per harness', () => {
    const seen = new Map<string, string>();
    for (const [agent, target] of Object.entries(PERMISSION_TARGETS)) {
      const p = target!.home('/h');
      expect(seen.has(p), `${agent} collides with ${seen.get(p)} at ${p}`).toBe(false);
      seen.set(p, agent);
    }
  });

  it('returns null for a harness with no permissions written', () => {
    const home = makeTempHome();
    for (const agent of capableAgents('allowlist')) {
      expect(readCanonicalPermissions(agent, 'user', undefined, home), agent).toBeNull();
    }
  });
});

describe('write then read back, per harness', () => {
  const set: PermissionSet = {
    name: 'test',
    allow: ['Bash(git status:*)', 'Read(**)'],
    deny: ['Bash(rm:*)'],
  };

  for (const agent of capableAgents('allowlist')) {
    it(`${agent}: permissions written are read back`, () => {
      const home = makeTempHome();
      const result = applyPermissionsToVersion(agent, set, home, false, process.cwd());
      expect(result.success, `${agent} write failed: ${result.error}`).toBe(true);

      const readBack = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(readBack, `${agent} wrote permissions that read back as absent`).not.toBeNull();
      expect(readBack!.allow.length + (readBack!.deny?.length ?? 0)).toBeGreaterThan(0);
    });
  }
});

describe('round trip preserves the Bash rules a harness can express', () => {
  const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)'], deny: ['Bash(rm:*)'] };

  for (const agent of ['claude', 'grok', 'droid', 'hermes', 'kimi', 'antigravity'] as AgentId[]) {
    it(`${agent} keeps Bash(git status:*) and Bash(rm:*)`, () => {
      const home = makeTempHome();
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(back).not.toBeNull();
      expect(back!.allow).toContain('Bash(git status:*)');
      expect(back!.deny ?? []).toContain('Bash(rm:*)');
    });
  }
});

describe('exportPermissionsFromPath detects every harness by its own path', () => {
  for (const agent of capableAgents('allowlist')) {
    it(`detects ${agent} from the file the writer produced`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)', 'Read(**)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);

      const configPath = PERMISSION_TARGETS[agent]!.home(home);
      expect(fs.existsSync(configPath), `${agent} wrote nothing at ${configPath}`).toBe(true);
      expect(exportPermissionsFromPath(configPath), agent).not.toBeNull();
    });
  }

  it('returns null for a path no harness owns', () => {
    const home = makeTempHome();
    const stray = path.join(home, 'not-a-harness.json');
    fs.writeFileSync(stray, '{"permissions":{"allow":["Bash(*)"]}}', 'utf-8');
    expect(exportPermissionsFromPath(stray)).toBeNull();
  });

});

describe('allow and deny never cross on the way back', () => {

  const DENY_NOT_READ_BACK = new Set(['openclaw', 'copilot']);

  for (const agent of capableAgents('allowlist')) {
    it(`${agent}: an allow-only set never reads back a deny`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: ['Bash(git status:*)', 'Read(**)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(back, `${agent} wrote an allow-only set that reads back as absent`).not.toBeNull();
      expect(back!.deny ?? []).toEqual([]);
    });

    it(`${agent}: a deny-only set never reads back an allow`, () => {
      const home = makeTempHome();
      const set: PermissionSet = { name: 'test', allow: [], deny: ['Bash(rm:*)'] };
      expect(applyPermissionsToVersion(agent, set, home, false, process.cwd()).success).toBe(true);
      const back = readCanonicalPermissions(agent, 'user', undefined, home);

      if (DENY_NOT_READ_BACK.has(agent)) {
        expect(back?.allow ?? []).toEqual([]);
        return;
      }

      expect(back, `${agent} wrote a deny-only set that reads back as absent`).not.toBeNull();
      expect(back!.allow ?? []).toEqual([]);
      expect(back!.deny ?? []).not.toEqual([]);
    });
  }
});

describe('codex reads agents-deny.rules (PHNX-2703)', () => {

  it('reads back Bash(rm:*) that applyPermissionsToVersion just wrote', () => {
    const home = makeTempHome();
    const set: PermissionSet = {
      name: 'test',
      allow: ['Bash(git status:*)'],
      deny: ['Bash(rm:*)', 'Bash(git reset:*)'],
    };
    expect(applyPermissionsToVersion('codex', set, home, false, process.cwd()).success).toBe(true);

    const rulesPath = path.join(home, '.codex', 'rules', CODEX_RULES_FILENAME);
    expect(fs.existsSync(rulesPath), `writer did not emit ${rulesPath}`).toBe(true);
    const rules = fs.readFileSync(rulesPath, 'utf-8');
    expect(rules).toContain('pattern = ["rm"]');
    expect(rules).toContain('decision = "forbidden"');

    const back = readCanonicalPermissions('codex', 'user', undefined, home);
    expect(back, 'codex wrote denies that read back as absent').not.toBeNull();
    expect(back!.deny ?? []).toContain('Bash(rm:*)');
    expect(back!.deny ?? []).toContain('Bash(git reset:*)');
  });

  it('inverts convertDenyToCodexRules through the reader, including escaped strings', () => {
    const home = makeTempHome();
    const deny = ['Bash(sudo:*)', 'Bash(git push --force:*)', 'Bash(git "status":*)'];
    const starlark = convertDenyToCodexRules(deny);
    expect(starlark).not.toBeNull();
    fs.mkdirSync(path.join(home, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '', 'utf-8');
    fs.writeFileSync(path.join(home, '.codex', 'rules', CODEX_RULES_FILENAME), starlark!, 'utf-8');

    const back = readCanonicalPermissions('codex', 'user', undefined, home);
    expect(back).not.toBeNull();
    expect(back!.deny).toEqual(deny);
    expect(back!.allow).toEqual([]);
  });

  it('reads a compacted prefix_rule even when config.toml has no sandbox grants', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '', 'utf-8');
    fs.writeFileSync(
      path.join(home, '.codex', 'rules', CODEX_RULES_FILENAME),
      'prefix_rule(pattern=["rm"], decision="forbidden")\n',
      'utf-8',
    );

    const back = readCanonicalPermissions('codex', 'user', undefined, home);
    expect(back).not.toBeNull();
    expect(back!.deny ?? []).toContain('Bash(rm:*)');
    expect(back!.allow).toEqual([]);
  });

  it('still returns denies when config.toml is missing', () => {
    const home = makeTempHome();
    fs.mkdirSync(path.join(home, '.codex', 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.codex', 'rules', CODEX_RULES_FILENAME),
      'prefix_rule(pattern=["sudo"], decision="forbidden")\n',
      'utf-8',
    );

    const back = readCanonicalPermissions('codex', 'user', undefined, home);
    expect(back).not.toBeNull();
    expect(back!.deny ?? []).toContain('Bash(sudo:*)');
  });

  it('a later apply with empty deny deletes agents-deny.rules so the read-back is []', () => {
    const home = makeTempHome();
    const cwd = process.cwd();
    const rulesPath = path.join(home, '.codex', 'rules', CODEX_RULES_FILENAME);

    expect(applyPermissionsToVersion(
      'codex',
      { name: 'a', allow: [], deny: ['Bash(rm:*)'] },
      home,
      true,
      cwd,
    ).success).toBe(true);
    expect(fs.existsSync(rulesPath)).toBe(true);
    expect(readCanonicalPermissions('codex', 'user', undefined, home)?.deny ?? []).toEqual(['Bash(rm:*)']);

    expect(applyPermissionsToVersion(
      'codex',
      { name: 'b', allow: ['Bash(git status:*)'], deny: [] },
      home,
      true,
      cwd,
    ).success).toBe(true);
    expect(fs.existsSync(rulesPath), 'empty deny must delete the stale rules file').toBe(false);
    expect(readCanonicalPermissions('codex', 'user', undefined, home)?.deny ?? []).toEqual([]);
  });
});

describe('harness detection does not depend on the working directory', () => {
  function withCwd<T>(dir: string, fn: () => T): T {
    const before = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(before);
    }
  }

  it('resolves every harness the same way from any cwd', () => {
    const decoy = makeTempHome();
    fs.mkdirSync(path.join(decoy, '.config', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(decoy, 'opencode.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(decoy, '.config', 'opencode', 'opencode.json'), '{}', 'utf-8');
    const bare = makeTempHome();

    for (const agent of capableAgents('allowlist')) {
      const root = path.join(makeTempHome(), 'root');
      const candidate = PERMISSION_TARGETS[agent]!.home(root);
      const fromDecoy = withCwd(decoy, () => detectPermissionAgentFromPath(candidate));
      const fromBare = withCwd(bare, () => detectPermissionAgentFromPath(candidate));
      expect(fromDecoy, `${agent}: ${candidate} undetected`).toBe(agent);
      expect(fromBare, `${agent}: detection differs by cwd`).toBe(fromDecoy);
    }
  });

  for (const spelling of ['opencode.jsonc', 'opencode.json']) {
    it(`detects ${spelling} identically from a decoy cwd and a bare one`, () => {
      const home = makeTempHome();
      const configDir = path.join(home, '.config', 'opencode');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, spelling);
      fs.writeFileSync(configPath, '{"permission":{"bash":{"git *":"allow"}}}', 'utf-8');

      const other = spelling === 'opencode.jsonc' ? 'opencode.json' : 'opencode.jsonc';
      const decoy = makeTempHome();
      fs.mkdirSync(path.join(decoy, '.config', 'opencode'), { recursive: true });
      fs.writeFileSync(path.join(decoy, other), '{}', 'utf-8');
      fs.writeFileSync(path.join(decoy, '.config', 'opencode', other), '{}', 'utf-8');
      const bare = makeTempHome();

      const fromDecoy = withCwd(decoy, () => exportPermissionsFromPath(configPath));
      const fromBare = withCwd(bare, () => exportPermissionsFromPath(configPath));

      expect(fromDecoy, `${spelling} undetected from a decoy cwd`).not.toBeNull();
      expect(fromBare, `${spelling} undetected from a bare cwd`).not.toBeNull();
      expect(fromDecoy).toEqual(fromBare);
      expect(fromDecoy!.allow).toContain('Bash(git *)');
    });
  }
});
