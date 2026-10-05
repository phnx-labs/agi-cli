import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'yaml';

let TMP = '';

async function freshState() {
  vi.resetModules();
  return import('./state.js');
}

function centralPath() {
  return path.join(TMP, '.agents', 'agents.yaml');
}
function devicePath() {
  return path.join(TMP, '.agents', 'devices', 'testbox', 'agents.yaml');
}

function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}

describe('pins route to the untracked pins file; the tracked doc is operator-only', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
  });

  function pinsPath() {
    return path.join(TMP, '.agents', '.history', 'devices', 'pins-testbox.json');
  }

  it('routes agents:/isolatedAgents: to .history pins JSON, never the tracked doc or central', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({
      ...m,
      agents: { claude: '2.1.0' },
      isolatedAgents: { codex: '0.144.6' },
      fleet: { devices: {}, defaults: { config: { maxAgents: 4 } } },
    }));

    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'));
    expect(pins).toEqual({ agents: { claude: '2.1.0' }, isolatedAgents: { codex: '0.144.6' } });
    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('claude: 2.1.0');
    expect(central).toContain('maxAgents: 4');
    expect(fs.existsSync(devicePath())).toBe(false);

    expect(readMeta().agents?.claude).toBe('2.1.0');
    expect(readMeta().isolatedAgents?.codex).toBe('0.144.6');
    expect(readMeta().fleet?.defaults?.config).toEqual({ maxAgents: 4 });
  });

  it('writeMeta preserves a config: block device-config wrote into the tracked doc', async () => {
    const { updateMeta, readMeta } = await freshState();

    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), 'config:\n  maxAgents: 4\n');

    updateMeta((m) => ({ ...m, deviceRoutines: ['watchdog'] }));

    const doc = fs.readFileSync(devicePath(), 'utf-8');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('- watchdog');
    expect(readMeta().deviceRoutines).toEqual(['watchdog']);
  });

  it('a partial writeMetaUnlocked call preserves omitted config and browser blocks', async () => {
    const { writeMetaUnlocked } = await freshState();
    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), 'config:\n  role: worker\nbrowser:\n  defaultProfile: work\n');

    writeMetaUnlocked({ deviceRoutines: ['watchdog'] } as any);

    const saved = yaml.parse(fs.readFileSync(devicePath(), 'utf-8'));
    expect(saved.config).toEqual({ role: 'worker' });
    expect(saved.browser).toEqual({ defaultProfile: 'work' });
    expect(saved.routines).toEqual(['watchdog']);
  });

  it('a deviceConfig-only write preserves every omitted device metadata block', async () => {
    const { writeMetaUnlocked } = await freshState();
    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), [
      'routines:',
      '  - watchdog',
      'fleet:',
      '  ignored:',
      '    - retired-box',
      'hosts:',
      '  build-box:',
      '    hostname: build.internal',
      'accounts:',
      '  bindings:',
      '    claude: work',
      'projectRoot: /workspace/project',
      '',
    ].join('\n'));

    writeMetaUnlocked({ deviceConfig: { role: 'worker' } } as any);

    const saved = yaml.parse(fs.readFileSync(devicePath(), 'utf-8'));
    expect(saved.config).toEqual({ role: 'worker' });
    expect(saved.routines).toEqual(['watchdog']);
    expect(saved.fleet).toEqual({ ignored: ['retired-box'] });
    expect(saved.hosts).toEqual({ 'build-box': { hostname: 'build.internal' } });
    expect(saved.accounts).toEqual({ bindings: { claude: 'work' } });
    expect(saved.projectRoot).toBe('/workspace/project');
  });

  it('clears pins cleanly (no stale pins file resurrecting them)', async () => {
    const { updateMeta, readMeta } = await freshState();

    updateMeta((m) => ({ ...m, agents: { claude: '2.1.0' } }));
    expect(readMeta().agents?.claude).toBe('2.1.0');

    updateMeta((m) => {
      const { agents, ...rest } = m;
      void agents;
      return rest;
    });
    expect(readMeta().agents?.claude).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'))).toEqual({});
  });

  it('routes a newly-declared device-scoped key to the device doc by default, never central (PHNX-3315 P3)', async () => {
    const { updateMeta, readMeta } = await freshState();

    // Unknown new keys default to device scope unless explicitly declared fleet-shared.
    updateMeta((m) => ({
      ...m,
      probeDeviceKey: { hello: 'world' },
      run: { claude: { strategy: 'balanced' } },
    } as any));

    const doc = fs.readFileSync(devicePath(), 'utf-8');
    expect(doc).toContain('probeDeviceKey:');
    expect(doc).toContain('hello: world');

    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('probeDeviceKey');
    expect(central).toContain('strategy: balanced');

    expect((readMeta() as any).probeDeviceKey).toEqual({ hello: 'world' });
  });

  it('leaves a foreign central key (unknown, already on disk) in central — never relocates it (PHNX-3315 P3)', async () => {
    // Forward compatibility: an unknown key already stored centrally remains fleet-shared.
    writeCentral('futureCentralKey: keep-me-central\n');
    const { updateMeta } = await freshState();

    updateMeta((m) => ({ ...m, run: { claude: { strategy: 'balanced' } } }));

    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).toContain('futureCentralKey: keep-me-central');
    const doc = fs.existsSync(devicePath()) ? fs.readFileSync(devicePath(), 'utf-8') : '';
    expect(doc).not.toContain('futureCentralKey');
  });

  it('does not surface a legacy device-doc `defaultBrowserProfile:` onto Meta (generic overlay exclusion, PHNX-3315 P3)', async () => {
    const { readMeta } = await freshState();

    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), 'defaultBrowserProfile: work\n');

    expect((readMeta() as any).defaultBrowserProfile).toBeUndefined();
  });

});

