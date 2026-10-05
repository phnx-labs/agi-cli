import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-wait-scan-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.AGENTS_SYNC_MACHINE_ID = 'this-box';

const { tryClaimScan, releaseScan, closeDB } = await import('./db.js');
const { waitForScanToSettle } = await import('./discover.js');

afterEach(() => releaseScan(process.pid));

afterAll(() => {
  closeDB();
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  delete process.env.AGENTS_SYNC_MACHINE_ID;
});

describe('waitForScanToSettle (RUSH-2682)', () => {
  it('returns immediately (true) when no scan is in progress', async () => {
    const start = Date.now();
    expect(await waitForScanToSettle(1_000, 20)).toBe(true);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('resolves true once the in-flight scan releases the claim', async () => {
    expect(tryClaimScan(process.pid)).toBe(true);
    setTimeout(() => releaseScan(process.pid), 60);
    const start = Date.now();
    expect(await waitForScanToSettle(1_000, 20)).toBe(true);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('gives up (false) when the claim outlives the bound', async () => {
    expect(tryClaimScan(process.pid)).toBe(true);
    const start = Date.now();
    expect(await waitForScanToSettle(150, 20)).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
    releaseScan(process.pid);
  });
});
