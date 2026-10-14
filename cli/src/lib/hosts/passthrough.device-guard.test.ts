import { describe, it, expect, afterAll } from 'vitest';
import type { Command } from 'commander';
import { buildFullCommandTree } from '../../cli/command-registry.js';
import { maybeRunOnHost } from './passthrough.js';
import { commandOwnsDeviceFlag, setArgvCommandTree } from './routing-flag.js';
import type { DeviceProfile } from '../devices/registry.js';

function commandsDeclaringDevice(root: Command): string[][] {
  const found: string[][] = [];
  const walk = (cmd: Command, path: string[]) => {
    for (const sub of cmd.commands) {
      const subPath = [...path, sub.name()];
      if (sub.options.some((o) => o.long === '--device')) found.push(subPath);
      walk(sub, subPath);
    }
  };
  walk(root, []);
  return found;
}

async function rejectionFor(path: string[]): Promise<string | undefined> {
  const errors: string[] = [];
  const { error, log } = console;
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  console.log = () => {};
  try {
    await maybeRunOnHost(path[0], [...path, '--device', 'all'], {
      loadDevices: async () => ({}),
      runner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
    });
  } finally {
    console.error = error;
    console.log = log;
    process.exitCode = 0;
  }
  return errors.find((e) => e.includes('does not support --device'));
}

describe('every command that declares --device gets past the fleet router (PHNX-4387)', async () => {
  const tree = await buildFullCommandTree();
  setArgvCommandTree(tree);
  afterAll(() => setArgvCommandTree(undefined));
  const paths = commandsDeclaringDevice(tree);

  it('finds the commands this guard exists for', () => {
    const names = paths.map((p) => p.join(' '));
    expect(names).toEqual(expect.arrayContaining(['fork', 'cloud run', 'projects status', 'projects pull', 'events logs', 'daemon index backfill tools']));
  });

  it.each([['fork', 'abc'], ['cloud', 'run'], ['projects', 'status'], ['projects', 'pull']])('agents %s %s --device is left to the command', async (...path) => {
    expect(await maybeRunOnHost(path[0], [...path, '--device', 'yosemite-m5'])).toBe(false);
  });

  it.each([
    [['routines', 'add', 'nightly', '--device', 'mac', '--devices', 'a,b']],
    [['repos', 'status', '--device', 'mac']],
    [['view', '--device', 'mac']],
  ])('%j keeps the router --device: a leaf --devices or the addHostOption --device is not ownership', (args) => {
    expect(commandOwnsDeviceFlag(args)).toBe(false);
  });

  it.each([
    [['routines', 'add', 'nightly', '--device', 'all', '--devices', 'a,b']],
    [['routines', 'add', 'nightly', '--devices', 'all']],
    [['repos', 'status', '--devices', 'all']],
  ])('%j is still forwarded to every device', async (args) => {
    const peer: DeviceProfile = {
      name: 'peer-box',
      platform: 'linux',
      shell: 'posix',
      address: { via: 'tailscale', dnsName: 'peer-box.tail.ts.net' },
      auth: { method: 'key' },
      tailscale: { online: true, direct: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const sent: string[][] = [];
    const { log } = console;
    console.log = () => {};
    try {
      const routed = await maybeRunOnHost(args[0], args, {
        self: 'this-box',
        loadDevices: async () => ({ 'peer-box': peer }),
        runner: (_d, cmd) => { sent.push(cmd); return { code: 0, stdout: '{}', stderr: '' }; },
        localRunner: () => ({ code: 0, stdout: '{}', stderr: '' }),
      });
      expect(routed).toBe(true);
    } finally {
      console.log = log;
      process.exitCode = 0;
    }
    expect(sent.map((c) => c.slice(0, 3).join(' '))).toEqual([`agents ${args[0]} ${args[1]}`]);
  });

  it.each(paths.map((p) => [p.join(' '), p]))('agents %s --device is not rejected', async (_name, path) => {
    expect(await rejectionFor(path as string[])).toBeUndefined();
  });
});