describe('reading state never writes a tracked agents.yaml (RUSH-1925)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-seed-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
  });

  it('leaves the file byte-identical across repeated reads', async () => {
    writeCentral('registries:\n  mcp: {}\n  skill: {}\nseededPresets: []\n');
    const before = fs.readFileSync(centralPath(), 'utf-8');

    const { readMeta } = await freshState();
    readMeta();
    readMeta();
    expect(fs.readFileSync(centralPath(), 'utf-8')).toBe(before);
  });

  it('does not resurrect the seed through an unrelated write', async () => {
    writeCentral('registries:\n  mcp: {}\n  skill: {}\n');

    const { updateMeta } = await freshState();
    updateMeta((m) => ({ ...m, source: 'set-by-write' }));

    const after = fs.readFileSync(centralPath(), 'utf-8');
    expect(after).toContain('source: set-by-write');
    expect(after).not.toContain('hermes-agent.nousresearch.com');
  });
});

// Exclude a cloned DotAgents repo by repository identity, not pathname, or its stale
// project layer would outrank the live user layer.
describe('getProjectAgentsDir does not treat a DotAgents-repo clone as a project layer (RUSH-2037)', () => {
  function initGitRepo(dir: string, originUrl: string) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl], { stdio: 'ignore' });
  }

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-projectdir-test-'));
    process.env.HOME = TMP;
  });
  afterEach(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
  });

  it('returns a legitimate project .agents/ (a plain subdir, not its own git repo)', async () => {
    const { getProjectAgentsDir } = await freshState();
    const proj = path.join(TMP, 'proj');
    const projAgents = path.join(proj, '.agents');
    fs.mkdirSync(path.join(projAgents, 'rules', 'subrules'), { recursive: true });

    expect(getProjectAgentsDir(proj)).toBe(projAgents);
  });

  it('rejects a checkout of the SYSTEM DotAgents repo at .agents/', async () => {
    const { getProjectAgentsDir } = await freshState();
    const wrap = path.join(TMP, 'src', 'github.com', 'phnx-labs');
    fs.mkdirSync(wrap, { recursive: true });
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n');
    initGitRepo(path.join(wrap, '.agents'), 'git@github.com:phnx-labs/.agents-system.git');

    expect(getProjectAgentsDir(wrap)).toBeNull();
  });

  it('rejects a checkout of the USER DotAgents repo at .agents/ (origin matches ~/.agents)', async () => {
    initGitRepo(path.join(TMP, '.agents'), 'git@github.com:acme/.agents.git');
    const { getProjectAgentsDir } = await freshState();
    const wrap = path.join(TMP, 'src', 'github.com', 'acme');
    fs.mkdirSync(wrap, { recursive: true });
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n');
    initGitRepo(path.join(wrap, '.agents'), 'https://github.com/acme/.agents.git');

    expect(getProjectAgentsDir(wrap)).toBeNull();
  });

  it('still returns an UNRELATED git repo checked out at .agents/ (no over-rejection)', async () => {
    const { getProjectAgentsDir } = await freshState();
    const proj = path.join(TMP, 'other-project');
    const projAgents = path.join(proj, '.agents');
    initGitRepo(projAgents, 'git@github.com:example/unrelated-project.git');
    fs.mkdirSync(path.join(projAgents, 'rules'), { recursive: true });

    expect(getProjectAgentsDir(proj)).toBe(projAgents);
  });
});

