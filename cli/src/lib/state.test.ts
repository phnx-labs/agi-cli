import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as yaml from 'yaml';

// state.ts resolves HOME and the device id at import time, so we point both at a
// throwaway temp dir and re-import the module fresh for each test. This
// exercises the REAL partition + overlay (writeMetaUnlocked / overlayMachineLocal)
// against real files — no mocking of the persistence layer.
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

// agents.yaml is git-tracked in the user's DotAgents repo, so a read that
// rewrites it dirties the working tree and blocks `agents repo pull`
// ("Working tree has uncommitted changes"). Reads must not write.
function writeCentral(yamlText: string) {
  fs.mkdirSync(path.join(TMP, '.agents'), { recursive: true });
  fs.writeFileSync(centralPath(), yamlText);
}

describe('pins route to the untracked pins file; the tracked doc is operator-only', () => {
  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-state-test-'));
    process.env.HOME = TMP;
    process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
    // getDevicesDir() reads this at call time (tests/setup.ts pins it fork-wide).
    process.env.AGENTS_DEVICES_DIR = path.join(TMP, '.agents', '.history', 'devices');
  });
  afterEach(() => {
    delete process.env.AGENTS_SYNC_MACHINE_ID;
    delete process.env.AGENTS_DEVICES_DIR;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
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

    // Pins land in the untracked pins file…
    const pins = JSON.parse(fs.readFileSync(pinsPath(), 'utf-8'));
    expect(pins).toEqual({ agents: { claude: '2.1.0' }, isolatedAgents: { codex: '0.144.6' } });
    // …never in central, and the tracked device doc is not created for pins.
    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('claude: 2.1.0');
    expect(central).toContain('maxAgents: 4');
    expect(fs.existsSync(devicePath())).toBe(false);

    // Both read back through the overlay.
    expect(readMeta().agents?.claude).toBe('2.1.0');
    expect(readMeta().isolatedAgents?.codex).toBe('0.144.6');
    expect(readMeta().fleet?.defaults?.config).toEqual({ maxAgents: 4 });
  });

  it('writeMeta preserves a config: block device-config wrote into the tracked doc', async () => {
    const { updateMeta, readMeta } = await freshState();

    // device-config.ts owns config: in the doc; write it directly (its writer).
    fs.mkdirSync(path.dirname(devicePath()), { recursive: true });
    fs.writeFileSync(devicePath(), 'config:\n  maxAgents: 4\n');

    updateMeta((m) => ({ ...m, deviceRoutines: ['watchdog'] }));

    const doc = fs.readFileSync(devicePath(), 'utf-8');
    expect(doc).toContain('maxAgents: 4'); // config survived the meta write
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

    // `probeDeviceKey` is NOT in CENTRAL_META_KEYS, so device-scope is its DEFAULT
    // — the whole point of P3: a key nobody explicitly marked fleet-shared lands
    // per-box, never in the synced agents.yaml. Cast because it is not a modeled
    // Meta field; the generic router keys off the scope classifier, not the type.
    updateMeta((m) => ({
      ...m,
      probeDeviceKey: { hello: 'world' },
      run: { claude: { strategy: 'balanced' } },
    } as any));

    // Landed in THIS box's device doc under its own name…
    const doc = fs.readFileSync(devicePath(), 'utf-8');
    expect(doc).toContain('probeDeviceKey:');
    expect(doc).toContain('hello: world');

    // …and never touched the synced central file (a genuine central key still does).
    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).not.toContain('probeDeviceKey');
    expect(central).toContain('strategy: balanced');

    // Round-trips back through the overlay.
    expect((readMeta() as any).probeDeviceKey).toEqual({ hello: 'world' });
  });

  it('leaves a foreign central key (unknown, already on disk) in central — never relocates it (PHNX-3315 P3)', async () => {
    // A newer CLI wrote `futureCentralKey` to the synced file as fleet-shared
    // config. This older CLI reads it, carries it through a spread write, and must
    // NOT relocate it to the per-box doc — that would un-sync a fleet-shared key.
    writeCentral('futureCentralKey: keep-me-central\n');
    const { updateMeta } = await freshState();

    updateMeta((m) => ({ ...m, run: { claude: { strategy: 'balanced' } } }));

    const central = fs.readFileSync(centralPath(), 'utf-8');
    expect(central).toContain('futureCentralKey: keep-me-central'); // preserved, still synced
    const doc = fs.existsSync(devicePath()) ? fs.readFileSync(devicePath(), 'utf-8') : '';
    expect(doc).not.toContain('futureCentralKey'); // never pushed into the device doc
  });

  it('does not surface a legacy device-doc `defaultBrowserProfile:` onto Meta (generic overlay exclusion, PHNX-3315 P3)', async () => {
    const { readMeta } = await freshState();

    // A pre-migration device doc: a bare top-level `defaultBrowserProfile:` the
    // config migration later folds into `config:`. The generic overlay must NOT
    // surface it onto Meta (it never was before P3) — BESPOKE_DEVICE_DOC_KEYS
    // excludes it. Deleting that exclusion would fail this test.
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
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('leaves the file byte-identical across repeated reads', async () => {
    // The committed state that deadlocked zion: no hermes entry, so the old
    // read path inserted one and wrote, dirtying a git-tracked file.
    writeCentral('registries:\n  mcp: {}\n  skill: {}\nseededPresets: []\n');
    const before = fs.readFileSync(centralPath(), 'utf-8');

    const { readMeta } = await freshState();
    readMeta();
    readMeta();
    expect(fs.readFileSync(centralPath(), 'utf-8')).toBe(before);
  });

  it('does not resurrect the seed through an unrelated write', async () => {
    // A write for another reason must not flush a seeded registry into the file
    // — that is how the in-memory-only first attempt at this fix still leaked.
    writeCentral('registries:\n  mcp: {}\n  skill: {}\n');

    const { updateMeta } = await freshState();
    // Use a real central key (`source`): P3 makes device-scope the DEFAULT, so an
    // UNMODELED key would now route to the device doc rather than central. The test's
    // intent — a central write must not resurrect the seed — is unchanged.
    updateMeta((m) => ({ ...m, source: 'set-by-write' }));

    const after = fs.readFileSync(centralPath(), 'utf-8');
    expect(after).toContain('source: set-by-write');
    expect(after).not.toContain('hermes-agent.nousresearch.com');
  });
});

