import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';
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

const chrome = { browser: 'chrome' as const, endpoints: ['cdp://127.0.0.1:9222'] };
const comet = { browser: 'comet' as const, endpoints: ['cdp://localhost:9333'] };

beforeEach(() => {
  previousHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-browser-resolve-target-'));
  process.env.HOME = root;
  vi.resetModules();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('shouldForkProfile', () => {
  it('never forks an identity-bearing profile, even Electron with live tasks', async () => {
    const { shouldForkProfile } = await import('./resolve-target.js');
    expect(
      shouldForkProfile('identity', { electron: true, tasks: { size: 2 } }),
    ).toBe(false);
  });

  it('forks a fungible Electron profile that already has a task', async () => {
    const { shouldForkProfile } = await import('./resolve-target.js');
    expect(
      shouldForkProfile('fungible', { electron: true, tasks: { size: 1 } }),
    ).toBe(true);
    expect(
      shouldForkProfile('fungible', { electron: true, tasks: { size: 0 } }),
    ).toBe(false);
    expect(
      shouldForkProfile('fungible', { electron: false, tasks: { size: 1 } }),
    ).toBe(false);
  });
});

describe('sshEndpointForDeclaration', () => {
  it('rewrites a loopback cdp:// declaration to ssh://<device>?port=N', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    expect(sshEndpointForDeclaration('peer-zulu', comet)).toBe('ssh://peer-zulu?port=9333');
  });

  it('adds os=windows when the declaring device is Windows', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    expect(sshEndpointForDeclaration('win-mini', chrome, undefined, 'Windows_NT')).toBe(
      'ssh://win-mini?port=9222&os=windows',
    );
  });

  it('leaves an already-ssh:// declaration alone', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    const config = { browser: 'custom' as const, endpoints: ['ssh://browser-host?port=9344'] };
    expect(sshEndpointForDeclaration('peer-zulu', config)).toBe('ssh://browser-host?port=9344');
  });

  it('does not manufacture an SSH/CDP endpoint for native Arc', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    const config = {
      browser: 'arc' as const,
      endpoints: { native: { target: 'arc-native://local' } },
      arc: { profileId: 'Profile 1', profileName: 'Work', spaceId: 'space-work', spaceTitle: 'Work' },
    };
    expect(sshEndpointForDeclaration('zion', config)).toBe('arc-native://local');
  });

  it('does not manufacture an SSH/CDP endpoint for a Firefox BiDi profile', async () => {
    const { sshEndpointForDeclaration } = await import('./resolve-target.js');
    const config = {
      browser: 'firefox' as const,
      endpoints: { bidi: { target: 'firefox-bidi://127.0.0.1:9652' } },
      firefox: { profileName: 'default', iniPath: '/home/u/.mozilla/firefox/profiles.ini', isDefault: true },
    };
    expect(sshEndpointForDeclaration('yosemite-s0', config)).toBe('firefox-bidi://127.0.0.1:9652');
  });
});