describe('serializeCentral heals a frozen top-level header (PHNX-3315)', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-header-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {  }
  });

  const STALE = [
    '# agents-cli metadata',
    '# Auto-generated - do not edit manually',
    '# https://github.com/phnx-labs/agents-cli',
    '',
    '# Fleet-wide notification routing (hand-written)',
    'notify:',
    '  owner: someone@example.com',
    'share:',
    '  endpoint: https://share.example',
    '',
  ].join('\n');

  it('rewrites the header to current on a central write, keeping body comments + every key', async () => {
    const { updateMeta } = await freshState();
    writeCentral(STALE);

    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 7 } } } }));

    const central = fs.readFileSync(centralPath(), 'utf-8');

    expect(central).toContain('# https://github.com/phnx-labs/agi-cli');
    expect(central).toContain(
      'yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json',
    );
    expect(central).not.toContain('# https://github.com/phnx-labs/agents-cli');
    expect((central.match(/# agents-cli metadata/g) ?? []).length).toBe(1);

    expect(central).toContain('# Fleet-wide notification routing (hand-written)');

    const parsed = yaml.parse(central);
    expect(parsed.notify).toEqual({ owner: 'someone@example.com' });
    expect(parsed.share).toEqual({ endpoint: 'https://share.example' });
    expect(parsed.fleet.defaults.config.maxAgents).toBe(7);
  });

  it('does not heal on a device-only write — the shared file stays byte-identical even with a stale header', async () => {
    const { updateMeta } = await freshState();
    writeCentral(STALE);
    const before = fs.readFileSync(centralPath(), 'utf-8');

    updateMeta((m) => ({ ...m, agents: { claude: '2.1.0' } }));

    const after = fs.readFileSync(centralPath(), 'utf-8');
    expect(after).toBe(before);
    expect(after).toContain('# https://github.com/phnx-labs/agents-cli');
  });

  it('is byte-stable once healed — a later no-op central write does not touch the file', async () => {
    const { updateMeta } = await freshState();
    writeCentral(STALE);

    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 3 } } } }));
    const healed = fs.readFileSync(centralPath(), 'utf-8');
    expect(healed).toContain('agi-cli');

    updateMeta((m) => ({ ...m }));
    expect(fs.readFileSync(centralPath(), 'utf-8')).toBe(healed);
  });
});

