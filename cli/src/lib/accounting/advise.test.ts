import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { accountsAdviceNotification, adviseAccounts, renderAccountsAdvice, weekStartUtc, type AdviseAccountInput } from './advise.js';
import { parseUsagePeaks, type UsagePeak } from './usage-history.js';

const FIXTURE = path.join(__dirname, 'testdata', 'advise-peaks.json');
const NOW = new Date('2026-11-07T13:00:00.000Z');
const NAMES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

function fixturePeaks(): UsagePeak[] {
  return parseUsagePeaks(JSON.parse(fs.readFileSync(FIXTURE, 'utf-8')).peaks);
}

function accounts(over: Partial<Record<string, Partial<AdviseAccountInput>>> = {}): AdviseAccountInput[] {
  return NAMES.map((name) => ({
    name,
    id: `id-${name}`,
    usageKey: `claude:org=${name}`,
    paused: false,
    isDefault: false,
    ...over[name],
  }));
}

describe('adviseAccounts', () => {
  it('sizes seats from summed weekly demand, not per-account activity', () => {
    const result = adviseAccounts(accounts(), fixturePeaks(), { now: NOW });
    expect(result.weeks).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(result.demand).toEqual([1.96, 1.72, 1.91, 1.99]);
    expect(result.peakDemand).toBe(1.99);
    expect(result.advice).toMatchObject({
      keep: 3,
      pause: ['hotel', 'golf', 'foxtrot', 'echo', 'delta'],
      add: 0,
      confidence: 'high',
    });
    const alpha = result.rows.find((r) => r.name === 'alpha')!;
    expect(alpha.peaks).toEqual([71, 55, 62, 78]);
    expect(alpha.thisWeek).toBe(14);
  });

  it('never pauses the default account', () => {
    const result = adviseAccounts(accounts({ hotel: { isDefault: true } }), fixturePeaks(), { now: NOW });
    expect(result.advice.keep).toBe(3);
    expect(result.advice.pause).not.toContain('hotel');
    expect(result.advice.pause).toEqual(['golf', 'foxtrot', 'echo', 'delta', 'charlie']);
  });

  it('adds a seat when an account hit its weekly limit', () => {
    const peaks = fixturePeaks().map((p) => (p.key === 'claude:org=alpha' && p.peak === 78 ? { ...p, peak: 100 } : p));
    const two = accounts().slice(0, 2);
    const result = adviseAccounts(two, peaks, { now: NOW });
    expect(result.advice.keep).toBe(3);
    expect(result.advice.add).toBe(1);
    expect(result.advice.reason).toContain('hit its weekly limit');
  });

  it('suggests resuming paused accounts before adding new ones', () => {
    const all = accounts({ delta: { paused: true }, echo: { paused: true }, foxtrot: { paused: true }, golf: { paused: true }, hotel: { paused: true }, charlie: { paused: true } });
    const result = adviseAccounts(all, fixturePeaks(), { now: NOW });
    expect(result.coverage).toEqual({ measured: 2, total: 2 });
    expect(result.advice.keep).toBe(3);
    expect(result.advice.resume).toEqual(['charlie']);
    expect(result.advice.add).toBe(0);
  });

  it('gives no recommendation without readings, and low confidence with partial coverage', () => {
    expect(adviseAccounts(accounts(), [], { now: NOW }).advice).toMatchObject({ confidence: 'none', keep: 8, pause: [] });
    const partial = fixturePeaks().filter((p) => p.key !== 'claude:org=charlie');
    const result = adviseAccounts(accounts(), partial, { now: NOW });
    expect(result.advice.confidence).toBe('low');
    expect(result.advice.reason).toContain('No reading for charlie');
  });

  it('counts this week at its projected pace and names nobody to pause on thin history', () => {
    const peaks: UsagePeak[] = [
      { key: 'claude:org=echo', resetsAt: '2026-11-10T14:00:00.000Z', peak: 63, firstSeen: '2026-11-04T00:00:00.000Z', lastSeen: '2026-11-07T11:00:00.000Z' },
      { key: 'claude:org=delta', resetsAt: '2026-11-09T17:00:00.000Z', peak: 21, firstSeen: '2026-11-03T00:00:00.000Z', lastSeen: '2026-11-07T13:00:00.000Z' },
      { key: 'claude:org=bravo', resetsAt: '2026-11-13T16:00:00.000Z', peak: 9, firstSeen: '2026-11-07T12:00:00.000Z', lastSeen: '2026-11-07T12:30:00.000Z' },
      { key: 'claude:org=golf', resetsAt: '2026-10-27T06:00:00.000Z', peak: 87, firstSeen: '2026-10-21T00:00:00.000Z', lastSeen: '2026-10-22T19:50:00.000Z' },
    ];
    const result = adviseAccounts(accounts(), peaks, { now: NOW });
    const echo = result.rows.find((r) => r.name === 'echo')!;
    expect(echo).toMatchObject({ thisWeek: 63, pace: 100 });
    expect(result.rows.find((r) => r.name === 'bravo')).toMatchObject({ thisWeek: 9, pace: null });
    expect(result.currentDemand).toBe(1.39);
    expect(result.peakDemand).toBe(1.39);
    expect(result.advice).toMatchObject({ keep: 2, pause: [], confidence: 'low' });
    expect(result.advice.reason).toContain('named once every active account has readings');
  });

  it('files a window under the calendar week it started in', () => {
    expect(new Date(weekStartUtc(Date.parse('2026-11-08T23:59:00Z'))).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(weekStartUtc(Date.parse('2026-11-09T00:00:00Z'))).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });

  it('renders the table and the exact pause command', () => {
    const lines = renderAccountsAdvice({ harness: 'claude', ...adviseAccounts(accounts(), fixturePeaks(), { now: NOW }) });
    expect(lines.join('\n')).toContain('Keep 3, pause 5: hotel, golf, foxtrot, echo, delta');
    expect(lines).toContain('  agents accounts pause claude#hotel claude#golf claude#foxtrot claude#echo claude#delta');
  });
});

describe('accountsAdviceNotification', () => {
  const result = () => ({ harness: 'claude', ...adviseAccounts(accounts(), fixturePeaks(), { now: NOW }) });

  it('tells the owner once per changed recommendation, with the command to run', () => {
    const note = accountsAdviceNotification(result(), null, NOW)!;
    expect(note.title).toBe('claude: 3 of 8 accounts cover your usage');
    expect(note.body).toContain('agents accounts pause claude#hotel claude#golf');
    expect(note.dedupKey).toBe('accounts-advice:claude:2026-11-02:3');
    expect(accountsAdviceNotification(result(), note.fingerprint, NOW)).toBeNull();
  });

  it('stays quiet when the advice is low confidence or nothing should change', () => {
    const partial = fixturePeaks().filter((p) => p.key !== 'claude:org=charlie');
    expect(accountsAdviceNotification({ harness: 'claude', ...adviseAccounts(accounts(), partial, { now: NOW }) }, null, NOW)).toBeNull();
    const two = accounts().slice(0, 2);
    const fit = adviseAccounts(two, fixturePeaks().filter((p) => ['claude:org=alpha', 'claude:org=bravo'].includes(p.key)), { now: NOW });
    expect(fit.advice).toMatchObject({ keep: 2, pause: [], resume: [], add: 0 });
    expect(accountsAdviceNotification({ harness: 'claude', ...fit }, null, NOW)).toBeNull();
  });
});
