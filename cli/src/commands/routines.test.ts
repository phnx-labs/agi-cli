import { it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import {
  describeRoutines,
  makeHome,
  run,
  readRoutineYaml,
  baseJob,
  registry,
  readDeviceRoutines,
  writeDeviceRoutines,
} from './routines.test-fixture.js';

// Residual slice of the routines.*.test.ts suite (RUSH-2819): device pin/activation lifecycle
// (`routines devices --set/--clear`) and `--device` help/routing. Subprocess-heavy tests live in
// the add/list/run slices. Fixtures: routines.test-fixture.ts.

describeRoutines('routines devices --set persists', () => {
  it('writes activation to the target device manifest without changing definition metadata', () => {
    const home = makeHome({ jobs: [baseJob], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'yosemite-s0'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status, res.stderr + res.stdout).toBe(0);

      const doc = readRoutineYaml(home, 'test-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toBeUndefined();
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set on .yaml-only routine', () => {
  it('leaves the .yaml definition untouched and list --json reports enabled devices+runsHere', () => {
    const home = makeHome({ registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const yamlPath = path.join(home, '.agents', 'routines', 'yaml-only.yaml');
      fs.writeFileSync(
        yamlPath,
        yaml.stringify({ name: 'yaml-only', schedule: '0 3 * * *', agent: 'claude', prompt: 'noop' }),
      );

      const setRes = run(home, ['devices', 'yaml-only', '--set', 'yosemite-s0'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(setRes.status).toBe(0);

      expect(fs.existsSync(path.join(home, '.agents', 'routines', 'yaml-only.yml'))).toBe(false);
      const doc = yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
      expect(doc.devices).toBeUndefined();

      const listRes = run(home, ['list', '--json'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(listRes.status).toBe(0);
      const parsed = JSON.parse(listRes.stdout.trim());
      const entry = parsed.find((j: Record<string, unknown>) => j.name === 'yaml-only');
      expect(entry).toBeDefined();
      expect(entry.devices).toEqual(['yosemite-s0']);
      expect(entry.runsHere).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set normalizes mixed case and FQDN duplicates', () => {
  it('persists one normalized entry per device', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'Yosemite-S0,yosemite-s0.tailnet.ts.net'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const doc = readRoutineYaml(home, 'test-job');
      expect(doc).not.toBeNull();
      expect(doc!.devices).toEqual(['yosemite-s0']);
      // First materialization of an empty manifest seeds every currently-enabled
      // routine so nothing is silently disabled.
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual(['test-job']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --clear removes activation', () => {
  it('removes the routine from this device manifest without rewriting YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry: { 'yosemite-s0': registry['yosemite-s0'] } });
    try {
      writeDeviceRoutines(home, 'yosemite-s0', ['test-job']);
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--clear'], { AGENTS_SYNC_MACHINE_ID: 'yosemite-s0' });
      expect(res.status).toBe(0);

      const raw = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(raw).toBe(before);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set unknown is nonzero/no mutation', () => {
  it('rejects unknown device names and does not mutate the YAML', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry, deviceRoutines: { 'yosemite-s0': ['test-job'] } });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');

      const res = run(home, ['devices', 'test-job', '--set', 'nonexistent-box']);
      expect(res.status).not.toBe(0);

      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// #2118: --set fans out pause/resume to every registered device. An offline
// peer that is NOT in the new set must be a warning, not a hard fail — the
// pin on the reachable target already succeeded.
describeRoutines('routines devices --set skips unreachable non-targets (#2118)', () => {
  it('enables on the local target and warns about an offline peer that cannot be paused', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      // No dnsName/ip: resolveHost fails immediately (no SSH hang) the same way
      // a sleeping Tailscale host does for applyDevices' remote pause.
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [baseJob],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'yosemite-s0'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status, res.stderr + res.stdout).toBe(0);
      expect(res.stdout + res.stderr).toMatch(/Skipped pause of 'test-job' on offline-box/i);
      expect(res.stdout + res.stderr).toMatch(/enabled on: yosemite-s0/i);
      expect(res.stdout + res.stderr).toMatch(/offline device.*skipped/i);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits non-zero when a selected target device cannot be reached', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [baseJob],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--set', 'offline-box'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr + res.stdout).toMatch(/Could not enable 'test-job' on: offline-box/i);
      // Local pause (removing the routine from this device) still applied before
      // the remote target failed — pin must not claim full success.
      expect(readDeviceRoutines(home, 'yosemite-s0')).not.toContain('test-job');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --clear skips unreachable peers (#2118)', () => {
  it('clears the local pin and reports skipped offline peers instead of aborting', () => {
    const offlinePeer = {
      name: 'offline-box',
      platform: 'macos',
      address: { via: 'manual' },
      auth: { method: 'key' },
    };
    const home = makeHome({
      jobs: [{ ...baseJob, devices: ['yosemite-s0'] }],
      registry: {
        'yosemite-s0': { name: 'yosemite-s0', platform: 'linux' },
        'offline-box': offlinePeer,
      },
      deviceRoutines: { 'yosemite-s0': ['test-job'] },
    });
    try {
      const res = run(home, ['devices', 'test-job', '--clear'], {
        AGENTS_SYNC_MACHINE_ID: 'yosemite-s0',
      });
      expect(res.status, res.stderr + res.stdout).toBe(0);
      expect(res.stdout + res.stderr).toMatch(/Skipped pause of 'test-job' on offline-box/i);
      expect(res.stdout + res.stderr).toMatch(/disabled on every registered device/i);
      expect(readDeviceRoutines(home, 'yosemite-s0')).toEqual([]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices no-flags nonTTY names --set/--clear', () => {
  it('non-interactive devices without flags exits nonzero naming --set and --clear', () => {
    const home = makeHome({ jobs: [baseJob], registry });
    try {
      const res = run(home, ['devices', 'test-job']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--set/);
      expect(output).toMatch(/--clear/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set and --clear are mutually exclusive', () => {
  it('exits nonzero without mutation when both are given', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', 'mac-mini', '--clear']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describeRoutines('routines devices --set empty/whitespace fails closed', () => {
  it('rejects --set "" without mutating the routine', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', '']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/--devices requires at least one non-empty device name/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects --set "" combined with --clear as mutually exclusive', () => {
    const job = { ...baseJob, devices: ['yosemite-s0'] };
    const home = makeHome({ jobs: [job], registry });
    try {
      const before = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      const res = run(home, ['devices', 'test-job', '--set', '', '--clear']);
      expect(res.status).not.toBe(0);
      const output = res.stdout + res.stderr;
      expect(output).toMatch(/mutually exclusive/);
      const after = fs.readFileSync(path.join(home, '.agents', 'routines', 'test-job.yml'), 'utf-8');
      expect(after).toBe(before);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

/** Parse direct subcommand names from `routines --help`. */
function directSubcommandNames(home: string): string[] {
  const res = run(home, ['--help']);
  expect(res.status).toBe(0);
  const output = res.stdout + res.stderr;
  const commandsMatch = output.match(/Commands:\n([\s\S]*?)(?=\n(?:Options|Notes|Examples|Arguments):)/);
  if (!commandsMatch) return [];
  return commandsMatch[1]
    .split('\n')
    .map((line) => line.match(/^  ([a-z][a-z0-9-]*)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

describeRoutines('routines subcommand --help documents --device once each', () => {
  it('derives every direct command from routines --help and checks local help', () => {
    const home = makeHome();
    try {
      const names = directSubcommandNames(home);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const res = run(home, [name, '--help']);
        expect(res.status).toBe(0);
        const output = res.stdout + res.stderr;
        const deviceMatches = output.match(/^\s+-D, --device /gm) ?? [];
        expect(deviceMatches.length).toBe(1);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    // ~15 subcommands, each a cold `node --import tsx` boot; Windows subprocess
    // spawn is slow enough to tip the aggregate over the 30s global timeout.
  }, 90_000);
});
