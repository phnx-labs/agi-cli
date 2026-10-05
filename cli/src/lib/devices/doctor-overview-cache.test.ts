import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readDoctorOverviewCache,
  writeDoctorOverviewCache,
  invalidateDoctorOverviewCache,
  enterDoctorOverviewGate,
  DOCTOR_OVERVIEW_FRESH_MS,
} from './doctor-overview-cache.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-overview-cache-'));
}

const LOCK = '.doctor-overview.lock-target.lock'; // proper-lockfile's lock dir

describe('doctor-overview-cache: read/write roundtrip', () => {
  it('writes then reads back the payload with the given fetchedAt', () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ clis: { claude: { installed: true } } }, { dir, now: () => 1000 });
    const got = readDoctorOverviewCache({ dir });
    expect(got).not.toBeNull();
    expect(got!.fetchedAt).toBe(1000);
    expect(got!.payload).toEqual({ clis: { claude: { installed: true } } });
  });

  it('returns null for a missing or corrupt cache file', () => {
    const dir = tmpDir();
    expect(readDoctorOverviewCache({ dir })).toBeNull();
    fs.writeFileSync(path.join(dir, '.doctor-overview.json'), '{ not json');
    expect(readDoctorOverviewCache({ dir })).toBeNull();
  });

  it('invalidates only the overview snapshot, leaving the singleflight lock alone', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ stale: true }, { dir, now: () => 1000 });
    const gate = await enterDoctorOverviewGate({ forceRefresh: true }, { dir });
    expect(gate.release).toBeTypeOf('function');

    invalidateDoctorOverviewCache({ dir });

    expect(readDoctorOverviewCache({ dir })).toBeNull();
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(true);
    gate.release!();
  });
});

describe('doctor-overview-cache: gate fast path (fresh snapshot)', () => {
  it('serves a fresh snapshot with no compute token and no lock', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'world' }, { dir, now: () => 10_000 });
    const gate = await enterDoctorOverviewGate({}, { dir, now: () => 30_000 }); // 20s later — fresh
    expect(gate.cached).not.toBeNull();
    expect(gate.release).toBeUndefined();
    expect(JSON.parse(gate.cached!)).toEqual({ hello: 'world' });
    // A served fast-path read must not have taken the singleflight lock.
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });

  it('does NOT serve a snapshot older than the freshness window', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'stale' }, { dir, now: () => 0 });
    const gate = await enterDoctorOverviewGate({}, { dir, now: () => DOCTOR_OVERVIEW_FRESH_MS + 1 });
    expect(gate.cached).toBeNull();
    expect(gate.release).toBeTypeOf('function');
    gate.release!();
  });

  it('forceRefresh ignores a fresh snapshot and takes the compute token', async () => {
    const dir = tmpDir();
    writeDoctorOverviewCache({ hello: 'fresh' }, { dir, now: () => 1000 });
    const gate = await enterDoctorOverviewGate({ forceRefresh: true }, { dir, now: () => 1001 });
    expect(gate.cached).toBeNull();
    expect(gate.release).toBeTypeOf('function');
    gate.release!();
  });
});

describe('doctor-overview-cache: singleflight coalescing (the bug fix)', () => {
  it('hands exactly one compute token to concurrent callers; the second serves the winner', async () => {
    const dir = tmpDir();

    // Caller A wins the lock and holds it (no fresh cache yet).
    const a = await enterDoctorOverviewGate({}, { dir });
    expect(a.cached).toBeNull();
    expect(a.release).toBeTypeOf('function');

    // Caller B starts while A holds the lock, so proper-lockfile blocks B until A releases. B must
    // not get its own compute token; once A writes the snapshot and releases, B acquires,
    // double-checks, and serves A's fresh result.
    const bPromise = enterDoctorOverviewGate({}, { dir });
    writeDoctorOverviewCache({ computedBy: 'A' }, { dir });
    a.release!();

    const b = await bPromise;
    expect(b.release).toBeUndefined(); // coalesced onto A's compute — a result, not a token
    expect(b.cached).not.toBeNull();
    expect(JSON.parse(b.cached!)).toEqual({ computedBy: 'A' });
    // The lock is released after both callers are done.
    expect(fs.existsSync(path.join(dir, LOCK))).toBe(false);
  });
});
