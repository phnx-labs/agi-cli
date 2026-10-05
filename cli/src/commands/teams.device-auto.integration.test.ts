import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe.skipIf(process.platform === 'win32')('agents teams add --device auto (RUSH-2185)', () => {


  let home: string;
  const machineId = 'device-auto-test-box';

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'teams-device-auto-'));
    const systemDir = path.join(home, '.agents', '.system');
    fs.mkdirSync(systemDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: systemDir, stdio: 'ignore' });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runAdd(team: string): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(
      'bun',
      [path.resolve(process.cwd(), 'src/index.ts'), 'teams', 'add', team, 'claude', 'task', '--device', 'auto'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: home,
          AGENTS_SYNC_MACHINE_ID: machineId,
          AGENTS_NO_NUDGE: '1',
          FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it('resolves `auto` instead of rejecting "Unknown device" / "Couldn\'t resolve --device"', () => {
    const { status, stdout, stderr } = runAdd('device-auto-add-test');
    const out = stdout + stderr;

    expect(status).not.toBe(0);
    expect(out).not.toContain(`Unknown device 'auto'`);
    expect(out).not.toContain(`Couldn't resolve --device "auto"`);
    expect(out).not.toContain(`Unknown teammate 'claude'`);
    expect(out).not.toContain('device=auto → local');
    expect(out).toContain('agents: no healthy device can run claude');
  });
});
