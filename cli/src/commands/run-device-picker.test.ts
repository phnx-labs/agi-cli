/**
 * Real-file tests for the `agents run <agent>@` device picker (PHNX-4083).
 *
 * Everything the picker reads is pointed at a test-private HOME before any
 * module under test is imported (state.ts pins HOME at module load, the same
 * constraint registry.test.ts documents): the SSH device registry under
 * AGENTS_DEVICES_DIR, the fleet-stats cache under <HOME>/.agents/.cache, the
 * fleet-synced device docs under <HOME>/.agents/devices/<name>/, and the
 * account catalog in <HOME>/.agents/agents.yaml. No SSH is possible — the
 * registry names do not resolve — so a green read IS the proof the picker
 * never re-probes.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-run-device-picker-test-'));
process.env.HOME = TEST_HOME;
process.env.AGENTS_DEVICES_DIR = path.join(TEST_HOME, 'devices');
process.env.AGENTS_SYNC_MACHINE_ID = 'zion';
process.env.AGENTS_SKIP_MIGRATION = '1';

const USER_AGENTS_DIR = path.join(TEST_HOME, '.agents');
const DEVICES_DOC_DIR = path.join(USER_AGENTS_DIR, 'devices');
const STATS_CACHE_FILE = path.join(USER_AGENTS_DIR, '.cache', '.fleet-stats.json');
const CENTRAL_META_FILE = path.join(USER_AGENTS_DIR, 'agents.yaml');

const picker = await import('./run-device-picker.js');
const { upsertDevice } = await import('../lib/devices/registry.js');
const { resetSelfHostCache } = await import('../lib/devices/self-host.js');

const OFFLINE_CHECKED_AT = '2026-09-12T08:30:00.000Z';

function writeDeviceDoc(name: string, config: Record<string, unknown>): void {
  const dir = path.join(DEVICES_DOC_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.yaml'), `config:\n${Object.entries(config).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n`);
}

function writeSharedAccountRows(name: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(DEVICES_DOC_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'daemon-state.json'),
    `${JSON.stringify({ version: 1, device: name, accounts: { rows } }, null, 2)}\n`,
  );
}

function writeStatsCache(entries: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(STATS_CACHE_FILE), { recursive: true });
  fs.writeFileSync(STATS_CACHE_FILE, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
}

function stat(reachable: boolean, fetchedAt: number, loadPercent?: number, memPercent?: number) {
  return { host: 'x', reachable, loadPercent, memPercent, fetchedAt };
}

/** The standard 5-device fleet: local, two online workers, one stats-less, one offline. */
async function seedFleet(): Promise<void> {
  await upsertDevice('zion', { platform: 'macos', address: { via: 'manual' } });
  await upsertDevice('worker-1', { platform: 'linux', address: { via: 'manual' } });
  await upsertDevice('worker-2', { platform: 'linux', address: { via: 'manual' } });
  await upsertDevice('worker-3', { platform: 'linux', address: { via: 'manual' } });
  await upsertDevice('worker-4', {
    platform: 'linux',
    address: { via: 'manual' },
    reachability: { reachable: false, via: 'manual', checkedAt: OFFLINE_CHECKED_AT },
  });
  writeDeviceDoc('zion', { role: 'personal' });
  writeDeviceDoc('worker-1', { role: 'worker', description: 'ci box' });
  writeDeviceDoc('worker-2', { role: 'worker' });
  writeDeviceDoc('worker-3', { role: 'worker' });
  writeDeviceDoc('worker-4', { role: 'worker' });
}

beforeEach(async () => {
  await fsp.rm(path.join(process.env.AGENTS_DEVICES_DIR!, 'registry.json'), { force: true });
  await fsp.rm(`${path.join(process.env.AGENTS_DEVICES_DIR!, 'registry.json')}.lock`, { recursive: true, force: true });
  await fsp.rm(DEVICES_DOC_DIR, { recursive: true, force: true });
  await fsp.rm(STATS_CACHE_FILE, { force: true });
  await fsp.rm(CENTRAL_META_FILE, { force: true });
  resetSelfHostCache();
});

afterAll(async () => {
  await fsp.rm(TEST_HOME, { recursive: true, force: true });
});

