/** Persistence guarantees for the device ignore-list ("a dismissed device never resurfaces"):
 * addIgnored survives a reload in central `fleet.ignored` (RUSH-3062) and is idempotent,
 * removeIgnored its exact inverse; a malformed list throws rather than returning an empty set. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-devices-ignored-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'testbox';
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, '.agents', '.history', 'devices');

const { loadIgnored, loadIgnoredEntries, addIgnored, removeIgnored, isIgnored } = await import('./registry.js');
const { computePendingDevices } = await import('./sync.js');
import type { TailscaleNode } from './tailscale.js';

function centralPath(): string {
  return path.join(TEST_HOME, '.agents', 'agents.yaml');
}
function readCentral(): string {
  return fs.existsSync(centralPath()) ? fs.readFileSync(centralPath(), 'utf-8') : '';
}
function deviceDocPath(): string {
  return path.join(TEST_HOME, '.agents', 'devices', 'testbox', 'agents.yaml');
}
function readDeviceDoc(): string {
  return fs.existsSync(deviceDocPath()) ? fs.readFileSync(deviceDocPath(), 'utf-8') : '';
}
function node(name: string): TailscaleNode {
  return { name, platform: 'linux', online: true, direct: true, sharee: false };
}

beforeEach(async () => {
  await fsp.rm(path.join(TEST_HOME, '.agents'), { recursive: true, force: true });
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('device ignore-list', () => {
  it('returns an empty set when nothing is ignored', async () => {
    expect([...(await loadIgnored())]).toEqual([]);
    expect(loadIgnoredEntries()).toEqual([]);
  });

  it("persists a dismissal across reloads and lands in THIS box's device doc, not central", async () => {
    await addIgnored('ipad165');
    expect(await isIgnored('ipad165')).toBe(true);
    expect([...(await loadIgnored())]).toEqual(['ipad165']);
    const doc = readDeviceDoc();
    expect(doc).toContain('ignored:');
    expect(doc).toContain('ipad165');
    expect(doc).toContain('testbox');
    expect(readCentral()).not.toContain('ipad165');
    const entries = loadIgnoredEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('ipad165');
    expect(entries[0].ignoredOn).toBe('testbox');
    expect(Number.isNaN(Date.parse(entries[0].ignoredAt))).toBe(false);
  });

  it('is idempotent, stores names sorted, and keeps the original who/when on re-add', async () => {
    await addIgnored('win-mini');
    await addIgnored('ipad165');
    const before = loadIgnoredEntries();
    await addIgnored('win-mini');
    expect([...(await loadIgnored())]).toEqual(['ipad165', 'win-mini']);
    expect(loadIgnoredEntries()).toEqual(before);
  });

  it('removeIgnored is the exact inverse and reports miss vs hit', async () => {
    await addIgnored('mac-mini');
    expect(await removeIgnored('mac-mini')).toBe(true);
    expect(await isIgnored('mac-mini')).toBe(false);
    expect(await removeIgnored('mac-mini')).toBe(false);
  });

  it('throws on a corrupted fleet.ignored on READ, and a write never clobbers the block', async () => {
    await fsp.mkdir(path.dirname(centralPath()), { recursive: true });
    await fsp.writeFile(centralPath(), 'fleet:\n  devices: {}\n  ignored: not-a-list\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
    await addIgnored('win-mini');
    expect(readCentral()).toContain('not-a-list');
    expect(readDeviceDoc()).toContain('win-mini');

    await fsp.writeFile(centralPath(), 'fleet:\n  devices: {}\n  ignored:\n    - name: ipad165\n');
    await expect(loadIgnored()).rejects.toThrow(/corrupted/);
  });

  it('keeps an ignored node subtracted from the discovery pending-diff', async () => {
    await addIgnored('ipad165');
    const pending = computePendingDevices(
      [node('zion'), node('ipad165')],
      [],
      [...(await loadIgnored())],
    );
    expect(pending).toEqual(['zion']);
  });
});
