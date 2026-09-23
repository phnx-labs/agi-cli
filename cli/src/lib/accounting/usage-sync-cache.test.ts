import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  exportClaudeUsageCacheRows,
  ingestPeerClaudeUsageRows,
  readClaudeUsageCache,
  type CachedUsageSnapshot,
} from './usage.js';

// Real files, no mocks: the export → ingest → read path is the cross-machine
// merge contract beneath the fleet-shared user-repo snapshot. A publisher's
// cache is exported, merged into a worker's cache newest-wins, and read back
// through the normal reader.

function row(capturedAt: string | null, usedPercent = 12): CachedUsageSnapshot {
  return {
    capturedAt,
    windows: [
      {
        key: 'five_hour' as CachedUsageSnapshot['windows'][number]['key'],
        label: 'Session (5h)',
        shortLabel: 'S',
        usedPercent,
        resetsAt: null,
        windowMinutes: 300,
      },
    ],
  };
}

function seed(cachePath: string, rows: Record<string, CachedUsageSnapshot>): void {
  fs.writeFileSync(cachePath, JSON.stringify(rows, null, 2), 'utf-8');
}

describe('usage-sync cache export/ingest (newest-wins)', () => {
  let dir = '';
  let src = '';
  let dst = '';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sync-'));
    src = path.join(dir, 'src-usage.json');
    dst = path.join(dir, 'dst-usage.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const KEY_A = 'claude:org=alpha';
  const KEY_B = 'claude:org=beta';

  it('exports only rows that carry a window', () => {
    seed(src, {
      [KEY_A]: row('2026-08-28T12:00:00.000Z'),
      [KEY_B]: { capturedAt: '2026-08-28T12:00:00.000Z', windows: [] }, // empty — nothing to teach
    });
    const rows = exportClaudeUsageCacheRows(src);
    expect(Object.keys(rows)).toEqual([KEY_A]);
  });

  it('ingests into an empty worker cache and reads back through the normal reader', async () => {
    const rows = { [KEY_A]: row('2026-08-28T12:00:00.000Z', 34) };
    const merged = await ingestPeerClaudeUsageRows(rows, dst);
    expect(merged).toBe(1);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:05:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(34);
    // A synced row reads as last-seen (cached), never as a live fetch.
    expect(snap?.source).toBe('last_seen');
  });

  it('does NOT overwrite a fresher local row with an older peer push', async () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:10:00.000Z', 50) }); // local is newer
    const merged = await ingestPeerClaudeUsageRows({ [KEY_A]: row('2026-08-28T12:00:00.000Z', 10) }, dst);
    expect(merged).toBe(0);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:11:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(50); // fresher local survives
  });

  it('accepts a strictly-newer peer push over an older local row', async () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 10) });
    const merged = await ingestPeerClaudeUsageRows({ [KEY_A]: row('2026-08-28T12:10:00.000Z', 55) }, dst);
    expect(merged).toBe(1);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:11:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(55);
  });

  it('a peer row with no capturedAt never displaces a timestamped local row', async () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    const merged = await ingestPeerClaudeUsageRows({ [KEY_A]: row(null, 99) }, dst);
    expect(merged).toBe(0);
    const snap = readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'));
    expect(snap?.windows[0].usedPercent).toBe(22);
  });

  it('adds a brand-new identity the worker had never seen', async () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    const merged = await ingestPeerClaudeUsageRows({ [KEY_B]: row('2026-08-28T12:00:00.000Z', 8) }, dst);
    expect(merged).toBe(1);
    expect(readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(22);
    expect(readClaudeUsageCache(KEY_B, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(8);
  });

  it('an empty payload is a no-op, not an error', async () => {
    seed(dst, { [KEY_A]: row('2026-08-28T12:00:00.000Z', 22) });
    expect(await ingestPeerClaudeUsageRows({}, dst)).toBe(0);
    expect(readClaudeUsageCache(KEY_A, dst, new Date('2026-08-28T12:01:00.000Z'))?.windows[0].usedPercent).toBe(22);
  });
});
