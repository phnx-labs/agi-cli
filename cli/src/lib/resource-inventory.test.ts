import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let testHome: string;
let userDir: string;
let systemDir: string;

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-inventory-test-'));
  userDir = path.join(testHome, '.agents');
  systemDir = path.join(userDir, '.system');
  fs.mkdirSync(systemDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'agents.yaml'), 'agents:\n  claude: "2.0.0"\n');
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

interface InventoryReport {
  agent: string;
  version: string;
  kind: string;
  capable: boolean;
  declared: Array<{ name: string; path: string; source: string }>;
  onDisk: Array<{ name: string; path: string; source: string }>;
  wired: Array<{ name: string; path: string; source: string; detail?: string }>;
  unmanaged: Array<{ name: string; path: string; source: string }>;
  wiringSupported: boolean;
}

function runInventory(agent: string, version: string, opts: { register?: boolean } = {}): InventoryReport {
  const modulePath = path.resolve(process.cwd(), 'src/lib/resource-inventory.ts');
  const versionsPath = path.resolve(process.cwd(), 'src/lib/installations/versions.ts');
  const hooksPath = path.resolve(process.cwd(), 'src/lib/hooks/install.ts');
  const register = opts.register
    ? `
      const { getVersionHomePath } = await import(${JSON.stringify(versionsPath)});
      const { registerHooksToSettings } = await import(${JSON.stringify(hooksPath)});
      registerHooksToSettings(${JSON.stringify(agent)}, getVersionHomePath(${JSON.stringify(agent)}, ${JSON.stringify(version)}));
    `
    : '';
  const script = `
    const mod = await import(${JSON.stringify(modulePath)});
    ${register}
    console.log(JSON.stringify(mod.getResourceInventory(${JSON.stringify(agent)}, ${JSON.stringify(version)}, 'hooks')));
  `;
  const out = execFileSync('bun', ['-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: testHome },
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString('utf-8');
  return JSON.parse(out);
}

function seedVersionHook(agent: string, version: string, configDir: string, relativeScript: string): string {
  const hooksDir = path.join(userDir, '.history', 'versions', agent, version, 'home', configDir, 'hooks');
  const scriptPath = path.join(hooksDir, relativeScript);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return hooksDir;
}

function seedDeclaredHook(name: string): void {
  const dir = path.join(systemDir, 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.sh`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function seedClaudeVersionWithHook(version: string, hookName: string, event: string): void {
  fs.writeFileSync(
    path.join(systemDir, 'agents.yaml'),
    `hooks:\n  ${hookName}:\n    script: ${hookName}.sh\n    events: [${event}]\n`,
  );
  seedVersionHook('claude', version, '.claude', `${hookName}.sh`);
}

describe('getResourceInventory (hooks)', () => {
  it('lists on-disk hooks from a grok version home via the absolute-hooksDir fix', () => {
    seedVersionHook('grok', '1.0.0', '.grok', 'guard.sh');
    seedVersionHook('grok', '1.0.0', '.grok', 'stop/00-agent-verify-work-complete.sh');

    const inv = runInventory('grok', '1.0.0');

    expect(inv.capable).toBe(true);
    const names = inv.onDisk.map((r) => r.name);
    expect(names).toContain('guard');
    expect(names).toContain('00-agent-verify-work-complete');
    for (const ref of inv.onDisk) {
      expect(ref.path).toContain(path.join('.history', 'versions', 'grok', '1.0.0', 'home', '.grok', 'hooks'));
      expect(fs.existsSync(ref.path)).toBe(true);
    }
  });

  it.each([
    ['grok', '.grok'],
    ['kimi', '.kimi-code'],
  ])('reports registrar-written %s hooks as wired', (agent, configDir) => {
    seedDeclaredHook('guard');
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'hooks:\n  guard:\n    script: guard.sh\n    events: [PreToolUse]\n    matcher: Bash\n',
    );
    seedVersionHook(agent, '1.0.0', configDir, 'guard.sh');

    const inv = runInventory(agent, '1.0.0', { register: true });

    expect(inv.wiringSupported).toBe(true);
    expect(inv.wired.map((r) => r.name)).toEqual(['guard']);
    expect(inv.wired[0].detail).toBe('PreToolUse');
  });

  it('does not report unmanaged Grok hook commands as inventory wiring', () => {
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      'hooks:\n  guard:\n    script: guard.sh\n    events: [PreToolUse]\n',
    );
    seedVersionHook('grok', '1.0.0', '.grok', 'guard.sh');
    const hooksPath = path.join(userDir, '.history', 'versions', 'grok', '1.0.0', 'home', '.grok', 'hooks', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '/user/custom.sh' }] }] } }));

    const inv = runInventory('grok', '1.0.0');

    expect(inv.wiringSupported).toBe(true);
    expect(inv.wired).toEqual([]);
  });

  it('reads the live-sized Grok hooks.json shape with 38 managed hooks', () => {
    const names = Array.from({ length: 38 }, (_, i) => `managed-${i + 1}`);
    fs.writeFileSync(
      path.join(systemDir, 'agents.yaml'),
      `hooks:\n${names.map((name) => `  ${name}:\n    script: ${name}.sh\n    events: [Stop]`).join('\n')}\n`,
    );
    for (const name of names) {
      seedDeclaredHook(name);
      seedVersionHook('grok', '1.0.0', '.grok', `${name}.sh`);
    }

    const inv = runInventory('grok', '1.0.0', { register: true });

    expect(inv.wiringSupported).toBe(true);
    expect(inv.wired).toHaveLength(38);
    expect(inv.wired.map((r) => r.name)).toEqual([...names].sort());
  });

  it('computes unmanaged as onDisk minus declared', () => {
    seedDeclaredHook('guard');
    seedVersionHook('kimi', '1.0.0', '.kimi-code', 'guard.sh');
    seedVersionHook('kimi', '1.0.0', '.kimi-code', 'rogue.sh');

    const inv = runInventory('kimi', '1.0.0');

    expect(inv.declared.map((r) => r.name)).toContain('guard');
    expect(inv.onDisk.map((r) => r.name)).toEqual(expect.arrayContaining(['guard', 'rogue']));
    expect(inv.unmanaged.map((r) => r.name)).toEqual(['rogue']);
  });

  it('reports a hook as wired once the real registrar has written settings.json', () => {
    seedDeclaredHook('demo-guard');
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');

    const inv = runInventory('claude', '2.0.0', { register: true });

    expect(inv.capable).toBe(true);
    expect(inv.wiringSupported).toBe(true);
    expect(inv.wired.map((r) => r.name)).toEqual(['demo-guard']);
    expect(inv.wired[0].detail).toBe('PreToolUse');
    expect(inv.unmanaged).toEqual([]);
  });

  it('keeps wired empty when the registrar never ran (on-disk is not wiring)', () => {
    seedClaudeVersionWithHook('2.0.0', 'demo-guard', 'PreToolUse');
    const configDir = path.join(userDir, '.history', 'versions', 'claude', '2.0.0', 'home', '.claude');
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));

    const inv = runInventory('claude', '2.0.0');

    expect(inv.wiringSupported).toBe(true);
    expect(inv.onDisk.map((r) => r.name)).toContain('demo-guard');
    expect(inv.wired).toEqual([]);
  });

  it('reports capable=false below the version gate without touching disk', () => {
    const inv = runInventory('codex', '0.100.0');

    expect(inv.capable).toBe(false);
    expect(inv.onDisk).toEqual([]);
    expect(inv.wired).toEqual([]);
    expect(inv.wiringSupported).toBe(false);
  });

  it.each([
    ['grok', '.grok', 'hooks/hooks.json', '{ not json'],
    ['kimi', '.kimi-code', 'config.toml', 'hooks = [ this is not toml'],
  ])(
    'treats unparseable %s native config as wiring unknown (not wired 0)',
    (agent, configDir, relativeConfig, garbage) => {
      seedDeclaredHook('guard');
      fs.writeFileSync(
        path.join(systemDir, 'agents.yaml'),
        'hooks:\n  guard:\n    script: guard.sh\n    events: [PreToolUse]\n',
      );
      seedVersionHook(agent, '1.0.0', configDir, 'guard.sh');
      const configPath = path.join(
        userDir,
        '.history',
        'versions',
        agent,
        '1.0.0',
        'home',
        configDir,
        relativeConfig,
      );
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, garbage);

      const inv = runInventory(agent, '1.0.0');

      expect(inv.wiringSupported).toBe(false);
      expect(inv.wired).toEqual([]);
      expect(inv.onDisk.map((r) => r.name)).toContain('guard');
    },
  );

  it('fails loud for kinds without an implementation', () => {
    const modulePath = path.resolve(process.cwd(), 'src/lib/resource-inventory.ts');
    const script = `
      const mod = await import(${JSON.stringify(modulePath)});
      try {
        mod.getResourceInventory('claude', '2.0.0', 'skills');
        console.log('NO_THROW');
      } catch (err) {
        console.log(err.message);
      }
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testHome },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    expect(out.trim()).toContain("kind 'skills' is not implemented yet");
  });
});

describe('getAgentResources hooks wiring', () => {
  it('lists grok version-home hooks through the inventory chokepoint', () => {
    seedVersionHook('grok', '1.0.0', '.grok', 'guard.sh');
    const home = path.join(userDir, '.history', 'versions', 'grok', '1.0.0', 'home');

    const resourcesPath = path.resolve(process.cwd(), 'src/lib/resources.ts');
    const script = `
      const mod = await import(${JSON.stringify(resourcesPath)});
      const res = mod.getAgentResources('grok', { home: ${JSON.stringify(home)} });
      console.log(JSON.stringify(res.hooks));
    `;
    const out = execFileSync('bun', ['-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testHome },
      stdio: ['ignore', 'pipe', 'inherit'],
    }).toString('utf-8');
    const hooks = JSON.parse(out) as Array<{ name: string; path: string }>;
    expect(hooks.map((h) => h.name)).toContain('guard');
    expect(hooks[0].path).toContain(path.join('home', '.grok', 'hooks'));
  });
});