describe('readRunDeviceRows', () => {
  it('resolves every row from disk with zero network (no cached stats → unknown, offline → lastSeenAt)', async () => {
    await seedFleet();
    const twoMinAgo = Date.now() - 120_000;
    writeStatsCache({
      zion: stat(true, twoMinAgo - 10_000, 5, 30),
      'worker-1': stat(true, twoMinAgo, 10, 10),
      'worker-2': stat(true, Date.now() - 30_000, 50, 20),
    });

    const started = Date.now();
    const { rows, snapshotAgeMs } = picker.readRunDeviceRows({ agent: 'claude' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000); // a disk read, never a probe
    expect(rows).toHaveLength(5);

    const byName = new Map(rows.map((row) => [row.name, row]));
    const zion = byName.get('zion')!;
    expect(zion.isLocal).toBe(true);
    expect(zion.platform).toBe('macos');
    expect(zion.online).toBe('online');
    expect(zion.role).toBe('personal');
    expect(zion.headroom).toBe('light'); // worst of load 5 / mem 30
    expect(zion.loadPercent).toBe(5);

    const worker1 = byName.get('worker-1')!;
    expect(worker1.isLocal).toBe(false);
    expect(worker1.role).toBe('worker');
    expect(worker1.description).toBe('ci box');
    expect(worker1.headroom).toBe('idle');
    expect(worker1.statsFetchedAt).toBe(twoMinAgo);

    const worker2 = byName.get('worker-2')!;
    expect(worker2.online).toBe('online');
    expect(worker2.headroom).toBe('busy');

    const worker3 = byName.get('worker-3')!;
    expect(worker3.online).toBe('unknown');
    expect(worker3.headroom).toBe('unknown');
    expect(worker3.loadPercent).toBeUndefined();
    expect(worker3.memPercent).toBeUndefined();
    expect(worker3.statsFetchedAt).toBeUndefined();

    const worker4 = byName.get('worker-4')!;
    expect(worker4.online).toBe('offline');
    expect(worker4.lastSeenAt).toBe(OFFLINE_CHECKED_AT);

    // Age of the NEWEST stats row (worker-2, 30 s old at write time).
    expect(snapshotAgeMs).toBeGreaterThanOrEqual(29_000);
    expect(snapshotAgeMs).toBeLessThan(35_000);
  });

  it('reports snapshotAgeMs as undefined when the cache is empty', async () => {
    await seedFleet();
    const { snapshotAgeMs } = picker.readRunDeviceRows({ agent: 'claude' });
    expect(snapshotAgeMs).toBeUndefined();
  });

  it('answers hasAccount per device from the fleet-synced catalog, undefined where the catalog cannot answer', async () => {
    await seedFleet();
    fs.writeFileSync(CENTRAL_META_FILE, [
      'accounts:',
      '  native:',
      '    acct-work:',
      '      id: acct-work',
      '      name: work',
      '      agent: claude',
      '      identityKey: work@example.com',
      '      scope: version',
      '',
    ].join('\n'));
    // worker-1 publishes a live verdict for the account; worker-2 publishes
    // verdicts but not for this account; the other boxes publish nothing.
    writeSharedAccountRows('worker-1', [
      { accountId: 'acct-work', harness: 'claude', authMode: 'durable', verdict: 'live', checkedAt: '2026-09-12T09:00:00.000Z' },
    ]);
    writeSharedAccountRows('worker-2', [
      { accountId: 'acct-other', harness: 'claude', authMode: 'durable', verdict: 'live' },
    ]);

    const { rows } = picker.readRunDeviceRows({ agent: 'claude', accountLabel: 'work' });
    const byName = new Map(rows.map((row) => [row.name, row]));
    expect(byName.get('worker-1')!.hasAccount).toBe(true);
    expect(byName.get('worker-2')!.hasAccount).toBe(false);
    expect(byName.get('zion')!.hasAccount).toBeUndefined();
    expect(byName.get('worker-3')!.hasAccount).toBeUndefined();

    // An account label the catalog has never heard of: no device can be answered.
    const unknown = picker.readRunDeviceRows({ agent: 'claude', accountLabel: 'nope' });
    for (const row of unknown.rows) expect(row.hasAccount).toBeUndefined();

    // No label asked: the question was never posed.
    const unasked = picker.readRunDeviceRows({ agent: 'claude' });
    for (const row of unasked.rows) expect(row.hasAccount).toBeUndefined();
  });
});

describe('buildRunDeviceChoices', () => {
  it('orders local first, online by headroom then load, unknown-state, offline last and disabled', async () => {
    await seedFleet();
    writeStatsCache({
      zion: stat(true, Date.now(), 5, 30),
      'worker-1': stat(true, Date.now(), 10, 20),
      'worker-2': stat(true, Date.now(), 50, 20),
    });

    const { rows } = picker.readRunDeviceRows({ agent: 'claude' });
    const choices = picker.buildRunDeviceChoices(rows);

    expect(choices.map((choice) => choice.value)).toEqual([
      'zion', 'worker-1', 'worker-2', 'worker-3', 'worker-4',
    ]);

    const byName = new Map(choices.map((choice) => [choice.value, choice]));
    expect(byName.get('zion')!.name).toContain('this machine');
    expect(byName.get('worker-3')!.name).toContain('—'); // no cached stats → no load number
    expect(byName.get('worker-4')!.disabled).toMatch(/^offline since \d{2}:\d{2}$/);
    expect(byName.get('zion')!.disabled).toBeUndefined();
  });

  it('is pure: idle before light before busy, load ascending within a bucket, name as tiebreak', () => {
    const row = (over: Partial<picker.RunDeviceRow>): picker.RunDeviceRow => ({
      name: 'box',
      isLocal: false,
      online: 'online',
      headroom: 'idle',
      ...over,
    });
    const choices = picker.buildRunDeviceChoices([
      row({ name: 'loaded-box', headroom: 'loaded', loadPercent: 99 }),
      row({ name: 'busy-b', headroom: 'busy', loadPercent: 60 }),
      row({ name: 'busy-a', headroom: 'busy', loadPercent: 60 }),
      row({ name: 'busy-low', headroom: 'busy', loadPercent: 45 }),
      row({ name: 'light-box', headroom: 'light', loadPercent: 20 }),
      row({ name: 'local-box', isLocal: true, headroom: 'loaded', loadPercent: 100 }),
      row({ name: 'idle-box', headroom: 'idle', loadPercent: 2 }),
    ]);
    expect(choices.map((choice) => choice.value)).toEqual([
      'local-box', 'idle-box', 'light-box', 'busy-low', 'busy-a', 'busy-b', 'loaded-box',
    ]);
  });

  it('renders the ✓/– account mark only when the label is given and the catalog answered', async () => {
    await seedFleet();
    fs.writeFileSync(CENTRAL_META_FILE, [
      'accounts:',
      '  native:',
      '    acct-work:',
      '      id: acct-work',
      '      name: work',
      '      agent: claude',
      '      identityKey: work@example.com',
      '      scope: version',
      '',
    ].join('\n'));
    writeSharedAccountRows('worker-1', [
      { accountId: 'acct-work', harness: 'claude', authMode: 'durable', verdict: 'live' },
    ]);

    const { rows } = picker.readRunDeviceRows({ agent: 'claude', accountLabel: 'work' });
    const withLabel = new Map(picker.buildRunDeviceChoices(rows, 'work').map((c) => [c.value, c]));
    expect(withLabel.get('worker-1')!.name).toContain('✓ work');
    expect(withLabel.get('zion')!.name).not.toContain('✓');
    expect(withLabel.get('zion')!.name).not.toContain('–');

    const withoutLabel = new Map(picker.buildRunDeviceChoices(rows).map((c) => [c.value, c]));
    expect(withoutLabel.get('worker-1')!.name).not.toContain('✓');
  });
});

describe('pickRunDevice', () => {
  it('off a TTY fails loud, naming the non-interactive forms', async () => {
    await seedFleet();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errors: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
      errors.push(String(msg));
    });
    try {
      await expect(picker.pickRunDevice({ agent: 'claude' })).rejects.toThrow('process.exit(1)');
      const output = errors.join('\n');
      expect(output).toContain('Selecting a device requires an interactive terminal.');
      expect(output).toContain('agents run claude --device <name>');
      expect(output).toContain('agents devices');
    } finally {
      exit.mockRestore();
      errSpy.mockRestore();
    }
  });
});