describe('getProjectAgentsDir does not treat a DotAgents-repo clone as a project layer (RUSH-2037)', () => {
  // Cloning your own ~/.agents repo to the canonical ~/src/github.com/<you>/.agents
  // path makes it a git checkout of the very repo whose rules already load as the
  // user layer. It must not ALSO be picked up as a project layer (project outranks
  // user), or a stale clone silently shadows the live rules and plants a compiled
  // AGENTS.md in an ancestor dir. Discovery is by repo identity (git origin), not path.
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
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
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
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n'); // walk boundary
    initGitRepo(path.join(wrap, '.agents'), 'git@github.com:phnx-labs/.agents-system.git');

    expect(getProjectAgentsDir(wrap)).toBeNull();
  });

  it('rejects a checkout of the USER DotAgents repo at .agents/ (origin matches ~/.agents)', async () => {
    // The live user repo (~/.agents) is a git checkout with a known origin...
    initGitRepo(path.join(TMP, '.agents'), 'git@github.com:acme/.agents.git');
    const { getProjectAgentsDir } = await freshState();
    // ...and a *clone* of it sits at the canonical ~/src path.
    const wrap = path.join(TMP, 'src', 'github.com', 'acme');
    fs.mkdirSync(wrap, { recursive: true });
    fs.writeFileSync(path.join(wrap, 'agents.yaml'), 'agents: {}\n'); // walk boundary
    initGitRepo(path.join(wrap, '.agents'), 'https://github.com/acme/.agents.git'); // same slug, different URL form

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
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // The pre-rename header the top-level agents.yaml froze on: repo `agents-cli`
  // (not `agi-cli`) and no `$schema:` line. A hand-written body comment sits below
  // it — the yaml library folds that whole block onto the first key's comment,
  // which is exactly why the header cannot be healed via doc.commentBefore.
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

    // Any central mutation routes through serializeCentral.
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 7 } } } }));

    const central = fs.readFileSync(centralPath(), 'utf-8');

    // Header healed to the current META_HEADER (agi-cli + the $schema line), and
    // the pre-rename URL line is gone — exactly once, not duplicated.
    expect(central).toContain('# https://github.com/phnx-labs/agi-cli');
    expect(central).toContain(
      'yaml-language-server: $schema=https://raw.githubusercontent.com/phnx-labs/agi-cli/main/cli/schema/agents-yaml.schema.json',
    );
    expect(central).not.toContain('# https://github.com/phnx-labs/agents-cli');
    expect((central.match(/# agents-cli metadata/g) ?? []).length).toBe(1);

    // Hand-written body comment survives the rewrite.
    expect(central).toContain('# Fleet-wide notification routing (hand-written)');

    // No config keys lost; the freshly-set central key landed.
    const parsed = yaml.parse(central);
    expect(parsed.notify).toEqual({ owner: 'someone@example.com' });
    expect(parsed.share).toEqual({ endpoint: 'https://share.example' });
    expect(parsed.fleet.defaults.config.maxAgents).toBe(7);
  });

  it('does not heal on a device-only write — the shared file stays byte-identical even with a stale header', async () => {
    const { updateMeta } = await freshState();
    writeCentral(STALE);
    const before = fs.readFileSync(centralPath(), 'utf-8');

    // A device-only write (agents pins route to the untracked device store, not
    // central). Healing here would rewrite the shared file on an unrelated write —
    // the exact churn that wedges `agents sync` — so central must be untouched and
    // its stale header must survive until a real central change heals it.
    updateMeta((m) => ({ ...m, agents: { claude: '2.1.0' } }));

    const after = fs.readFileSync(centralPath(), 'utf-8');
    expect(after).toBe(before);
    expect(after).toContain('# https://github.com/phnx-labs/agents-cli');
  });

  it('is byte-stable once healed — a later no-op central write does not touch the file', async () => {
    const { updateMeta } = await freshState();
    writeCentral(STALE);

    // First write heals the header and adds a central key.
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 3 } } } }));
    const healed = fs.readFileSync(centralPath(), 'utf-8');
    expect(healed).toContain('agi-cli');

    // A subsequent central write that changes nothing must leave the bytes
    // identical — no re-header, no churn, so `agents sync` never sees a dirty file.
    updateMeta((m) => ({ ...m }));
    expect(fs.readFileSync(centralPath(), 'utf-8')).toBe(healed);
  });
});