// Central writes commit only after the metadata lock releases. The daemon must commit
// too because no later publish tick owns cleanup of the user repository.
describe('commit-on-write: a CLI central mutation commits agents.yaml', () => {
  let TMP2 = '';
  const agentsDir = () => path.join(TMP2, '.agents');
  const git = (args: string[]) =>
    execFileSync('git', ['-C', agentsDir(), ...args], { encoding: 'utf-8' });

  beforeEach(() => {
    TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-commit-test-'));
    process.env.HOME = TMP2;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    process.env.AGENTS_DEVICES_DIR = path.join(agentsDir(), '.history', 'devices');
    fs.mkdirSync(agentsDir(), { recursive: true });
    execFileSync('git', ['-C', agentsDir(), 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch {  }
  });

  it('commits central agents.yaml so the tree is clean at rest', async () => {
    const { updateMeta } = await freshState();
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 5 } } } }));

    expect(git(['status', '--porcelain', '--', 'agents.yaml']).trim()).toBe('');
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('chore(config): update agents.yaml');
  });

  it('commits from the daemon process too (argv[2] === "__daemon-run") — no tick commits the user repo any more', async () => {
    const argv2 = process.argv[2];
    process.argv[2] = '__daemon-run';
    try {
      const { updateMeta } = await freshState();
      updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 7 } } } }));
    } finally {
      if (argv2 === undefined) process.argv.length = 2; else process.argv[2] = argv2;
    }

    expect(git(['status', '--porcelain', '--', 'agents.yaml']).trim()).toBe('');
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('chore(config): update agents.yaml');
    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('does not commit when only device-scoped state changed (central bytes unchanged)', async () => {
    const { updateMeta } = await freshState();
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 5 } } } }));
    const before = git(['rev-list', '--count', 'HEAD']).trim();

    updateMeta((m) => ({ ...m, projectRoot: '/tmp/some-project' }));

    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe(before);
  });
});

// Migration may run inside the non-heartbeated metadata lock, so it must neither
// reacquire that lock nor spawn a git commit before the outer writer releases it.
describe('legacy meta.yaml migration: lock-safe, commit-free write (PHNX-3968)', () => {
  let TMP3 = '';
  const agentsDir = () => path.join(TMP3, '.agents');
  const git = (args: string[]) =>
    execFileSync('git', ['-C', agentsDir(), ...args], { encoding: 'utf-8' });

  beforeEach(() => {
    TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-legacy-mig-'));
    process.env.HOME = TMP3;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    process.env.AGENTS_DEVICES_DIR = path.join(agentsDir(), '.history', 'devices');
    fs.mkdirSync(path.join(agentsDir(), '.system'), { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir(), '.system', 'meta.yaml'),
      yaml.stringify({ versions: { claude: { default: '2.1.0' } }, registries: { prix: { url: 'https://x' } } }),
    );
    execFileSync('git', ['-C', agentsDir(), 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'commit.gpgsign', 'false']);
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP3, { recursive: true, force: true }); } catch {  }
  });

  it('a standalone readMeta() migrates without creating ANY commit', async () => {
    const { readMeta } = await freshState();

    const meta = readMeta();

    expect(fs.existsSync(path.join(agentsDir(), 'agents.yaml'))).toBe(true);
    expect(meta.registries).toEqual({ prix: { url: 'https://x' } });
    expect(git(['rev-list', '--all', '--count']).trim()).toBe('0');
    expect(fs.existsSync(path.join(agentsDir(), '.system', 'meta.yaml'))).toBe(false);
  });

  it('readMeta migrating INSIDE a held meta lock spawns no git and does not deadlock', async () => {
    const { readMeta, withMetaLock } = await freshState();
    const commitCount = () => git(['rev-list', '--all', '--count']).trim();
    expect(commitCount()).toBe('0');

    // Delete the lock-created agents.yaml in-lock to force the exact reentrant migration path.
    const meta = withMetaLock(() => {
      fs.rmSync(path.join(agentsDir(), 'agents.yaml'), { force: true });
      return readMeta();
    });

    expect(meta.registries).toEqual({ prix: { url: 'https://x' } });
    expect(fs.existsSync(path.join(agentsDir(), 'agents.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), '.system', 'meta.yaml'))).toBe(false);
    expect(commitCount()).toBe('0');
  });
});
