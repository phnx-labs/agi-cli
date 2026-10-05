import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readRepoBehindMarkers,
  shouldSkipDetachedSync,
  markDetachedSyncComplete,
  lastSyncStampPath,
  lockFilePath,
  SYNC_LOCK_TTL_MS,
  type FetchStatusMarker,
} from './auto-pull.js';


let fetchDir: string;

beforeEach(() => {
  fetchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-pull-test-'));
});

afterEach(() => {
  fs.rmSync(fetchDir, { recursive: true, force: true });
});

function writeMarker(alias: string, fields: Partial<FetchStatusMarker> = {}): string {
  const file = path.join(fetchDir, `${alias}.status.json`);
  const marker: FetchStatusMarker = {
    alias,
    dir: `/fake/${alias}`,
    ahead: 0,
    behind: 0,
    branch: 'origin/main',
    fetchedAt: Date.now(),
    ...fields,
  };
  fs.writeFileSync(file, JSON.stringify(marker));
  return file;
}

describe('readRepoBehindMarkers', () => {
  it('returns empty array when fetch dir has no .status.json files', () => {
    expect(readRepoBehindMarkers(fetchDir)).toEqual([]);
  });

  it('returns empty array when the fetch dir does not exist', () => {
    const missing = path.join(fetchDir, 'nonexistent');
    expect(readRepoBehindMarkers(missing)).toEqual([]);
  });

  it('returns markers where behind > 0', () => {
    writeMarker('user', { behind: 3, branch: 'origin/main' });
    const results = readRepoBehindMarkers(fetchDir);
    expect(results).toHaveLength(1);
    expect(results[0].alias).toBe('user');
    expect(results[0].behind).toBe(3);
    expect(results[0].branch).toBe('origin/main');
  });

  it('skips markers where behind === 0', () => {
    writeMarker('user', { behind: 0 });
    expect(readRepoBehindMarkers(fetchDir)).toEqual([]);
  });

  it('returns multiple behind repos', () => {
    writeMarker('user', { behind: 2 });
    writeMarker('system', { behind: 5 });
    const results = readRepoBehindMarkers(fetchDir);
    expect(results).toHaveLength(2);
    const aliases = results.map((m) => m.alias).sort();
    expect(aliases).toEqual(['system', 'user']);
  });

  it('does NOT delete markers after reading (markers persist for repeated doctor runs)', () => {
    const file = writeMarker('user', { behind: 1 });
    readRepoBehindMarkers(fetchDir);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('ignores files that are not .status.json (e.g. lock files)', () => {
    fs.writeFileSync(path.join(fetchDir, 'user.lock'), '12345');
    fs.writeFileSync(path.join(fetchDir, 'user.json'), '{"behind":9}');
    expect(readRepoBehindMarkers(fetchDir)).toEqual([]);
  });

  it('skips malformed JSON without throwing', () => {
    fs.writeFileSync(path.join(fetchDir, 'bad.status.json'), 'not-json');
    expect(() => readRepoBehindMarkers(fetchDir)).not.toThrow();
    expect(readRepoBehindMarkers(fetchDir)).toEqual([]);
  });

  it('does not emit anything to stderr (repo-behind notices must not pollute command output)', () => {
    writeMarker('user', { behind: 6, branch: 'origin/main' });
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
      captured.push(String(chunk));
      return stderrWrite(chunk, ...(args as [BufferEncoding, ((err?: Error | null) => void)?]));
    };
    try {
      readRepoBehindMarkers(fetchDir);
    } finally {
      process.stderr.write = stderrWrite;
    }
    expect(captured).toEqual([]);
  });
});

describe('shouldSkipDetachedSync / markDetachedSyncComplete (RUSH-2324)', () => {
  const NOW = 1_700_000_000_000;

  it('returns false when the fetch dir does not exist', () => {
    const missing = path.join(fetchDir, 'no-such-dir');
    expect(shouldSkipDetachedSync(missing, NOW)).toBe(false);
  });

  it('returns false on an empty fetch dir (no stamp, no locks)', () => {
    expect(shouldSkipDetachedSync(fetchDir, NOW)).toBe(false);
  });

  it('returns true after markDetachedSyncComplete within the TTL window', () => {
    markDetachedSyncComplete(fetchDir);
    expect(fs.existsSync(lastSyncStampPath(fetchDir))).toBe(true);
    const stampedAt = fs.statSync(lastSyncStampPath(fetchDir)).mtimeMs;
    expect(shouldSkipDetachedSync(fetchDir, stampedAt + 1_000)).toBe(true);
    expect(shouldSkipDetachedSync(fetchDir, stampedAt + SYNC_LOCK_TTL_MS - 1)).toBe(true);
  });

  it('returns false once the last-sync stamp is past the TTL', () => {
    markDetachedSyncComplete(fetchDir);
    const stampedAt = fs.statSync(lastSyncStampPath(fetchDir)).mtimeMs;
    expect(shouldSkipDetachedSync(fetchDir, stampedAt + SYNC_LOCK_TTL_MS)).toBe(false);
    expect(shouldSkipDetachedSync(fetchDir, stampedAt + SYNC_LOCK_TTL_MS + 1)).toBe(false);
  });

  it('returns true when every existing *.lock is within the TTL (mid-flight worker)', () => {
    fs.writeFileSync(lockFilePath('user', fetchDir), '123');
    fs.writeFileSync(lockFilePath('system', fetchDir), '456');
    const lockUser = lockFilePath('user', fetchDir);
    const lockSystem = lockFilePath('system', fetchDir);
    const sec = NOW / 1000;
    fs.utimesSync(lockUser, sec, sec);
    fs.utimesSync(lockSystem, sec, sec);
    expect(shouldSkipDetachedSync(fetchDir, NOW + 1_000)).toBe(true);
  });

  it('returns false when any lock is stale (even if another is fresh)', () => {
    const lockUser = lockFilePath('user', fetchDir);
    const lockSystem = lockFilePath('system', fetchDir);
    fs.writeFileSync(lockUser, '123');
    fs.writeFileSync(lockSystem, '456');
    const freshSec = NOW / 1000;
    const staleSec = (NOW - SYNC_LOCK_TTL_MS - 1_000) / 1000;
    fs.utimesSync(lockUser, freshSec, freshSec);
    fs.utimesSync(lockSystem, staleSec, staleSec);
    expect(shouldSkipDetachedSync(fetchDir, NOW)).toBe(false);
  });

  it('prefers a fresh last-sync stamp over a missing/stale lock set', () => {
    markDetachedSyncComplete(fetchDir);
    const stampedAt = fs.statSync(lastSyncStampPath(fetchDir)).mtimeMs;
    expect(shouldSkipDetachedSync(fetchDir, stampedAt + 500)).toBe(true);
  });

  it('markDetachedSyncComplete creates the fetch dir when missing', () => {
    const nested = path.join(fetchDir, 'nested-fetch');
    markDetachedSyncComplete(nested);
    expect(fs.existsSync(lastSyncStampPath(nested))).toBe(true);
  });
});
