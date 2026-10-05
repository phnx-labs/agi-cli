import { describe, expect, it } from 'vitest';
import {
  guardedHome,
  run,
  centralDoc,
  deviceDoc,
  addDevice,
} from './device-config-test-harness.js';

describe('devices config', () => {
  it('sets, gets, and unsets device-scope keys in the per-device doc', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    const set = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']);
    expect(set.status, set.stderr).toBe(0);
    expect(set.stdout).toContain('agents.max-concurrent = 4');
    expect(run(['devices', 'config', 'mac-mini', 'scheduler.enabled', 'off']).status).toBe(0);

    const doc = deviceDoc('mac-mini');
    expect(doc).toContain('config:');
    expect(doc).toContain('maxAgents: 4');
    expect(doc).toContain('schedulerEnabled: false');
    expect(centralDoc()).not.toContain('maxAgents');

    const got = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']);
    expect(got.status).toBe(0);
    expect(JSON.parse(got.stdout)).toEqual({ device: 'mac-mini', key: 'agents.max-concurrent', value: 4, source: 'device' });

    const unset = run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--unset']);
    expect(unset.status).toBe(0);
    expect(JSON.parse(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '--json']).stdout).value).toBeNull();
    expect(deviceDoc('mac-mini')).not.toContain('maxAgents');
  });

  it('appends notes and accepts on/off/true/false booleans', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', 'mac-mini', 'notes', 'runs the releases']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'notes', 'do not', 'reboot']).status).toBe(0);
    const notes = JSON.parse(run(['devices', 'config', 'mac-mini', 'notes', '--json']).stdout);
    expect(notes.value).toEqual(['runs the releases', 'do not reboot']);

    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', 'false']).status).toBe(0);
    const flag = JSON.parse(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', '--json']).stdout);
    expect(flag.value).toBe(false);
    expect(run(['devices', 'config', 'mac-mini', 'auto-launch.enabled', 'true']).status).toBe(0);
  });

  it('prints the resolved config bare (non-TTY) and as JSON with per-key sources', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);

    const show = run(['devices', 'config', 'mac-mini']);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("Config for 'mac-mini'");
    expect(show.stdout).toContain('agents.max-concurrent');
    expect(show.stdout).toContain('auto-launch.enabled');

    const json = run(['devices', 'config', 'mac-mini', '--json']);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.device).toBe('mac-mini');
    expect(parsed.config['agents.max-concurrent']).toEqual({ value: 4, source: 'device' });
    expect(parsed.config['scheduler.enabled']).toEqual({ value: null, source: 'default' });
  });

  it('rejects bad values and unknown keys loudly', () => {
    guardedHome();
    addDevice('mac-mini', 'muqsit@192.0.2.2');

    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', 'four']).status).toBe(1);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '0']).status).toBe(1);
    const badBool = run(['devices', 'config', 'mac-mini', 'scheduler.enabled', 'maybe']);
    expect(badBool.status).toBe(1);
    expect(badBool.stderr).toContain('on/off');
    const unknown = run(['devices', 'config', 'mac-mini', 'nope.nope', '1']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown config key 'nope.nope'");
    expect(unknown.stderr).toContain('scheduler.enabled');
    expect(run(['devices', 'config', 'ghost', 'agents.max-concurrent', '2']).status).toBe(1);
  });

  it('stores ssh.* profile overrides in the device doc and resolves them into list --json', () => {
    guardedHome();
    addDevice('worker', 'muqsit@192.0.2.3');

    expect(run(['devices', 'config', 'worker', 'ssh.identity-file', '/keys/fleet worker']).status).toBe(0);
    expect(deviceDoc('worker')).toContain('sshIdentityFile: /keys/fleet worker');

    const listed = run(['devices', 'list', '--json']);
    expect(listed.status, listed.stderr).toBe(0);
    const worker = JSON.parse(listed.stdout).find((device: { name: string }) => device.name === 'worker');
    expect(worker.auth).toMatchObject({ method: 'key', identityFile: '/keys/fleet worker' });
    expect(worker.config).toMatchObject({ sshIdentityFile: '/keys/fleet worker' });
  });
});

describe('devices list surfaces the config', () => {
  it('marks the interactive host in the table and carries device-layer config in --json', () => {
    guardedHome();
    addDevice('zion');
    addDevice('mac-mini', 'muqsit@192.0.2.2');
    expect(run(['devices', 'config', 'zion', 'interactive.host', 'zion']).status).toBe(0);
    expect(run(['devices', 'config', 'mac-mini', 'agents.max-concurrent', '4']).status).toBe(0);

    const table = run(['devices', 'list', '--no-stats']);
    expect(table.status, table.stderr).toBe(0);
    expect(table.stdout).toContain('★ interactive');

    const json = run(['devices', 'list', '--json']);
    expect(json.status).toBe(0);
    const rows = JSON.parse(json.stdout) as Array<{ name: string; interactive: boolean; config?: Record<string, unknown> }>;
    const zion = rows.find((r) => r.name === 'zion');
    const macMini = rows.find((r) => r.name === 'mac-mini');
    expect(zion?.interactive).toBe(true);
    expect(macMini?.interactive).toBe(false);
    expect(macMini?.config).toMatchObject({ maxAgents: 4 });
  });
});
