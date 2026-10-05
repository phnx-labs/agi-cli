import { describe, expect, it } from 'vitest';
import {
  guardedHome,
  run,
  centralDoc,
  deviceDoc,
  addDevice,
} from './device-config-test-harness.js';

describe('devices config --fleet (fleet-wide defaults layer)', () => {
  it('writes central fleet.defaults.config and every device inherits it', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    addDevice('zion', 'muqsit@192.0.2.1');

    const set = run(['devices', 'config', '--fleet', 'scheduler.enabled', 'off']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('scheduler.enabled = false');

    const central = centralDoc();
    expect(central).toContain('defaults:');
    expect(central).toContain('schedulerEnabled: false');
    expect(deviceDoc('mac-mini')).not.toContain('schedulerEnabled');

    const self = JSON.parse(run(['devices', 'config', 'mac-mini', 'scheduler.enabled', '--json']).stdout);
    expect(self).toEqual({ device: 'mac-mini', key: 'scheduler.enabled', value: false, source: 'fleet' });
    const peer = run(['devices', 'config', 'zion', 'scheduler.enabled', '--json']);
    expect(peer.status).toBe(1);
    expect(peer.stderr).toContain('machine-local');
  });

  it('a device value wins over the fleet default; unsetting falls back to it', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '2']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 4, source: 'device' });

    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--unset']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 2, source: 'fleet' });

    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '--unset']).status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout))
      .toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: null, source: 'default' });
  });

  it('bare --fleet prints the defaults layer; user-scope keys reject --fleet', () => {
    guardedHome();
    expect(run(['devices', 'config', '--fleet', 'agents.max-concurrent', '2']).status).toBe(0);

    const bare = run(['devices', 'config', '--fleet']);
    expect(bare.status).toBe(0);
    expect(bare.stdout).toContain('Fleet-wide config defaults');
    expect(bare.stdout).toContain('agents.max-concurrent');

    const json = JSON.parse(run(['devices', 'config', '--fleet', '--json']).stdout);
    expect(json.fleet).toBe(true);
    expect(json.config['agents.max-concurrent']).toEqual({ value: 2, source: 'fleet' });

    const userScope = run(['devices', 'config', '--fleet', 'interactive.host', 'zion']);
    expect(userScope.status).toBe(1);
    expect(userScope.stderr).toContain('user-scope');
  });
});

describe('devices role', () => {
  it('a fleet-default worker role reaches a doc-less device in autoPoolWorkers', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    addDevice('yosemite-s0', 'muqsit@192.0.2.3');

    expect(run(['devices', 'config', '--fleet', 'role', 'worker']).status).toBe(0);

    const setRole = run(['devices', 'role', 'yosemite-s0', 'worker', '--json']);
    expect(setRole.status, setRole.stderr).toBe(0);
    const parsed = JSON.parse(setRole.stdout) as { autoPoolWorkers: string[] };
    expect(parsed.autoPoolWorkers).toContain('yosemite-s0');
    expect(parsed.autoPoolWorkers).toContain('mac-mini');

    const text = run(['devices', 'role', 'yosemite-s0', 'worker']);
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain('mac-mini');
  });
});

describe('devices describe (RUSH-3062 surface)', () => {
  it('describe: sets, reads back, unsets — and shares one store with `devices config`', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'describe', 'mac-mini', 'signing + notarize box']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('description');
    expect(deviceDoc('mac-mini')).toContain('description: signing + notarize box');

    const viaConfig = JSON.parse(run(['devices', 'config', 'mac-mini', 'description', '--json']).stdout);
    expect(viaConfig).toEqual({ device: 'mac-mini', key: 'description', value: 'signing + notarize box', source: 'device' });
    expect(JSON.parse(run(['devices', 'describe', 'mac-mini', '--json']).stdout)).toEqual(viaConfig);

    expect(run(['devices', 'describe', 'mac-mini', 'gpu', 'box', '-', 'cuda', '12.4']).status).toBe(0);
    expect(deviceDoc('mac-mini')).toContain('description: gpu box - cuda 12.4');

    const unset = run(['devices', 'describe', 'mac-mini', '--unset']);
    expect(unset.status, unset.stderr).toBe(0);
    expect(deviceDoc('mac-mini')).not.toContain('description:');

    const unknown = run(['devices', 'describe', 'zoin', 'nope']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown device 'zoin'/);

    const tooLong = run(['devices', 'describe', 'mac-mini', 'x'.repeat(81)]);
    expect(tooLong.status).toBe(1);
    expect(tooLong.stderr).toContain('at most 80 characters');
  });

  it('end-to-end: describe + ignore reach both the human table and --json', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'describe', 'mac-mini', 'signing box']).status).toBe(0);
    expect(run(['devices', 'ignore', 'old-laptop']).status).toBe(0);

    const json = run(['devices', 'list', '--json']);
    expect(json.status, json.stderr).toBe(0);
    const row = (JSON.parse(json.stdout) as Array<Record<string, any>>).find((r) => r.name === 'mac-mini');
    expect(row).toBeDefined();
    expect(row!.description).toBe('signing box');
    expect(row!.health.diskTotalBytes).toBeGreaterThan(0);
    expect(row!.health.diskFreeBytes).toBeGreaterThan(0);
    expect(row!.health.diskUsedPercent).toBeGreaterThanOrEqual(0);
    expect(row!.health.memTotalBytes).toBeGreaterThan(0);
    expect(row!.interactive).toBe(false);
    expect(row!.autoPool).toBeDefined();

    const list = run(['devices', 'list'], { COLUMNS: '200' });
    expect(list.status, list.stderr).toBe(0);
    const plain = list.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toMatch(/device\s+platform\s+spec\s+load\s+mem\s+disk\s+headroom/);
    expect(plain).toContain('signing box');
    expect(plain).toContain('disk free');
    expect(plain).toContain("1 ignored node not listed — 'agents devices ignored'");
    expect(plain).toMatch(/\d+c \d+(\.\d+)?[KMGTP] \d+(\.\d+)?[KMGTP]/);
  });
});