// ── Commit-on-write for CLI-owned central edits (PHNX-3968) ────────────────
//
// A CLI config command rewrites the fleet-shared central agents.yaml. Left
// uncommitted, the tree is dirty on agents.yaml between the write and the
// daemon's next publish tick — and an incoming peer publish commit that also
// touches agents.yaml then trips dirtyTreeRefusal, wedging `agents repo pull`.
// writeMeta/updateMeta now commit the central edit synchronously after the meta
// lock releases (only when the central bytes actually moved), so the tree is
// clean at rest. The daemon (`agents __daemon-run`) commits too: since the
// shared-state exchange moved to SSH (PHNX-4116) no daemon tick touches the user
// repo, so a daemon-side central write would otherwise sit dirty until the next
// CLI edit. Real git repo, no mocks.
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
    try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('commits central agents.yaml so the tree is clean at rest', async () => {
    const { updateMeta } = await freshState();
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 5 } } } }));

    // agents.yaml is committed — not left dirty for the next incoming pull to trip on.
    expect(git(['status', '--porcelain', '--', 'agents.yaml']).trim()).toBe('');
    expect(git(['log', '-1', '--pretty=%s']).trim()).toBe('chore(config): update agents.yaml');
  });

  it('commits from the daemon process too (argv[2] === "__daemon-run") — no tick commits the user repo any more', async () => {
    // The daemon used to be exempt (an `isDaemonProcess` argv gate) because the
    // git publish tick owned the user repo's commits. That tick is gone; a
    // daemon-side central write must commit itself or stay dirty at rest.
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
    // Seed a committed central so a HEAD exists.
    updateMeta((m) => ({ ...m, fleet: { devices: {}, defaults: { config: { maxAgents: 5 } } } }));
    const before = git(['rev-list', '--count', 'HEAD']).trim();

    // projectRoot routes to the per-device doc; central agents.yaml is untouched,
    // so no central commit is created.
    updateMeta((m) => ({ ...m, projectRoot: '/tmp/some-project' }));

    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe(before);
  });
});