describe('resolveBrowserTarget', () => {
  it('marks a remote native Arc declaration for whole-command dispatch', async () => {
    const config = {
      browser: 'arc' as const,
      endpoints: { native: { target: 'arc-native://local' } },
      defaultEndpoint: 'native',
      arc: { profileId: 'Profile 1', profileName: 'Work', spaceId: 'space-work', spaceTitle: 'Work' },
    };
    writeYaml(deviceFile('zion'), { browser: { 'arc-work': config } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    const routed = resolveBrowserTarget('arc-work', {
      here: 'worker',
      probe: () => ({ reachable: true, os: 'Darwin' }),
    });
    expect(routed).toMatchObject({
      local: false,
      device: 'zion',
      target: 'arc-native://local',
      commandDispatch: true,
      profile: { arc: config.arc },
    });
  });

  it('marks a remote Firefox BiDi declaration for whole-command dispatch', async () => {
    const config = {
      browser: 'firefox' as const,
      endpoints: { bidi: { target: 'firefox-bidi://127.0.0.1:9652' } },
      defaultEndpoint: 'bidi',
      firefox: { profileName: 'default', iniPath: '/home/u/.mozilla/firefox/profiles.ini', isDefault: true },
    };
    writeYaml(deviceFile('yosemite-s0'), { browser: { 'firefox-default': config } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    const routed = resolveBrowserTarget('firefox-default', {
      here: 'yosemite-s1',
      probe: () => ({ reachable: true, os: 'Linux' }),
    });
    expect(routed).toMatchObject({
      local: false,
      device: 'yosemite-s0',
      target: 'firefox-bidi://127.0.0.1:9652',
      commandDispatch: true,
      profile: { firefox: config.firefox },
    });
  });

  it('connects locally when THIS device declares the name', async () => {
    const { machineId } = await import('../machine-id.js');
    writeYaml(deviceFile(machineId()), { browser: { work: chrome } });
    writeYaml(deviceFile('other'), { browser: { work: chrome } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    const routed = resolveBrowserTarget('work');
    expect(routed.local).toBe(true);
    expect(routed.kind).toBe('fungible');
    expect(routed.device).toBe(machineId());
    expect(routed.target).toBe('cdp://127.0.0.1:9222');
    expect(routed.key).toBe(`work@${machineId()}`);
    expect(routed.picked).toBeUndefined();
  });

  it('tunnels to a reachable declaring device when this machine does not declare it', async () => {
    writeYaml(deviceFile('peer-alpha'), { browser: { 'comet-local': comet } });
    writeYaml(deviceFile('peer-zulu'), { browser: { 'comet-local': comet } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    const probed: string[] = [];
    const routed = resolveBrowserTarget('comet-local', {
      probe: (device) => {
        probed.push(device);
        return { reachable: true, os: 'Darwin' };
      },
    });
    expect(routed.local).toBe(false);
    expect(routed.kind).toBe('fungible');
    expect(routed.device).toBe('peer-alpha');
    expect(routed.target).toBe('ssh://peer-alpha?port=9333');
    expect(routed.key).toBe('comet-local@peer-alpha');
    expect(routed.picked).toContain('peer-alpha');
    expect(routed.picked).toContain('peer-zulu');
    expect(probed).toEqual(['peer-alpha']);
  });

  it('skips an unreachable declaring device and picks the next sorted one', async () => {
    writeYaml(deviceFile('aaa-down'), { browser: { agents: chrome } });
    writeYaml(deviceFile('zzz-up'), { browser: { agents: chrome } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    const routed = resolveBrowserTarget('agents', {
      probe: (device) =>
        device === 'zzz-up'
          ? { reachable: true }
          : { reachable: false, reason: 'ssh timed out' },
    });
    expect(routed.device).toBe('zzz-up');
    expect(routed.target).toBe('ssh://zzz-up?port=9222');
    expect(routed.picked).toBe('Using agents on zzz-up (declared on aaa-down, zzz-up)');
  });

  it('fails loud when every declaring device is unreachable — does not invent a local target', async () => {
    writeYaml(deviceFile('peer-zulu'), { browser: { 'comet-local': comet } });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    expect(() =>
      resolveBrowserTarget('comet-local', {
        probe: () => ({ reachable: false, reason: 'No route to host' }),
      }),
    ).toThrow(/peer-zulu/);
    expect(() =>
      resolveBrowserTarget('comet-local', {
        probe: () => ({ reachable: false, reason: 'No route to host' }),
      }),
    ).toThrow(/No route to host/);
    expect(() =>
      resolveBrowserTarget('comet-local', {
        probe: () => ({ reachable: false, reason: 'No route to host' }),
      }),
    ).toThrow(/will not be launched/);
  });

  it('fails loud when nobody declares the name, listing similar names and their devices', async () => {
    writeYaml(deviceFile('peer-zulu'), { browser: { 'comet-local': comet } });

    const { resolveBrowserTarget, undeclaredProfileError } = await import('./resolve-target.js');
    expect(() => resolveBrowserTarget('comet-locl')).toThrow(/comet-local/);
    expect(() => resolveBrowserTarget('comet-locl')).toThrow(/peer-zulu/);
    expect(() => resolveBrowserTarget('comet-locl')).toThrow(/not declared by any device/);
    expect(undeclaredProfileError('ghost').message).toMatch(/No device declares a similar name/);
  });

  it('points at profiles claim when the name is a leftover central entry', async () => {
    writeYaml(path.join(root, '.agents', 'agents.yaml'), {
      browser: { 'comet-local': comet },
    });

    const { resolveBrowserTarget } = await import('./resolve-target.js');
    expect(() => resolveBrowserTarget('comet-local')).toThrow(/profiles claim comet-local/);
    expect(() => resolveBrowserTarget('comet-local')).not.toThrow(/will not be launched/);
  });
});

describe('migrateLegacyRuntimeDir', () => {
  it('renames a single leftover @endpoint-N dir onto the new key', async () => {
    const { migrateLegacyRuntimeDir, profileConnectionKey } = await import('./resolve-target.js');
    const runtime = path.join(root, 'browser-runtime');
    const legacy = path.join(runtime, 'comet-local@endpoint-0', 'chrome-data');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'Cookies'), 'keep-me');

    const next = profileConnectionKey('comet-local', 'peer-zulu');
    migrateLegacyRuntimeDir('comet-local', next, runtime);

    expect(fs.existsSync(path.join(runtime, 'comet-local@endpoint-0'))).toBe(false);
    expect(fs.readFileSync(path.join(runtime, next, 'chrome-data', 'Cookies'), 'utf8')).toBe(
      'keep-me',
    );
  });

  it('does not rename a leftover dir onto a remote key', async () => {
    const { adoptLegacyRuntimeIfLocal, profileConnectionKey } = await import('./resolve-target.js');
    const runtime = path.join(root, 'browser-runtime');
    fs.mkdirSync(path.join(runtime, 'comet-local@endpoint-0', 'chrome-data'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'comet-local@endpoint-0', 'chrome-data', 'Cookies'), 'local');

    const remoteKey = profileConnectionKey('comet-local', 'peer-zulu');
    adoptLegacyRuntimeIfLocal(false, 'comet-local', remoteKey, runtime);

    expect(fs.existsSync(path.join(runtime, 'comet-local@endpoint-0', 'chrome-data', 'Cookies'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(runtime, remoteKey))).toBe(false);
  });

  it('does not merge several leftover endpoint dirs', async () => {
    const { migrateLegacyRuntimeDir, profileConnectionKey } = await import('./resolve-target.js');
    const runtime = path.join(root, 'browser-runtime');
    fs.mkdirSync(path.join(runtime, 'work@endpoint-0'), { recursive: true });
    fs.mkdirSync(path.join(runtime, 'work@endpoint-1'), { recursive: true });

    migrateLegacyRuntimeDir('work', profileConnectionKey('work', 'here'), runtime);

    expect(fs.existsSync(path.join(runtime, 'work@endpoint-0'))).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'work@endpoint-1'))).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'work@here'))).toBe(false);
  });
});
