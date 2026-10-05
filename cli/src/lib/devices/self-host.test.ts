import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-selfhost-test-'));
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, 'devices');
process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';

const SELF_DNS = 'testbox.tail1a85a1.ts.net';
const PEER_DNS = 'yosemite-s0.tail1a85a1.ts.net';
fs.mkdirSync(path.join(TEST_HOME, 'devices'), { recursive: true });
fs.writeFileSync(
  path.join(TEST_HOME, 'devices', 'registry.json'),
  JSON.stringify({
    testbox: { name: 'testbox', address: { via: 'tailscale', dnsName: SELF_DNS } },
    'yosemite-s0': { name: 'yosemite-s0', address: { via: 'tailscale', dnsName: PEER_DNS } },
  }),
);

const { isSelfHost, resetSelfHostCache } = await import('./self-host.js');
resetSelfHostCache();

describe('isSelfHost (RUSH-2114)', () => {
  it('matches the short machine id', () => {
    expect(isSelfHost('testbox')).toBe(true);
  });

  it('matches the tailscale dnsName — the alias that used to self-SSH', () => {
    expect(isSelfHost(SELF_DNS)).toBe(true);
  });

  it('is case-insensitive and trailing-dot tolerant', () => {
    expect(isSelfHost('TESTBOX.Tail1A85A1.TS.NET.')).toBe(true);
  });

  it('matches loopback names', () => {
    expect(isSelfHost('localhost')).toBe(true);
    expect(isSelfHost('127.0.0.1')).toBe(true);
    expect(isSelfHost('::1')).toBe(true);
  });

  it('does NOT match a genuine peer by short name OR dnsName (would break --device to real remotes)', () => {
    expect(isSelfHost('yosemite-s0')).toBe(false);
    expect(isSelfHost(PEER_DNS)).toBe(false);
  });

  it('rejects empty / nullish input', () => {
    expect(isSelfHost('')).toBe(false);
    expect(isSelfHost('   ')).toBe(false);
    expect(isSelfHost(undefined)).toBe(false);
    expect(isSelfHost(null)).toBe(false);
  });
});
