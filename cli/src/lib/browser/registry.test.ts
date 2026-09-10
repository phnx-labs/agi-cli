import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let previousHome: string | undefined;

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

function deviceFile(device: string): string {
  return path.join(root, '.agents', 'devices', device, 'agents.yaml');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-registry-'));
  process.env.HOME = root;
  vi.resetModules();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('profileRegistry', () => {
  it('unions declarations from every device without overwriting equal names', async () => {
    const chrome = { browser: 'chrome', endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(deviceFile('alpha'), { browser: { shared: chrome, alpha: chrome } });
    writeYaml(deviceFile('beta'), { browser: { shared: chrome } });
    writeYaml(deviceFile('gamma'), { browser: { shared: chrome } });

    const { declaringDevices, profileKind, profileRegistry } = await import('./registry.js');
    const registry = profileRegistry();

    expect([...registry.keys()]).toEqual(['shared', 'alpha']);
    expect(registry.get('shared')?.map((entry) => entry.device)).toEqual(['alpha', 'beta', 'gamma']);
    expect(declaringDevices('alpha')).toEqual(['alpha']);
    expect(profileKind('alpha')).toBe('identity');
    expect(profileKind('shared')).toBe('fungible');
    expect(profileKind('missing')).toBeNull();
  });

  it('fails loudly when a device browser block is malformed', async () => {
    writeYaml(deviceFile('broken'), { browser: ['not', 'a', 'map'] });
    const { profileRegistry } = await import('./registry.js');
    expect(() => profileRegistry()).toThrow(/browser must be a map/);
  });
});

describe('central browser migration', () => {
  it('moves central declarations only into this device file and is idempotent', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config }, model: { claude: 'opus' } });

    const { machineId } = await import('../machine-id.js');
    const { migrateCentralBrowserProfiles, profileRegistry } = await import('./registry.js');
    expect(migrateCentralBrowserProfiles(() => true)).toEqual({
      claimed: ['comet-local'],
      skipped: [],
    });

    const ownFile = deviceFile(machineId());
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8'))).toEqual({ model: { claude: 'opus' } });
    expect(yaml.parse(fs.readFileSync(ownFile, 'utf8')).browser).toEqual({ 'comet-local': config });
    expect(fs.readdirSync(path.join(root, '.agents', 'devices'))).toEqual([machineId()]);

    const centralAfterFirstRead = fs.readFileSync(centralFile, 'utf8');
    const deviceAfterFirstRead = fs.readFileSync(ownFile, 'utf8');
    expect(migrateCentralBrowserProfiles(() => true)).toEqual({ claimed: [], skipped: [] });
    expect(profileRegistry().get('comet-local')?.map((entry) => entry.device)).toEqual([machineId()]);
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(centralAfterFirstRead);
    expect(fs.readFileSync(ownFile, 'utf8')).toBe(deviceAfterFirstRead);
  });

  it('preserves both copies and fails when migration would overwrite a declaration', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    writeYaml(centralFile, {
      browser: { work: { browser: 'chrome', endpoints: ['cdp://localhost:9222'] } },
    });
    const { machineId } = await import('../machine-id.js');
    const ownFile = deviceFile(machineId());
    writeYaml(ownFile, {
      browser: { work: { browser: 'brave', endpoints: ['cdp://localhost:9333'] } },
    });

    const beforeCentral = fs.readFileSync(centralFile, 'utf8');
    const beforeDevice = fs.readFileSync(ownFile, 'utf8');
    const { migrateCentralBrowserProfiles } = await import('./registry.js');

    expect(() => migrateCentralBrowserProfiles(() => true)).toThrow(/different configurations/);
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(beforeCentral);
    expect(fs.readFileSync(ownFile, 'utf8')).toBe(beforeDevice);
  });

  it('does not claim a central profile this machine cannot host', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config } });

    const { machineId } = await import('../machine-id.js');
    const { migrateCentralBrowserProfiles, declaringDevices, profileKind } = await import('./registry.js');

    expect(migrateCentralBrowserProfiles(() => false)).toEqual({
      claimed: [],
      skipped: ['comet-local'],
    });
    expect(declaringDevices('comet-local')).toEqual([]);
    expect(profileKind('comet-local')).toBeNull();
    expect(fs.existsSync(deviceFile(machineId()))).toBe(false);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({
      'comet-local': config,
    });
  });

  it('claims a central profile this machine can host', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = {
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    writeYaml(centralFile, { browser: { work: config } });

    const { machineId } = await import('../machine-id.js');
    const { migrateCentralBrowserProfiles, declaringDevices, profileKind } = await import('./registry.js');

    expect(migrateCentralBrowserProfiles(() => true)).toEqual({
      claimed: ['work'],
      skipped: [],
    });
    expect(declaringDevices('work')).toEqual([machineId()]);
    expect(profileKind('work')).toBe('identity');
    expect(yaml.parse(fs.readFileSync(deviceFile(machineId()), 'utf8')).browser).toEqual({
      work: config,
    });
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8'))?.browser).toBeUndefined();
  });

  it('claims only the hostable names and leaves the rest central', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const hostable = {
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    const unhostable = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { work: hostable, 'comet-local': unhostable } });

    const { machineId } = await import('../machine-id.js');
    const { migrateCentralBrowserProfiles, declaringDevices } = await import('./registry.js');

    expect(
      migrateCentralBrowserProfiles((config) => config.browser === 'custom'),
    ).toEqual({ claimed: ['work'], skipped: ['comet-local'] });
    expect(declaringDevices('work')).toEqual([machineId()]);
    expect(declaringDevices('comet-local')).toEqual([]);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({
      'comet-local': unhostable,
    });
  });

  it('does not report unrequested leftovers as unhostable on a named claim', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const hostable = {
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    writeYaml(centralFile, {
      browser: { work: hostable, other: { ...hostable, endpoints: ['cdp://127.0.0.1:9223'] } },
    });
    const { migrateCentralBrowserProfiles } = await import('./registry.js');
    expect(migrateCentralBrowserProfiles(() => true, 'work')).toEqual({
      claimed: ['work'],
      skipped: [],
    });
  });

  it('fails loud when a named claim cannot be hosted here', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    writeYaml(centralFile, {
      browser: { 'comet-local': { browser: 'comet', endpoints: ['cdp://localhost:9333'] } },
    });
    const { migrateCentralBrowserProfiles } = await import('./registry.js');
    expect(() => migrateCentralBrowserProfiles(() => false, 'comet-local')).toThrow(
      /Cannot claim browser profile "comet-local"/,
    );
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser['comet-local']).toBeDefined();
  });
});

