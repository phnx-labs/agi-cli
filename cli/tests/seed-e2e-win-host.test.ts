/** Unit coverage for the hermetic e2e device seeder (RUSH-2042), real filesystem only, no mocks: the
 * pure helpers and the seeder against temp dirs standing in for the real and private registries. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isIpLiteral,
  parseSshG,
  seedHermeticE2eWinHost,
  synthesizeWindowsDevice,
} from './seed-e2e-win-host.js';

describe('parseSshG', () => {
  it('extracts user and hostname from ssh -G stdout', () => {
    const out = [
      'user muqsit',
      'hostname 100.68.123.39',
      'port 22',
      'identityfile ~/.ssh/id_ed25519',
    ].join('\n');
    expect(parseSshG(out)).toEqual({ user: 'muqsit', hostname: '100.68.123.39' });
  });

  it('returns null when user or hostname is missing', () => {
    expect(parseSshG('user only\n')).toBeNull();
    expect(parseSshG('hostname only.example\n')).toBeNull();
    expect(parseSshG('')).toBeNull();
  });

  it('tolerates CRLF (Windows autocrlf on a checked-in fixture)', () => {
    expect(parseSshG('user muqsit\r\nhostname win-mini.tail1a85a1.ts.net\r\n')).toEqual({
      user: 'muqsit',
      hostname: 'win-mini.tail1a85a1.ts.net',
    });
  });
});

describe('isIpLiteral / synthesizeWindowsDevice', () => {
  it('puts IPv4 in address.ip and FQDN in address.dnsName', () => {
    expect(isIpLiteral('100.68.123.39')).toBe(true);
    expect(isIpLiteral('win-mini.tail1a85a1.ts.net')).toBe(false);

    const ipDev = synthesizeWindowsDevice('win-mini', { user: 'muqsit', hostname: '100.68.123.39' }, '2026-08-06T00:00:00.000Z');
    expect(ipDev).toMatchObject({
      name: 'win-mini',
      platform: 'windows',
      shell: 'powershell',
      user: 'muqsit',
      address: { via: 'manual', ip: '100.68.123.39' },
      auth: { method: 'key' },
    });

    const dnsDev = synthesizeWindowsDevice(
      'win-mini',
      { user: 'muqsit', hostname: 'win-mini.tail1a85a1.ts.net' },
      '2026-08-06T00:00:00.000Z',
    );
    expect(dnsDev.address).toEqual({ via: 'manual', dnsName: 'win-mini.tail1a85a1.ts.net' });
  });
});

describe('seedHermeticE2eWinHost', () => {
  let root: string;
  let devicesDir: string;
  let realRegPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-e2e-'));
    devicesDir = path.join(root, 'private-devices');
    realRegPath = path.join(root, 'real-registry.json');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('copies the named entry from the real fleet registry into the private dir', () => {
    const entry = {
      name: 'win-mini',
      platform: 'windows',
      shell: 'powershell',
      user: 'muqsit',
      address: { via: 'tailscale', dnsName: 'win-mini.tail1a85a1.ts.net' },
      auth: { method: 'key' },
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    };
    fs.writeFileSync(realRegPath, JSON.stringify({ 'win-mini': entry, 'other-box': { name: 'other-box' } }));

    const source = seedHermeticE2eWinHost({
      host: 'win-mini',
      devicesDir,
      realRegistryPath: realRegPath,
      resolveSshG: () => {
        throw new Error('ssh -G must not run when the real registry has the host');
      },
    });
    expect(source).toBe('real');

    const priv = JSON.parse(fs.readFileSync(path.join(devicesDir, 'registry.json'), 'utf-8'));
    expect(priv['win-mini']).toEqual(entry);
    // Only the e2e host is seeded — do not dump the whole fleet into the private dir.
    expect(priv['other-box']).toBeUndefined();

    // Real registry is never written.
    const realAfter = fs.readFileSync(realRegPath, 'utf-8');
    expect(realAfter).toContain('other-box');
  });

  it('falls back to ssh -G when the real registry has no entry', () => {
    fs.writeFileSync(realRegPath, JSON.stringify({}));

    const source = seedHermeticE2eWinHost({
      host: 'win-mini',
      devicesDir,
      realRegistryPath: realRegPath,
      resolveSshG: () => ({ user: 'muqsit', hostname: '100.68.123.39' }),
      now: '2026-08-06T12:00:00.000Z',
    });
    expect(source).toBe('ssh-g');

    const priv = JSON.parse(fs.readFileSync(path.join(devicesDir, 'registry.json'), 'utf-8'));
    expect(priv['win-mini']).toMatchObject({
      name: 'win-mini',
      platform: 'windows',
      user: 'muqsit',
      address: { via: 'manual', ip: '100.68.123.39' },
    });
  });

  it('returns already when the private registry already has the host', () => {
    fs.mkdirSync(devicesDir, { recursive: true });
    fs.writeFileSync(
      path.join(devicesDir, 'registry.json'),
      JSON.stringify({ 'win-mini': { name: 'win-mini', platform: 'windows' } }),
    );

    const source = seedHermeticE2eWinHost({
      host: 'win-mini',
      devicesDir,
      realRegistryPath: realRegPath,
      resolveSshG: () => {
        throw new Error('must short-circuit on already-present entry');
      },
    });
    expect(source).toBe('already');
  });

  it('returns missing when neither source can provide the host', () => {
    const source = seedHermeticE2eWinHost({
      host: 'win-mini',
      devicesDir,
      realRegistryPath: path.join(root, 'does-not-exist.json'),
      resolveSshG: () => null,
    });
    expect(source).toBe('missing');
    expect(fs.existsSync(path.join(devicesDir, 'registry.json'))).toBe(false);
  });

  it('returns missing for an empty host name', () => {
    expect(
      seedHermeticE2eWinHost({
        host: '   ',
        devicesDir,
        realRegistryPath: realRegPath,
      }),
    ).toBe('missing');
  });
});
