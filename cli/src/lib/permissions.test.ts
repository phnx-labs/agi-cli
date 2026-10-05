// Baseline writable roots include tool caches but never credentials; Kimi * does not cross /, so translated Bash grants use the slash-crossing form.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as TOML from 'smol-toml';
import * as yaml from 'yaml';
import {
  COMPUTER_APP_GATED_VERBS,
  applyPermissionsToVersion,
  buildPermissionsFromGroups,
  containsBroadGrants,
  convertDenyToCodexRules,
  convertToKimiFormat,
  convertToCodexFormat,
  codexDefaultWritableRoots,
  convertToDroidFormat,
  convertToHermesFormat,
  convertToOpenClawFormat,
  convertToGrokFormat,
  formatComputerPermissionGrantHint,
  listInstalledPermissions,
  installPermissionSet,
  getDefaultPermissionSet,
  saveDefaultPermissionSet,
  removePermissionSet,
} from './permissions.js';
import { readCanonicalPermissions } from './permissions-registry.js';
import type { AgentId } from './types.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-perms-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Droid permissions', () => {
  it('maps canonical Bash rules into command allow and deny arrays', () => {
    expect(convertToDroidFormat({
      name: 'droid',
      allow: ['Bash(git:*)', 'Bash(pwd)', 'Read(**)'],
      deny: ['Bash(rm -rf:*)', 'Write(**)'],
    })).toEqual({
      commandAllowlist: ['git *', 'pwd'],
      commandDenylist: ['rm -rf *'],
    });
  });

  it('writes and merges Droid settings without replacing unrelated keys', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.factory');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
      model: 'custom-model',
      commandAllowlist: ['ls'],
      commandDenylist: ['shutdown'],
    }));

    expect(applyPermissionsToVersion('droid', {
      name: 'set',
      allow: ['Bash(git:*)'],
      deny: ['Bash(rm -rf:*)'],
    }, home, true)).toEqual({ success: true });

    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf-8'))).toEqual({
      model: 'custom-model',
      commandAllowlist: ['ls', 'git *'],
      commandDenylist: ['shutdown', 'rm -rf *'],
    });
  });
});

describe('OpenClaw permissions', () => {
  it('maps only blanket tool rules and skips sub-command/path/domain patterns', () => {
    expect(convertToOpenClawFormat({
      name: 'openclaw',
      allow: ['Bash(git:*)', 'Read(**)', 'Bash(*)'],
      deny: ['Write(secrets/**)', 'Write(**)', 'WebSearch(*)'],
    })).toEqual({
      alsoAllow: ['exec', 'read'],
      deny: ['web_search', 'write'],
    });
  });

  it('treats bare tool names as blanket and maps edit -> write', () => {
    expect(convertToOpenClawFormat({
      name: 'openclaw',
      allow: ['Bash', 'Edit(**)', 'WebFetch(*)'],
    })).toEqual({
      alsoAllow: ['exec', 'web_fetch', 'write'],
      deny: [],
    });
  });

  it('writes and merges openclaw.json tools without clobbering unrelated keys', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      mcp: { servers: {} },
      tools: { alsoAllow: ['read'], deny: ['browser'] },
    }));

    expect(applyPermissionsToVersion('openclaw', {
      name: 'set',
      allow: ['Bash(*)', 'Bash(git:*)'],
      deny: ['Write(**)'],
    }, home, true)).toEqual({ success: true });

    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'openclaw.json'), 'utf-8'))).toEqual({
      mcp: { servers: {} },
      tools: { alsoAllow: ['read', 'exec'], deny: ['browser', 'write'] },
    });
  });

  it('never touches tools.allow (the absolute allowlist)', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.openclaw');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify({
      tools: { allow: ['read'] },
    }));

    applyPermissionsToVersion('openclaw', {
      name: 'set',
      allow: ['Bash(*)'],
    }, home, true);

    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'openclaw.json'), 'utf-8'));
    expect(written.tools.allow).toEqual(['read']);
    expect(written.tools.alsoAllow).toEqual(['exec']);
  });
});