describe('device declaration lifecycle', () => {
  it('round-trips stable native Arc metadata through real device YAML', async () => {
    const previousArcDir = process.env.AGENTS_ARC_DIR;
    try {
      process.env.AGENTS_ARC_DIR = path.join(import.meta.dirname, 'testdata', 'arc', 'valid');
      const { machineId } = await import('../machine-id.js');
      const { createProfile, getProfile } = await import('./profiles.js');
      const arc = {
        profileId: 'Profile 1',
        profileName: 'Work',
        spaceId: '11111111-2222-3333-4444-555555555555',
        spaceTitle: 'Work',
      };
      await createProfile({
        name: 'arc-work',
        browser: 'arc',
        endpoints: { native: { target: 'arc-native://local' } },
        defaultEndpoint: 'native',
        launchPolicy: 'attach-only',
        arc,
      });

      const stored = yaml.parse(fs.readFileSync(deviceFile(machineId()), 'utf8'));
      expect(stored.browser['arc-work'].arc).toEqual(arc);
      expect(await getProfile('arc-work')).toMatchObject({
        arc,
        devices: [machineId()],
      });
    } finally {
      if (previousArcDir === undefined) delete process.env.AGENTS_ARC_DIR;
      else process.env.AGENTS_ARC_DIR = previousArcDir;
    }
  });

  it('removes only the agents-cli alias and leaves native Arc metadata discoverable', async () => {
    const previousArcDir = process.env.AGENTS_ARC_DIR;
    const fixtureDir = path.join(import.meta.dirname, 'testdata', 'arc', 'valid');
    const sidebar = path.join(fixtureDir, 'StorableSidebar.json');
    const before = fs.readFileSync(sidebar, 'utf8');
    try {
      process.env.AGENTS_ARC_DIR = fixtureDir;
      const { createProfile, deleteProfile, getProfile, isProfileDeclaredHere } = await import('./profiles.js');
      const discovered = await getProfile('arc-work');
      expect(discovered?.arc?.profileId).toBe('Profile 1');
      await createProfile(discovered!);
      expect(isProfileDeclaredHere('arc-work')).toBe(true);

      await deleteProfile('arc-work');

      expect(isProfileDeclaredHere('arc-work')).toBe(false);
      expect((await getProfile('arc-work'))?.arc?.profileId).toBe('Profile 1');
      expect(fs.readFileSync(sidebar, 'utf8')).toBe(before);
    } finally {
      if (previousArcDir === undefined) delete process.env.AGENTS_ARC_DIR;
      else process.env.AGENTS_ARC_DIR = previousArcDir;
    }
  });

  it('keeps listing every browser when an Arc Space vanished or the Arc read is torn', async () => {
    const previousArcDir = process.env.AGENTS_ARC_DIR;
    try {
      process.env.AGENTS_ARC_DIR = path.join(import.meta.dirname, 'testdata', 'arc', 'valid');
      const { machineId } = await import('../machine-id.js');
      const { createProfile, getProfile, listProfiles } = await import('./profiles.js');
      await createProfile({ name: 'remote-here', browser: 'custom', endpoints: ['ssh://browser-host?port=9344'] });
      // An alias whose Space the user has since deleted in Arc.
      await createProfile({
        name: 'arc-gone',
        browser: 'arc',
        endpoints: { native: { target: 'arc-native://local' } },
        defaultEndpoint: 'native',
        launchPolicy: 'attach-only',
        arc: { profileId: 'Default', profileName: 'Personal', spaceId: 'deleted-space', spaceTitle: 'Gone' },
      });

      const names = (await listProfiles()).map((profile) => profile.name);
      expect(names).toEqual(expect.arrayContaining(['remote-here', 'arc-gone', 'arc-home', 'arc-work']));
      expect((await getProfile('arc-gone'))?.arc?.spaceId).toBe('deleted-space');

      // Arc rewrites its sidebar file constantly; a torn read must not take
      // the Comet row down with it, and only an Arc name pays for the failure.
      process.env.AGENTS_ARC_DIR = path.join(import.meta.dirname, 'testdata', 'arc', 'malformed-profile');
      const degraded = await listProfiles();
      expect(degraded.map((profile) => profile.name)).toEqual(expect.arrayContaining(['remote-here', 'arc-gone']));
      expect(degraded.some((profile) => profile.name === 'arc-home')).toBe(false);
      expect((await getProfile('remote-here'))?.devices).toEqual([machineId()]);
      await expect(getProfile('arc-home')).rejects.toThrow(/Cannot discover Arc Spaces: Arc Space "space-malformed" has an unknown profile mapping/);
      expect(await getProfile('no-such-profile')).toBeNull();
    } finally {
      if (previousArcDir === undefined) delete process.env.AGENTS_ARC_DIR;
      else process.env.AGENTS_ARC_DIR = previousArcDir;
    }
  });

  it('publishes discovered Arc and Comet profiles into this device declaration for the fleet', async () => {
    const previousArc = process.env.AGENTS_ARC_DIR;
    const previousComet = process.env.AGENTS_COMET_DIR;
    try {
      process.env.AGENTS_ARC_DIR = path.join(import.meta.dirname, 'testdata', 'arc', 'valid');
      process.env.AGENTS_COMET_DIR = path.join(import.meta.dirname, 'testdata', 'comet', 'valid');
      const { machineId } = await import('../machine-id.js');
      const { createProfile, getProfile, listProfiles, publishDiscoveredProfiles, isProfileDeclaredHere } = await import('./profiles.js');
      // A pre-existing declaration on the canonical Comet port: discovered rows step past it.
      // The binary is any file that exists so the declaration is accepted on Linux CI too.
      await createProfile({ name: 'comet-local', browser: 'comet', binary: process.execPath, endpoints: ['cdp://127.0.0.1:9333'] });

      const first = await publishDiscoveredProfiles();
      expect(first.errors).toEqual({});
      expect(first.published.sort()).toEqual(['arc-home', 'arc-reading', 'arc-work', 'comet-personal', 'comet-work-default', 'comet-work-profile-2']);
      for (const name of first.published) expect(isProfileDeclaredHere(name)).toBe(true);

      const stored = yaml.parse(fs.readFileSync(deviceFile(machineId()), 'utf8')).browser;
      expect(stored['comet-work-default']).toMatchObject({
        browser: 'comet',
        userDataDir: process.env.AGENTS_COMET_DIR,
        profileDirectory: 'Default',
      });
      const ports = ['comet-work-default', 'comet-personal', 'comet-work-profile-2'].map((name) => stored[name].endpoints[0]);
      expect(new Set(ports).size).toBe(3);
      expect(ports).not.toContain('cdp://127.0.0.1:9333');

      // Idempotent: nothing new on the second pass, and listing shows one row per name.
      expect((await publishDiscoveredProfiles()).published).toEqual([]);
      const names = (await listProfiles()).map((profile) => profile.name);
      expect(names.filter((name) => name === 'comet-work-default')).toHaveLength(1);
      expect((await getProfile('comet-personal'))?.profileDirectory).toBe('Profile 1');

      // A torn Comet read skips Comet, keeps the Arc and declared rows, and only a comet-* lookup pays.
      process.env.AGENTS_COMET_DIR = path.join(import.meta.dirname, 'testdata', 'comet', 'malformed');
      const degraded = await publishDiscoveredProfiles();
      expect(degraded.published).toEqual([]);
      expect(degraded.errors.comet).toMatch(/has no non-empty name/);
      expect((await listProfiles()).map((profile) => profile.name)).toEqual(expect.arrayContaining(['comet-local', 'comet-work-default', 'arc-home']));
      await expect(getProfile('comet-nope')).rejects.toThrow(/Cannot discover comet profiles/);
      expect(await getProfile('arc-nope')).toBeNull();
    } finally {
      if (previousArc === undefined) delete process.env.AGENTS_ARC_DIR; else process.env.AGENTS_ARC_DIR = previousArc;
      if (previousComet === undefined) delete process.env.AGENTS_COMET_DIR; else process.env.AGENTS_COMET_DIR = previousComet;
    }
  });

  it('round-trips create, read, and rename without losing configuration', async () => {
    const { machineId } = await import('../machine-id.js');
    const { createProfile, getProfile, renameProfile } = await import('./profiles.js');
    const input = {
      name: 'remote-work',
      browser: 'custom' as const,
      description: 'credential browser',
      endpoints: ['ssh://browser-host?port=9344'],
      secrets: 'browser-login',
      viewport: { width: 1440, height: 900 },
    };

    await createProfile(input);
    expect(await getProfile(input.name)).toMatchObject({ ...input, devices: [machineId()] });

    await renameProfile(input.name, 'remote-renamed');
    expect(await getProfile(input.name)).toBeNull();
    expect(await getProfile('remote-renamed')).toMatchObject({
      ...input,
      name: 'remote-renamed',
      devices: [machineId()],
    });
  });

  it('refuses to mutate a declaration owned by another device', async () => {
    writeYaml(deviceFile('peer'), {
      browser: { 'signed-in': { browser: 'custom', endpoints: ['ssh://browser-host?port=9355'] } },
    });
    const { updateProfile } = await import('./profiles.js');

    await expect(
      updateProfile({ name: 'signed-in', browser: 'custom', endpoints: ['ssh://browser-host?port=9355'] }),
    ).rejects.toThrow(/not declared on .*; declared on peer/);
  });
});

