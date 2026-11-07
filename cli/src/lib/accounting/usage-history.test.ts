import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ingestPeerClaudeUsageRows, mergeClaudeUsageCacheWindows, writeClaudeUsageCache } from './usage.js';
import {
  mergeUsagePeaks,
  peaksFromCacheRows,
  readUsageHistory,
  recordUsagePeaks,
  usageHistoryPathFor,
  usagePeaksForPublish,
  type UsagePeak,
} from './usage-history.js';

let dir: string;
let cachePath: string;
let historyPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-history-'));
  cachePath = path.join(dir, 'claude-usage.json');
  historyPath = usageHistoryPathFor(cachePath);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const week = (usedPercent: number, resetsAt: string) => ({
  key: 'week' as const, label: 'Week', shortLabel: 'W', usedPercent, resetsAt: new Date(resetsAt), windowMinutes: 10080,
});
const session = (usedPercent: number) => ({
  key: 'session' as const, label: 'Session', shortLabel: 'S', usedPercent, resetsAt: new Date('2026-11-07T18:00:00Z'), windowMinutes: 300,
});

describe('weekly peak ledger', () => {
  it('keeps the highest reading per weekly window and ignores the 5-hour window', () => {
    recordUsagePeaks('claude:org=a', [week(20, '2026-11-10T14:00:00Z'), session(90)], new Date('2026-11-05T10:00:00Z'), historyPath);
    recordUsagePeaks('claude:org=a', [week(63, '2026-11-10T14:00:00Z')], new Date('2026-11-07T11:00:00Z'), historyPath);
    recordUsagePeaks('claude:org=a', [week(40, '2026-11-10T14:00:00Z')], new Date('2026-11-07T12:00:00Z'), historyPath);
    recordUsagePeaks('claude:org=a', [week(5, '2026-11-17T14:00:00Z')], new Date('2026-11-11T09:00:00Z'), historyPath);
    expect(readUsageHistory(historyPath)).toEqual([
      { key: 'claude:org=a', resetsAt: '2026-11-10T14:00:00.000Z', peak: 63, firstSeen: '2026-11-05T10:00:00.000Z', lastSeen: '2026-11-07T12:00:00.000Z' },
      { key: 'claude:org=a', resetsAt: '2026-11-17T14:00:00.000Z', peak: 5, firstSeen: '2026-11-11T09:00:00.000Z', lastSeen: '2026-11-11T09:00:00.000Z' },
    ]);
  });

  it('merges ledgers from several boxes the same way in any order', () => {
    const a: UsagePeak[] = [{ key: 'k', resetsAt: '2026-11-10T00:00:00.000Z', peak: 30, firstSeen: '2026-11-04T00:00:00.000Z', lastSeen: '2026-11-05T00:00:00.000Z' }];
    const b: UsagePeak[] = [{ key: 'k', resetsAt: '2026-11-10T00:00:00.000Z', peak: 55, firstSeen: '2026-11-05T00:00:00.000Z', lastSeen: '2026-11-08T00:00:00.000Z' }];
    expect(mergeUsagePeaks(a, b)).toEqual(mergeUsagePeaks(b, a));
    expect(mergeUsagePeaks(a, b)[0]).toMatchObject({ peak: 55, firstSeen: '2026-11-04T00:00:00.000Z', lastSeen: '2026-11-08T00:00:00.000Z' });
  });

  it('reads weekly peaks out of usage cache rows captured before the ledger existed', () => {
    const rows = {
      'claude:org=a': {
        capturedAt: '2026-11-07T11:00:00.000Z',
        windows: [
          { key: 'session' as const, usedPercent: 80, resetsAt: '2026-11-07T15:00:00.000Z' },
          { key: 'week' as const, usedPercent: 32, resetsAt: '2026-11-13T16:00:00.000Z' },
        ],
      },
      'claude:org=b': { capturedAt: null, windows: [{ key: 'week' as const, usedPercent: 50, resetsAt: '2026-11-13T16:00:00.000Z' }] },
    };
    expect(peaksFromCacheRows(rows)).toEqual([
      { key: 'claude:org=a', resetsAt: '2026-11-13T16:00:00.000Z', peak: 32, firstSeen: '2026-11-07T11:00:00.000Z', lastSeen: '2026-11-07T11:00:00.000Z' },
    ]);
  });

  it('prunes old windows locally and publishes only the recent ones', () => {
    recordUsagePeaks('k', [week(10, '2026-04-01T00:00:00Z')], new Date('2026-04-01T00:00:00Z'), historyPath);
    recordUsagePeaks('k', [week(20, '2026-07-01T00:00:00Z')], new Date('2026-07-01T00:00:00Z'), historyPath);
    recordUsagePeaks('k', [week(30, '2026-11-01T00:00:00Z')], new Date('2026-11-01T00:00:00Z'), historyPath);
    expect(readUsageHistory(historyPath).map((p) => p.peak)).toEqual([20, 30]);
    expect(usagePeaksForPublish(new Date('2026-11-01T00:00:00Z'), historyPath).map((p) => p.peak)).toEqual([30]);
  });

  it('is fed by every usage cache writer: poll, status line, and peer sync', async () => {
    writeClaudeUsageCache('claude:org=poll', {
      source: 'live', sourceLabel: 'poll', capturedAt: new Date('2026-11-06T00:00:00Z'), windows: [week(12, '2026-11-10T00:00:00Z')],
    }, cachePath);
    mergeClaudeUsageCacheWindows('claude:org=statusline', {
      source: 'live', sourceLabel: 'status line', capturedAt: new Date('2026-11-06T00:00:00Z'), windows: [week(27, '2026-11-08T08:00:00Z')],
    }, cachePath);
    await ingestPeerClaudeUsageRows({
      'claude:org=peer': {
        capturedAt: '2026-11-06T00:00:00.000Z',
        windows: [{ key: 'week', label: 'Week', shortLabel: 'W', usedPercent: 63, resetsAt: '2026-11-10T14:00:00.000Z', windowMinutes: 10080 }],
      },
    }, cachePath);
    expect(readUsageHistory(historyPath).map((p) => [p.key, p.peak])).toEqual([
      ['claude:org=peer', 63],
      ['claude:org=poll', 12],
      ['claude:org=statusline', 27],
    ]);
  });
});
