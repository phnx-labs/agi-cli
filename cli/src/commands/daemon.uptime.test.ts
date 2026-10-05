/** `agents daemon status` process-uptime probe (PHNX-3289). Regression: `uptimeSeconds` shelled `ps
 * -o etimes=`, a GNU keyword macOS/BSD `ps` rejects, so status errored on macOS. Runs the real
 * `ps` on a live pid and asserts a plausible elapsed time on every POSIX platform. */
import { describe, it, expect } from 'vitest';
import { uptimeSeconds } from './daemon.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('uptimeSeconds', () => {
  it('returns a non-negative elapsed time for a live pid via portable `ps -o etime=`', () => {
    const secs = uptimeSeconds(process.pid);
    expect(secs).not.toBeNull();
    expect(typeof secs).toBe('number');
    expect(secs as number).toBeGreaterThanOrEqual(0);
    expect(secs as number).toBeLessThan(365 * 24 * 3600);
  });

  it('returns null for a pid that does not exist', () => {
    expect(uptimeSeconds(2_147_483_646)).toBeNull();
  });
});

describe('uptimeSeconds on Windows', () => {
  it.skipIf(process.platform !== 'win32')('returns null (ps is POSIX-only)', () => {
    expect(uptimeSeconds(process.pid)).toBeNull();
  });
});