describe('Hermes permissions', () => {
  it('maps only canonical Bash rules to command allow and deny globs', () => {
    expect(convertToHermesFormat({
      name: 'hermes',
      allow: ['Bash(git:*)', 'Bash(pwd)', 'Read(**)'],
      deny: ['Bash(rm -rf:*)', 'Write(**)'],
    })).toEqual({
      command_allowlist: ['git *', 'pwd'],
      approvals: { deny: ['rm -rf *'] },
    });
  });

  it('writes and merges config.yaml without replacing mcp servers or hooks', () => {
    const home = makeTempHome();
    const configDir = path.join(home, '.hermes');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.yaml'), yaml.stringify({
      mcp_servers: { docs: { command: 'docs' } },
      hooks: { pre_tool: ['echo hook'] },
      approvals: { mode: 'manual', deny: ['git push --force*'] },
      command_allowlist: ['ls'],
    }));

    expect(applyPermissionsToVersion('hermes', {
      name: 'set',
      allow: ['Bash(git status)'],
      deny: ['Bash(rm -rf:*)'],
    }, home, true)).toEqual({ success: true });

    const written = yaml.parse(fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf-8'));
    expect(written).toEqual({
      mcp_servers: { docs: { command: 'docs' } },
      hooks: { pre_tool: ['echo hook'] },
      approvals: { mode: 'manual', deny: ['git push --force*', 'rm -rf *'] },
      command_allowlist: ['git status', 'ls'],
    });
  });
});