describe('profileRegistry does not claim central declarations', () => {
  it('leaves a legacy central profile undeclared instead of claiming it for this device', async () => {
    // The regression this guards: profileRegistry() used to call
    // migrateCentralBrowserProfiles() on every read, on every box. Every device
    // can read the central map, so whichever box read first CLAIMED the name --
    // profileKind() then reported `identity` and the daemon tunnelled to THAT
    // box. For `comet-local` at cdp://localhost:9333 that is a logged-out
    // headless chromium on a Linux worker answering to the name of the browser
    // holding five real logins, recorded as a stored fact. Resolution must fail
    // loudly instead, and the central entry must survive for the machine that
    // actually owns the browser to claim explicitly.
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config } });

    const { machineId } = await import('../machine-id.js');
    const { profileRegistry, declaringDevices, profileKind } = await import('./registry.js');

    profileRegistry();

    expect(declaringDevices('comet-local')).toEqual([]);
    expect(profileKind('comet-local')).toBeNull();
    expect(fs.existsSync(deviceFile(machineId()))).toBe(false);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({
      'comet-local': config,
    });
  });
});

describe('ensureDefaultBrowserProfile with undeclared configured default', () => {
  it('throws rather than creating auto-chrome when no device declares the configured default', async () => {
    const { machineId } = await import('../machine-id.js');
    writeYaml(deviceFile(machineId()), { config: { defaultBrowserProfile: 'ghost' } });

    const { ensureDefaultBrowserProfile } = await import('./profiles.js');
    const { profileRegistry } = await import('./registry.js');

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(/not declared by any device/);
    expect(profileRegistry().has('auto-chrome')).toBe(false);
  });

  it('names the claim command when the configured default is a leftover central profile', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config } });
    const { machineId } = await import('../machine-id.js');
    writeYaml(deviceFile(machineId()), { config: { defaultBrowserProfile: 'comet-local' } });

    const { ensureDefaultBrowserProfile } = await import('./profiles.js');
    const { profileRegistry } = await import('./registry.js');

    await expect(ensureDefaultBrowserProfile()).rejects.toThrow(
      /agents browser profiles claim comet-local/,
    );
    expect(profileRegistry().has('auto-chrome')).toBe(false);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({
      'comet-local': config,
    });
  });
});

