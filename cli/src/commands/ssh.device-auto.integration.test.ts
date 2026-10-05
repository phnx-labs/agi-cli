import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('agents ssh auto (RUSH-2185)', () => {
  // Real CLI + temp HOME proves shared auto placement and rejects a local self-pick.
  let home: string;
  const machineId = 'ssh-auto-test-box';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-device-auto-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runSshAuto(): { status: number; out: string } {
    try {
      const stdout = execFileSync(
        'bun',
        [path.resolve(process.cwd(), 'src/index.ts'), 'ssh', 'auto'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: home,
            AGENTS_SYNC_MACHINE_ID: machineId,
            AGENTS_NO_NUDGE: '1',
            FORCE_COLOR: '0',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).toString('utf-8');
      return { status: 0, out: stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return { status: err.status ?? 1, out: (err.stdout?.toString('utf-8') ?? '') + (err.stderr?.toString('utf-8') ?? '') };
    }
  }

  it('resolves `auto` (not "Unknown device") and refuses a self-pick with a clear message', () => {
    const { status, out } = runSshAuto();

    expect(out).not.toContain(`Unknown device 'auto'`);
    expect(status).not.toBe(0);
    expect(out).toContain(
      `'auto' picked this machine — 'agents ssh' connects to a remote device. Pass a device name; see 'agents devices list'.`,
    );
  });
});
