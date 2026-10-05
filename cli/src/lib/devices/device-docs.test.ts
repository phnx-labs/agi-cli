/** The cross-box union readers (PHNX-3315). Each box writes only its own
 * `devices/<host>/agents.yaml`; the fleet view is the deterministic, order-independent union of
 * every doc. Tests prove two boxes' decisions combine regardless of walk order. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

let root = '';
let previousHome: string | undefined;

function writeDoc(device: string, value: unknown): void {
  const file = path.join(root, '.agents', 'devices', device, 'agents.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.stringify(value));
}

async function fresh() {
  vi.resetModules();
  return import('./device-docs.js');
}

beforeEach(() => {
  previousHome = process.env.HOME;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-device-docs-'));
  process.env.HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('unionDeviceDiscovery', () => {
  it('unions two boxes with ignored-beats-approved, order-independent', async () => {
    writeDoc('alpha', { fleet: { discovery: { 'mac-mini': 'approved', ipad: 'approved' } } });
    writeDoc('beta', { fleet: { discovery: { ipad: 'ignored', 'win-mini': 'approved' } } });
    const { unionDeviceDiscovery } = await fresh();
    expect(unionDeviceDiscovery()).toEqual({
      'mac-mini': 'approved',
      ipad: 'ignored', // beta's dismissal beats alpha's approval
      'win-mini': 'approved',
    });
  });

  it('is order-independent — swapping which box says ignored gives the same view', async () => {
    writeDoc('alpha', { fleet: { discovery: { ipad: 'ignored' } } });
    writeDoc('zeta', { fleet: { discovery: { ipad: 'approved' } } });
    const { unionDeviceDiscovery } = await fresh();
    expect(unionDeviceDiscovery().ipad).toBe('ignored');
  });
});

describe('unionDeviceIgnored', () => {
  it('dedups a shared dismissal by name, newest ignoredAt winning', async () => {
    writeDoc('alpha', { fleet: { ignored: [{ name: 'x', ignoredAt: '2026-01-01T00:00:00.000Z', ignoredOn: 'alpha' }] } });
    writeDoc('beta', {
      fleet: {
        ignored: [
          { name: 'x', ignoredAt: '2026-02-01T00:00:00.000Z', ignoredOn: 'beta' },
          { name: 'y', ignoredAt: '2026-01-15T00:00:00.000Z', ignoredOn: 'beta' },
        ],
      },
    });
    const { unionDeviceIgnored } = await fresh();
    expect(unionDeviceIgnored()).toEqual([
      { name: 'x', ignoredAt: '2026-02-01T00:00:00.000Z', ignoredOn: 'beta' }, // newest wins
      { name: 'y', ignoredAt: '2026-01-15T00:00:00.000Z', ignoredOn: 'beta' },
    ]);
  });
});

describe('unionDeviceHosts', () => {
  it('merges host overlays across boxes, newest addedAt winning a name collision', async () => {
    writeDoc('alpha', { hosts: { shared: { source: 'inline', address: 'old', addedAt: '2026-01-01T00:00:00.000Z' }, onlyA: { source: 'ssh-config' } } });
    writeDoc('beta', { hosts: { shared: { source: 'inline', address: 'new', addedAt: '2026-06-01T00:00:00.000Z' } } });
    const { unionDeviceHosts } = await fresh();
    const merged = unionDeviceHosts();
    expect(merged.shared.address).toBe('new'); // 2026-06 beats 2026-01
    expect(merged.onlyA).toEqual({ source: 'ssh-config' });
  });
});

describe('corruption contract', () => {
  it('throws on a non-map device doc rather than silently dropping a peer', async () => {
    writeDoc('alpha', ['not', 'a', 'map']);
    const { readAllDeviceDocs } = await fresh();
    expect(() => readAllDeviceDocs()).toThrow(/corrupted/);
  });
});
