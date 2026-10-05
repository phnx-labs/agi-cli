import { describe, expect, it, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  classifyRolloutVerification,
  isRolloutSuccess,
  parseRolloutVerifyOutput,
  resolveRolloutTarget,
  rolloutVerifyCommand,
  verifyFleetRollout,
} from './rollout-verify.js';
import type { FleetRunResult, FleetTarget } from './fleet.js';
import type { DeviceProfile } from './registry.js';

const TARGET = '1.22.35';
const DEV_VERSION = '0.0.0-dev.deadbee';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-verify-'));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function makeInstalls(which: 'dev' | 'global'): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${which}-`));
  const devEntry = path.join(dir, 'agents-cli-dev', 'dist', 'index.js');
  const globalEntry = path.join(dir, 'lib', 'node_modules', '@phnx-labs', 'agents-cli', 'dist', 'index.js');
  for (const [entry, version] of [[devEntry, DEV_VERSION], [globalEntry, TARGET]] as const) {
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  }
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(which === 'dev' ? devEntry : globalEntry, path.join(binDir, 'agents'));
  return binDir;
}

function runProbe(binDir: string): string {
  const cmd = rolloutVerifyCommand();
  const res = spawnSync(cmd.join(' '), {
    shell: true,
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
  });
  return res.stdout ?? '';
}

describe('the real probe resolves the copy that actually runs', () => {
  it.skipIf(process.platform === 'win32')(
    'a dev install on PATH is reported dev-shadowed and NOT upgraded, even though the global is on target',
    () => {
      const probe = parseRolloutVerifyOutput(runProbe(makeInstalls('dev')));
      expect(probe.reportedVersion).toBe(DEV_VERSION);
      expect(probe.resolvedPath).toContain(path.join('agents-cli-dev', 'dist', 'index.js'));

      const verification = classifyRolloutVerification(probe, TARGET);
      expect(verification.verdict).toBe('dev-shadowed');
      expect(isRolloutSuccess(verification.verdict)).toBe(false);
      expect(verification.detail).toContain('NOT upgraded');
      expect(verification.detail).toContain('agents-cli-dev');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'the npm global on PATH is reported on-target',
    () => {
      const probe = parseRolloutVerifyOutput(runProbe(makeInstalls('global')));
      expect(probe.reportedVersion).toBe(TARGET);
      expect(probe.resolvedPath).toContain(path.join('@phnx-labs', 'agents-cli', 'dist', 'index.js'));

      const verification = classifyRolloutVerification(probe, TARGET);
      expect(verification.verdict).toBe('on-target');
      expect(isRolloutSuccess(verification.verdict)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')('ignores unlabelled shell banner lines', () => {
    const probe = parseRolloutVerifyOutput(
      `Welcome to Ubuntu 24.04\n1.0.0\n${runProbe(makeInstalls('global'))}Last login: never\n`,
    );
    expect(probe.reportedVersion).toBe(TARGET);
  });
});

describe('classifyRolloutVerification', () => {
  it('a differing released version is not-upgraded, not ok', () => {
    const v = classifyRolloutVerification({ resolvedPath: '/usr/bin/agents', reportedVersion: '1.20.4' }, TARGET);
    expect(v.verdict).toBe('not-upgraded');
    expect(isRolloutSuccess(v.verdict)).toBe(false);
    expect(v.detail).toContain('target 1.22.35');
  });

  it('an unanswerable probe is unverified, never ok', () => {
    const v = classifyRolloutVerification({}, TARGET);
    expect(v.verdict).toBe('unverified');
    expect(isRolloutSuccess(v.verdict)).toBe(false);
  });

  it('a resolved path with no version is unverified and names the path', () => {
    const v = classifyRolloutVerification({ resolvedPath: '/opt/agents' }, TARGET);
    expect(v.verdict).toBe('unverified');
    expect(v.detail).toContain('/opt/agents');
  });

  it('with no known target nothing is on-target', () => {
    expect(classifyRolloutVerification({ reportedVersion: TARGET }, undefined).verdict).toBe('unverified');
  });
});

describe('resolveRolloutTarget', () => {
  it('an explicit version wins', () => {
    expect(resolveRolloutTarget('1.22.35', [{ reportedVersion: '9.9.9' }])).toBe('1.22.35');
  });

  it('a dist-tag falls back to the highest released version observed', () => {
    expect(resolveRolloutTarget('latest', [
      { reportedVersion: '1.22.30' },
      { reportedVersion: '1.22.35' },
      { reportedVersion: DEV_VERSION },
    ])).toBe('1.22.35');
  });

  it('dev stamps are never elected as the target', () => {
    expect(resolveRolloutTarget(undefined, [{ reportedVersion: DEV_VERSION }])).toBeUndefined();
  });
});

describe('verifyFleetRollout', () => {
  const device = (name: string): DeviceProfile => ({ name, host: `${name}.example` } as DeviceProfile);
  const targets: FleetTarget[] = [
    { device: device('devbox') },
    { device: device('cleanbox') },
    { device: device('brokenbox') },
    { device: device('offlinebox'), skip: 'offline' },
  ];
  const results: FleetRunResult[] = [
    { name: 'devbox', status: 'ok', code: 0 },
    { name: 'cleanbox', status: 'ok', code: 0 },
    { name: 'brokenbox', status: 'failed', code: 1 },
    { name: 'offlinebox', status: 'skipped', code: null, reason: 'offline' },
  ];
  const stdoutFor: Record<string, string> = {
    devbox: `agents-rollout-path=/home/dev/.local/agents-cli-dev/dist/index.js\nagents-rollout-version=${DEV_VERSION}\n`,
    cleanbox: `agents-rollout-path=/usr/lib/node_modules/@phnx-labs/agents-cli/dist/index.js\nagents-rollout-version=${TARGET}\n`,
  };

  const verifications = verifyFleetRollout(targets, results, TARGET, {
    self: 'cleanbox',
    runner: (d) => ({ code: 0, stdout: stdoutFor[d.name] ?? '', stderr: '' }),
    localRunner: () => ({ code: 0, stdout: stdoutFor.cleanbox, stderr: '' }),
  });

  it('flags the dev-shadowed box as NOT upgraded while the clean box passes', () => {
    expect(verifications.get('devbox')?.verdict).toBe('dev-shadowed');
    expect(verifications.get('devbox')?.resolvedPath).toBe('/home/dev/.local/agents-cli-dev/dist/index.js');
    expect(verifications.get('cleanbox')?.verdict).toBe('on-target');
  });

  it('does not re-probe a failed or skipped box — one fault, one row', () => {
    expect(verifications.has('brokenbox')).toBe(false);
    expect(verifications.has('offlinebox')).toBe(false);
  });

  it('a throwing probe is unverified, never silently ok', () => {
    const out = verifyFleetRollout([targets[0]], [results[0]], TARGET, {
      runner: () => { throw new Error('ssh exploded'); },
    });
    expect(out.get('devbox')?.verdict).toBe('unverified');
  });
});