describe('autoEvictCentralBrowserProfiles (self-draining tombstone, PHNX-3315)', () => {
  it('folds a hostable central tombstone into the device doc, drains central, and the single reader returns it once', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = {
      browser: 'custom',
      binary: process.execPath,
      endpoints: ['cdp://127.0.0.1:9222'],
    };
    writeYaml(centralFile, { browser: { work: config }, model: { claude: 'opus' } });

    const { machineId } = await import('../machine-id.js');
    const { autoEvictCentralBrowserProfiles, profileRegistry, declaringDevices } = await import(
      './registry.js'
    );

    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: ['work'], skipped: [] });

    // Lives in the device doc now…
    expect(yaml.parse(fs.readFileSync(deviceFile(machineId()), 'utf8')).browser).toEqual({ work: config });
    // …central browser: tombstone is drained (other central keys untouched)…
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8'))).toEqual({ model: { claude: 'opus' } });
    // …and the single source of truth returns it exactly once, on this device.
    expect(declaringDevices('work')).toEqual([machineId()]);
    expect(profileRegistry().get('work')).toHaveLength(1);
  });

  it('commits the central agents.yaml it drains, leaving the tree clean at rest (commit-on-write)', async () => {
    // ~/.agents is a real git repo, exactly like a fleet box.
    const agentsDir = path.join(root, '.agents');
    const centralFile = path.join(agentsDir, 'agents.yaml');
    const config = { browser: 'custom', binary: process.execPath, endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(centralFile, { browser: { work: config }, model: { claude: 'opus' } });
    const git = (...a: string[]) => execFileSync('git', ['-C', agentsDir, ...a], { encoding: 'utf-8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'demo@x.co');
    git('config', 'user.name', 'demo');
    git('config', 'commit.gpgsign', 'false');
    git('add', 'agents.yaml');
    git('commit', '-q', '-m', 'seed central');

    const { autoEvictCentralBrowserProfiles } = await import('./registry.js');

    // The eviction rewrites central (drops the claimed profile). Since it moved
    // central bytes on a non-daemon process, commit-on-write commits agents.yaml.
    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: ['work'], skipped: [] });

    // agents.yaml is committed — not left dirty at rest (the pull-trip window).
    expect(git('status', '--porcelain', '--', 'agents.yaml').trim()).toBe('');
    expect(git('log', '-1', '--pretty=%s').trim()).toBe('chore(config): update agents.yaml');
  });

  it('drains once, then the second run claims nothing and rewrites no doc (self-draining, no churn)', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'custom', binary: process.execPath, endpoints: ['cdp://127.0.0.1:9222'] };
    writeYaml(centralFile, { browser: { work: config } });
    const { machineId } = await import('../machine-id.js');
    const { autoEvictCentralBrowserProfiles } = await import('./registry.js');

    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: ['work'], skipped: [] });
    const centralAfter = fs.readFileSync(centralFile, 'utf8');
    const deviceAfter = fs.readFileSync(deviceFile(machineId()), 'utf8');

    // Second run: the tombstone is already drained, so nothing is claimed AND no
    // doc is rewritten — the commit only fires when something is actually claimed,
    // so a routine `agents sync` with no tombstone never churns a file.
    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: [], skipped: [] });
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(centralAfter);
    expect(fs.readFileSync(deviceFile(machineId()), 'utf8')).toBe(deviceAfter);
  });

  it('is idempotent and a no-op when there is no central tombstone', async () => {
    writeYaml(deviceFile('anything'), { browser: {} });
    const { autoEvictCentralBrowserProfiles } = await import('./registry.js');
    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: [], skipped: [] });
  });

  it('never throws on a conflicting local declaration — leaves it central for an explicit claim', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const central = { browser: 'chrome', binary: process.execPath, endpoints: ['cdp://127.0.0.1:9222'] };
    const local = { browser: 'brave', binary: process.execPath, endpoints: ['cdp://127.0.0.1:9333'] };
    writeYaml(centralFile, { browser: { work: central } });
    const { machineId } = await import('../machine-id.js');
    const ownFile = deviceFile(machineId());
    writeYaml(ownFile, { browser: { work: local } });

    const beforeCentral = fs.readFileSync(centralFile, 'utf8');
    const beforeDevice = fs.readFileSync(ownFile, 'utf8');
    const { autoEvictCentralBrowserProfiles } = await import('./registry.js');

    // Unlike the explicit claim (which throws), the automatic path must never
    // wedge a sync: the conflict is skipped and both copies are left untouched.
    expect(autoEvictCentralBrowserProfiles(() => true)).toEqual({ claimed: [], skipped: ['work'] });
    expect(fs.readFileSync(centralFile, 'utf8')).toBe(beforeCentral);
    expect(fs.readFileSync(ownFile, 'utf8')).toBe(beforeDevice);
  });

  it('leaves a profile this machine cannot host in central', async () => {
    const centralFile = path.join(root, '.agents', 'agents.yaml');
    const config = { browser: 'comet', endpoints: ['cdp://localhost:9333'] };
    writeYaml(centralFile, { browser: { 'comet-local': config } });
    const { machineId } = await import('../machine-id.js');
    const { autoEvictCentralBrowserProfiles } = await import('./registry.js');

    expect(autoEvictCentralBrowserProfiles(() => false)).toEqual({ claimed: [], skipped: ['comet-local'] });
    expect(fs.existsSync(deviceFile(machineId()))).toBe(false);
    expect(yaml.parse(fs.readFileSync(centralFile, 'utf8')).browser).toEqual({ 'comet-local': config });
  });
});