describe('permission path handling', () => {
  it('builds selected permission groups with separate allow and deny sections', async () => {
    const home = makeTempHome();
    const groupsDir = path.join(home, '.agents', 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'goose-safe.yaml'), [
      'name: goose-safe',
      'allow:',
      '  - "Bash(git:*)"',
      'deny:',
      '  - "Write(secrets/**)"',
      '',
    ].join('\n'));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { buildPermissionsFromGroups: buildFromGroups } = await import('./permissions.js');
      expect(buildFromGroups(['goose-safe'])).toEqual({
        name: 'built',
        description: 'Built from groups: goose-safe',
        allow: ['Bash(git:*)'],
        deny: ['Write(secrets/**)'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      vi.resetModules();
    }
  });

  it('extracts rules from a CRLF-checked-out permission group (PHNX-3187)', async () => {
    const home = makeTempHome();
    const groupsDir = path.join(home, '.agents', 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'crlf-safe.yaml'), [
      'name: crlf-safe',
      'allow:',
      '  - "Bash(git:*)"',
      'deny:',
      '  - "Write(secrets/**)"',
      '',
    ].join('\r\n'));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { buildPermissionsFromGroups: buildFromGroups } = await import('./permissions.js');
      expect(buildFromGroups(['crlf-safe'])).toEqual({
        name: 'built',
        description: 'Built from groups: crlf-safe',
        allow: ['Bash(git:*)'],
        deny: ['Write(secrets/**)'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      vi.resetModules();
    }
  });

  it('keeps legacy bare-list permission group entries as allow rules', async () => {
    const home = makeTempHome();
    const groupsDir = path.join(home, '.agents', 'permissions', 'groups');
    fs.mkdirSync(groupsDir, { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'legacy-web.yaml'), [
      '- "WebFetch(domain:cloud.google.com)"',
      '- "WebFetch(domain:docs.aws.amazon.com)"',
      '',
    ].join('\n'));

    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { buildPermissionsFromGroups: buildFromGroups } = await import('./permissions.js');
      expect(buildFromGroups(['legacy-web'])).toEqual({
        name: 'built',
        description: 'Built from groups: legacy-web',
        allow: ['WebFetch(domain:cloud.google.com)', 'WebFetch(domain:docs.aws.amazon.com)'],
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      vi.resetModules();
    }
  });

  it('rejects traversal in permission group names', async () => {
    makeTempHome();

    expect(() => buildPermissionsFromGroups(['../outside'])).toThrow('Invalid name: ../outside.yaml');
  });

  it('escapes deny rules before writing Codex Starlark string literals', async () => {
    const rules = convertDenyToCodexRules(['Bash(git "status":*)']);

    expect(rules).toContain('"git", "\\"status\\""');
    expect(rules).not.toContain('"git", ""status""');
  });
});

describe('containsBroadGrants', () => {
  it('flags Bash(*) permission packs as broad grants', () => {
    const result = containsBroadGrants({
      name: 'broad',
      allow: ['Bash(*)'],
      deny: [],
    });

    expect(result?.broad).toEqual(['Bash(*)']);
    expect(result?.reason).toContain('approval_policy=never');
  });

  it('allows narrow permission packs', () => {
    const result = containsBroadGrants({
      name: 'narrow',
      allow: ['Bash(git status:*)'],
      deny: [],
      additionalDirectories: ['src'],
    });

    expect(result).toBeNull();
  });
});

describe('computer permission hints', () => {
  it('tells users the app-targeted verbs gated by Computer(bundle-id)', () => {
    const hint = formatComputerPermissionGrantHint('Microsoft.WindowsNotepad');

    expect(hint).toContain('Computer(Microsoft.WindowsNotepad)');
    expect(hint).toContain('agents computer reload');
    expect(hint).toContain('type-text');
    expect(hint).toContain('key');
    expect(COMPUTER_APP_GATED_VERBS).toContain('type-text');
    expect(COMPUTER_APP_GATED_VERBS).toContain('key');
  });
});

describe('codex writable roots (build/test/install caches)', () => {
  const HOME = '/home/u';

  it('includes shared toolchain caches on every platform', () => {
    for (const plat of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const roots = codexDefaultWritableRoots(HOME, plat);
      for (const d of ['.cargo', '.rustup', '.npm', '.bun', 'go', '.deno', '.gradle', '.m2', '.gem']) {
        expect(roots).toContain(path.join(HOME, d));
      }
    }
  });

  it('resolves the OS cache root per platform (Library/Caches on macOS, .cache on Linux)', () => {
    const mac = codexDefaultWritableRoots(HOME, 'darwin');
    expect(mac).toContain(path.join(HOME, 'Library', 'Caches'));
    expect(mac).not.toContain(path.join(HOME, '.cache'));

    const linux = codexDefaultWritableRoots(HOME, 'linux');
    expect(linux).toContain(path.join(HOME, '.cache'));
    expect(linux).toContain(path.join(HOME, '.local', 'share'));
    expect(linux).not.toContain(path.join(HOME, 'Library', 'Caches'));
  });

  it('never grants credential dirs (keeps the sandbox meaningful, not YOLO)', () => {
    for (const plat of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const roots = codexDefaultWritableRoots(HOME, plat);
      for (const d of ['.ssh', '.aws', '.gnupg', '.config', '.netrc']) {
        expect(roots).not.toContain(path.join(HOME, d));
      }
    }
  });

  it('convertToCodexFormat always emits the baseline writable_roots (even with no perms)', () => {
    const codex = convertToCodexFormat({ name: 'empty', allow: [], deny: [] });
    expect(codex.sandbox_workspace_write?.writable_roots).toEqual(codexDefaultWritableRoots());
  });

  it('keeps network_access alongside writable_roots when web perms are present', () => {
    const codex = convertToCodexFormat({ name: 'net', allow: ['WebFetch(*)'], deny: [] });
    expect(codex.sandbox_workspace_write?.network_access).toBe(true);
    expect(codex.sandbox_workspace_write?.writable_roots).toContain(path.join(os.homedir(), '.cargo'));
  });

  it('unions the baseline with a writable_root the user configured directly (never clobbers)', () => {
    const versionHome = makeTempHome();
    const codexDir = path.join(versionHome, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      TOML.stringify({ sandbox_workspace_write: { writable_roots: ['/opt/custom'] } } as any),
      'utf-8',
    );
    const res = applyPermissionsToVersion('codex', { name: 'x', allow: ['WebFetch'], deny: [] }, versionHome);
    expect(res.success).toBe(true);
    const written = TOML.parse(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8')) as any;
    const roots: string[] = written.sandbox_workspace_write.writable_roots;
    expect(roots).toContain('/opt/custom');
    expect(roots).toContain(path.join(os.homedir(), '.cargo'));
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('convertToKimiFormat', () => {
  it('translates Claude `:*` bash patterns into Kimi globs, with a slash-crossing variant', () => {
    const { permission } = convertToKimiFormat({
      name: 'core',
      allow: ['Bash(git push:*)', 'Bash(mq:*)', 'Bash(env)'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(git push*)' },
      { decision: 'allow', pattern: 'Bash(git push*/**)' },
      { decision: 'allow', pattern: 'Bash(mq*)' },
      { decision: 'allow', pattern: 'Bash(mq*/**)' },
      { decision: 'allow', pattern: 'Bash(env)' },
    ]);
  });

  it('collapses blanket and glob grants to name-only rules with original casing', () => {
    const { permission } = convertToKimiFormat({
      name: 'broad',
      allow: ['Bash(*)', 'Read(**)', 'Grep'],
      deny: [],
    });

    expect(permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash' },
      { decision: 'allow', pattern: 'Read' },
      { decision: 'allow', pattern: 'Grep' },
    ]);
  });

  it('carries deny rules through the same translation', () => {
    const { permission } = convertToKimiFormat({
      name: 'deny',
      allow: [],
      deny: ['Bash(rm -rf:*)'],
    });

    expect(permission.rules).toEqual([
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
  });

  it('writes a re-parseable TOML config with translated patterns (no raw `:*`)', () => {
    const home = makeTempHome();
    const res = applyPermissionsToVersion(
      'kimi',
      { name: 'set', allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf:*)'] },
      home,
      false,
    );
    expect(res.success).toBe(true);

    const raw = fs.readFileSync(path.join(home, '.kimi-code', 'config.toml'), 'utf-8');
    const parsed = TOML.parse(raw) as { permission: { rules: Array<{ decision: string; pattern: string }> } };
    expect(parsed.permission.rules).toEqual([
      { decision: 'allow', pattern: 'Bash(ls*)' },
      { decision: 'allow', pattern: 'Bash(ls*/**)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*)' },
      { decision: 'deny', pattern: 'Bash(rm -rf*/**)' },
    ]);
    expect(raw).not.toContain(':*');
  });
});

describe('permission-set storage (groups/ contract)', () => {
  let userPermsDir: string;
  let sysPermsDir: string;
  let sourceFile: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-perms-storage-'));
    tempDirs.push(base);
    userPermsDir = path.join(base, 'user', 'permissions');
    sysPermsDir = path.join(base, 'sys', 'permissions');
    fs.mkdirSync(path.join(userPermsDir, 'groups'), { recursive: true });
    fs.mkdirSync(path.join(sysPermsDir, 'groups'), { recursive: true });

    process.env.AGENTS_USER_PERMISSIONS_DIR = userPermsDir;
    process.env.AGENTS_SYSTEM_PERMISSIONS_DIR = sysPermsDir;

    sourceFile = path.join(base, 'my-set.yml');
    fs.writeFileSync(sourceFile, yaml.stringify({
      name: 'my-set',
      description: 'test set',
      allow: ['Bash(git:*)'],
      deny: [],
    }));
  });

  afterEach(() => {
    delete process.env.AGENTS_USER_PERMISSIONS_DIR;
    delete process.env.AGENTS_SYSTEM_PERMISSIONS_DIR;
  });

  it('installPermissionSet writes to groups/ and listInstalledPermissions finds it', () => {
    const result = installPermissionSet(sourceFile, 'my-set');
    expect(result.success).toBe(true);

    expect(fs.existsSync(path.join(userPermsDir, 'groups', 'my-set.yml'))).toBe(true);
    expect(fs.existsSync(path.join(userPermsDir, 'my-set.yml'))).toBe(false);

    const sets = listInstalledPermissions();
    expect(sets.map((s) => s.name)).toContain('my-set');
  });

  it('listInstalledPermissions ignores root YAML and only reads from groups/', () => {
    fs.writeFileSync(path.join(userPermsDir, 'root-only.yml'), yaml.stringify({
      name: 'root-only',
      description: 'should be invisible',
      allow: ['Read(**)'],
      deny: [],
    }));

    const sets = listInstalledPermissions();
    expect(sets.map((s) => s.name)).not.toContain('root-only');
  });

  it('saveDefaultPermissionSet writes to groups/ and getDefaultPermissionSet reads it back', () => {
    const saved = saveDefaultPermissionSet({
      name: 'default',
      description: 'my defaults',
      allow: ['Bash(npm:*)'],
      deny: [],
    });
    expect(saved.success).toBe(true);

    expect(fs.existsSync(path.join(userPermsDir, 'groups', 'default.yml'))).toBe(true);

    const retrieved = getDefaultPermissionSet();
    expect(retrieved.allow).toContain('Bash(npm:*)');
    expect(retrieved.description).toBe('my defaults');
  });

  it('getDefaultPermissionSet ignores root YAML and reads from groups/', () => {
    fs.writeFileSync(path.join(userPermsDir, 'default.yml'), yaml.stringify({
      name: 'default',
      description: 'wrong location',
      allow: ['Read(**)'],
      deny: [],
    }));

    const result = getDefaultPermissionSet();
    expect(result.allow).toHaveLength(0);
    expect(result.description).toBe('Default permission set');
  });

  it('user groups/ takes precedence over system groups/', () => {
    fs.writeFileSync(path.join(sysPermsDir, 'groups', 'shared.yml'), yaml.stringify({
      name: 'shared',
      description: 'system version',
      allow: ['Read(**)'],
      deny: [],
    }));

    fs.writeFileSync(path.join(userPermsDir, 'groups', 'shared.yml'), yaml.stringify({
      name: 'shared',
      description: 'user version',
      allow: ['Bash(git:*)'],
      deny: [],
    }));

    const sets = listInstalledPermissions();
    const shared = sets.find((s) => s.name === 'shared');
    expect(shared).toBeDefined();
    expect(shared!.set.description).toBe('user version');
    expect(sets.filter((s) => s.name === 'shared')).toHaveLength(1);
  });

  it('removePermissionSet deletes from groups/ and listInstalledPermissions no longer sees it', () => {
    installPermissionSet(sourceFile, 'my-set');
    expect(listInstalledPermissions().map((s) => s.name)).toContain('my-set');

    const result = removePermissionSet('my-set');
    expect(result.success).toBe(true);

    expect(listInstalledPermissions().map((s) => s.name)).not.toContain('my-set');
  });
});

describe('safe cross-machine ops resolve to allow (PHNX-3294)', () => {
  function bashPrefix(rule: string): string | '*' | null {
    if (rule === 'Bash' || rule === 'Bash(*)' || rule === 'Bash(**)') return '*';
    const m = rule.match(/^Bash\((.+)\)$/);
    if (!m) return null;
    return m[1].replace(/:\*$/, '');
  }

  function atomGranted(allow: string[], atom: string): boolean {
    const cmd = atom.trim();
    for (const rule of allow) {
      const p = bashPrefix(rule);
      if (p === null) continue;
      if (p === '*') return true;
      if (cmd === p || cmd.startsWith(p + ' ')) return true;
    }
    return false;
  }

  function grants(allow: string[], command: string): boolean {
    const atoms = command.split(/\s*(?:&&|\|\||;)\s*/).filter((a) => a.trim().length > 0);
    return atoms.every((atom) => atomGranted(allow, atom));
  }

  const SAFE_COMMANDS = [
    "ssh yosemite-m5 'ls -la'",
    'scp report.html yosemite-m5:/tmp/report.html',
    "agents ssh yosemite-m5 'agents sessions'",
    'scp yosemite-m5:/tmp/plan.html /tmp/plan.html && open /tmp/plan.html',
    'git -C ~/.agents status',
  ];

  const FLEET_ALLOW = [
    'Bash',
    'Bash(ssh:*)',
    'Bash(scp:*)',
    'Bash(rsync:*)',
    'Bash(agents:*)',
    'Bash(open:*)',
    'Bash(git -C ~/.agents:*)',
    'Bash(git status:*)',
  ];

  const HARNESSES: AgentId[] = ['claude', 'grok', 'codex', 'kimi', 'droid'];

  it.each(HARNESSES)(
    'blanket-Bash fleet config allows every safe cross-machine command on %s',
    (agent) => {
      const home = makeTempHome();
      const res = applyPermissionsToVersion(agent, { name: 'fleet', allow: FLEET_ALLOW, deny: [] }, home, false);
      expect(res.success).toBe(true);

      const readBack = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(readBack, `${agent} wrote no readable permissions`).not.toBeNull();

      for (const command of SAFE_COMMANDS) {
        expect(
          grants(readBack!.allow, command),
          `${agent} should allow: ${command}\nallow=${JSON.stringify(readBack!.allow)}`,
        ).toBe(true);
      }
    },
  );

  it('THE FIX: blanket Bash becomes a pattern-LESS grok rule, not a single-level wildcard', () => {
    for (const blanket of ['Bash', 'Bash(*)', 'Bash(**)']) {
      const { permission } = convertToGrokFormat({ name: 'b', allow: [blanket], deny: [] });
      expect(permission.rules).toEqual([{ action: 'allow', tool: 'bash' }]);
      expect(permission.rules[0]).not.toHaveProperty('pattern');
    }
    const denySet = convertToGrokFormat({ name: 'b', allow: [], deny: ['Bash'] });
    expect(denySet.permission.rules).toEqual([{ action: 'deny', tool: 'bash' }]);
    const sshSet = convertToGrokFormat({ name: 's', allow: ['Bash(ssh:*)'], deny: [] });
    expect(sshSet.permission.rules).toEqual([{ action: 'allow', tool: 'bash', pattern: 'ssh *' }]);
  });

  it('grok round-trips the blanket-Bash grant back as Bash(*) (allow-all preserved)', () => {
    const home = makeTempHome();
    applyPermissionsToVersion('grok', { name: 'b', allow: ['Bash'], deny: [] }, home, false);
    const written = TOML.parse(fs.readFileSync(path.join(home, '.grok', 'config.toml'), 'utf-8')) as {
      permission: { rules: Array<Record<string, unknown>> };
    };
    expect(written.permission.rules).toEqual([{ action: 'allow', tool: 'bash' }]);

    const readBack = readCanonicalPermissions('grok', 'user', undefined, home);
    expect(readBack!.allow).toContain('Bash(*)');
  });

  const EXPLICIT_ONLY = FLEET_ALLOW.filter((r) => r !== 'Bash');
  it.each(['claude', 'kimi', 'droid', 'codex'] as AgentId[])(
    'explicit ssh/scp/git-C allowlist (no blanket) still allows the safe commands on %s',
    (agent) => {
      const home = makeTempHome();
      const res = applyPermissionsToVersion(agent, { name: 'explicit', allow: EXPLICIT_ONLY, deny: [] }, home, false);
      expect(res.success).toBe(true);

      const readBack = readCanonicalPermissions(agent, 'user', undefined, home);
      expect(readBack).not.toBeNull();
      for (const command of SAFE_COMMANDS) {
        expect(
          grants(readBack!.allow, command),
          `${agent} should allow: ${command}\nallow=${JSON.stringify(readBack!.allow)}`,
        ).toBe(true);
      }
    },
  );

  it('the matcher rejects an unsafe atom in a compound (weakest-atom rule holds)', () => {
    expect(grants(['Bash(ssh:*)'], "ssh host 'ls'")).toBe(true);
    expect(grants(['Bash(ssh:*)'], "ssh host 'ls' && rm -rf /")).toBe(false);
    expect(grants(['Bash(git status:*)'], 'git -C ~/.agents status')).toBe(false);
    expect(grants(['Bash(git -C ~/.agents:*)'], 'git -C ~/.agents status')).toBe(true);
  });
});
