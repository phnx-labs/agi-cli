/** RUSH-2682: `scanInProgressByLivePid` lets a cold-miss repair wait for a concurrent scan instead
 * of returning the pre-scan snapshot. It reports a scan only when a LIVE process holds the claim
 * within its TTL; a dead-PID or expired claim is not a scan. */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-scan-claim-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const { tryClaimScan, releaseScan, scanInProgressByLivePid, closeDB } = await import('./db.js');

const DEAD_PID = 2 ** 31 - 1; // out of range / not running — process.kill throws

afterEach(() => {
  // Leave the claim table clean between cases whoever holds it.
  releaseScan(process.pid);
  releaseScan(DEAD_PID);
});

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

describe('scanInProgressByLivePid (RUSH-2682)', () => {
  it('is false when no scan is claimed', () => {
    expect(scanInProgressByLivePid()).toBe(false);
  });

  it('is true while THIS live process holds the claim, false after release', () => {
    expect(tryClaimScan(process.pid)).toBe(true);
    expect(scanInProgressByLivePid()).toBe(true);
    releaseScan(process.pid);
    expect(scanInProgressByLivePid()).toBe(false);
  });

  it('is false for a claim held by a dead PID — not an actually-running scan', () => {
    // No live claim exists, so tryClaimScan writes the claim for the dead pid.
    expect(tryClaimScan(DEAD_PID)).toBe(true);
    expect(scanInProgressByLivePid()).toBe(false);
  });
});