// ── Finding 2: legacy meta.yaml migration must not spawn git inside the lock ──
//
// readMeta()'s one-shot legacy branch (.system/meta.yaml present && agents.yaml
// absent) used to call the PUBLIC writeMeta, which runs commit-on-write's git
// subprocess. When readMeta runs as updateMeta/writeMeta's first statement it is
// already inside the held, non-heartbeated meta lock — so that commit violated
// the commit-after-lock invariant. The migration now writes via a reentrant
// withMetaLock(writeMetaUnlocked): lock-safe when standalone, a no-op re-entry
// when already locked, and it never spawns git.
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
    // Seed the pre-agents.yaml legacy state: .system/meta.yaml present, no agents.yaml.
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
    try { fs.rmSync(TMP3, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('a standalone readMeta() migrates without creating ANY commit', async () => {
    const { readMeta } = await freshState();

    const meta = readMeta();

    // Migration landed: central agents.yaml now exists with the migrated registries.
    expect(fs.existsSync(path.join(agentsDir(), 'agents.yaml'))).toBe(true);
    expect(meta.registries).toEqual({ prix: { url: 'https://x' } });
    // …and readMeta spawned NO git commit (the invariant: never commit here).
    expect(git(['rev-list', '--all', '--count']).trim()).toBe('0');
    // Legacy source removed.
    expect(fs.existsSync(path.join(agentsDir(), '.system', 'meta.yaml'))).toBe(false);
  });

  it('readMeta migrating INSIDE a held meta lock spawns no git and does not deadlock', async () => {
    const { readMeta, withMetaLock } = await freshState();
    const commitCount = () => git(['rev-list', '--all', '--count']).trim();
    expect(commitCount()).toBe('0'); // no commits yet

    // Simulate what updateMeta/writeMeta do: readMeta runs as the first statement
    // inside a HELD meta lock. withMetaLock's ensureLockTarget writes a default
    // agents.yaml on entry, which would normally skip the legacy branch — remove
    // it inside the lock so the migration actually runs on the reentrant (depth>0)
    // path, the exact case finding 2 is about.
    const meta = withMetaLock(() => {
      fs.rmSync(path.join(agentsDir(), 'agents.yaml'), { force: true });
      return readMeta();
    });

    // The migration ran and its data landed…
    expect(meta.registries).toEqual({ prix: { url: 'https://x' } });
    expect(fs.existsSync(path.join(agentsDir(), 'agents.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(), '.system', 'meta.yaml'))).toBe(false);
    // …WITHOUT spawning a git commit inside the held, non-heartbeated lock window
    // (the invariant). The reentrant withMetaLock also proves no deadlock/double-lock:
    // reaching this line at all means the nested lock returned cleanly.
    expect(commitCount()).toBe('0');
  });
});
