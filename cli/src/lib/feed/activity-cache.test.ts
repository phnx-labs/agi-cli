import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getActivityCacheStats, readRecentActivity, readSessionActivity } from './activity.js';

const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-cache-')); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function line(detail: string, ts = '2026-09-06T00:00:00Z', event = 'status.posted') {
  return JSON.stringify({ sessionId: 's', event, ts, detail, attachments: [{ href: 'a', meta: { n: 1 } }] });
}

describe('activity tail cache with real files', () => {
  it('keeps 1293 historical summaries warm without rereading tails, then recovers earlier and appended events', () => {
    const dir = root();
    const text = Array.from({ length: 100 }, (_, i) => line(String(i))).join('\n') + '\n';
    for (let i = 0; i < 1293; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), text);
    const options = { root: dir, sinceMs: Date.parse('2026-09-07') };
    const before = getActivityCacheStats();
    expect(readRecentActivity(options)).toEqual([]);
    const cold = getActivityCacheStats();
    expect(cold.tailReads - before.tailReads).toBe(1293);
    expect(cold.entries - before.entries).toBe(1293);
    expect(cold.bytes - before.bytes).toBeLessThan(2 * 1024 * 1024);
    for (let i = 0; i < 60; i++) expect(readRecentActivity(options)).toEqual([]);
    expect(getActivityCacheStats().tailReads).toBe(cold.tailReads);

    fs.appendFileSync(path.join(dir, 's0.jsonl'), line('appended', '2026-09-08') + '\n');
    expect(readRecentActivity(options).map(e => e.detail)).toEqual(['appended']);
    expect(getActivityCacheStats().tailReads - cold.tailReads).toBe(1);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-06'), limit: 2 }).map(e => e.detail)).toEqual(['appended', '0']);
    const session = readSessionActivity('s1', dir);
    expect(session).toHaveLength(100);
    session[0].attachments![0].meta!.n = 9;
    expect(readSessionActivity('s1', dir)[0].attachments![0].meta!.n).toBe(1);
  });

  it('tracks append, partial completion, truncation, restored-mtime rewrite, replacement, deletion and creation', () => {
    const dir = root(); const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, line('a') + '\n');
    const read = () => readRecentActivity({ root: dir }).map(e => e.detail);
    expect(read()).toEqual(['a']);
    fs.appendFileSync(file, line('b').slice(0, -2));
    expect(read()).toEqual(['a']);
    fs.appendFileSync(file, line('b').slice(-2)); // valid final JSON without newline
    expect(read()).toEqual(['a', 'b']);
    fs.writeFileSync(file, line('c'));
    expect(read()).toEqual(['c']);
    const st = fs.statSync(file);
    fs.writeFileSync(file, line('d'));
    fs.utimesSync(file, st.atime, st.mtime);
    expect(read()).toEqual(['d']);
    fs.writeFileSync(path.join(dir, 'replacement'), line('e'));
    fs.renameSync(path.join(dir, 'replacement'), file);
    expect(read()).toEqual(['e']);
    fs.unlinkSync(file);
    expect(read()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'new.jsonl'), line('f'));
    expect(read()).toEqual(['f']);
  });

  it('preserves filter-before-limit, inclusive timestamps, invalid dates, unsorted timestamps and mutable results', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), [line('new', '2026-09-07'), line('bad', 'invalid'), line('old', '2026-09-06'), line('routine', '2026-09-08', 'file.edited')].join('\n'));
    const options = { root: dir, sinceMs: Date.parse('2026-09-06'), events: ['status.posted'], tier: 'milestone' as const, limit: 2 };
    const events = readRecentActivity(options);
    expect(events.map(e => e.detail)).toEqual(['new', 'old']);
    events[0].detail = 'mutated'; events[0].attachments![0].meta!.n = 9;
    expect(readRecentActivity(options)[0]).toMatchObject({ detail: 'new', attachments: [{ meta: { n: 1 } }] });
    const session = readSessionActivity('s', dir); session[0].attachments![0].href = 'mutated';
    expect(readSessionActivity('s', dir)[0].attachments![0].href).toBe('a');
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-09') })).toEqual([]);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-08') }).map(e => e.detail)).toEqual(['routine']);
  });

  it('keys tail budgets and directories separately and drops the leading partial line exactly as before', () => {
    const a = root(); const b = root(); const text = line('a') + '\n' + line('b') + '\n';
    fs.writeFileSync(path.join(a, 's.jsonl'), text);
    fs.writeFileSync(path.join(b, 's.jsonl'), line('other'));
    expect(readSessionActivity('s', a).map(e => e.detail)).toEqual(['a', 'b']);
    expect(readSessionActivity('s', a, Buffer.byteLength(line('b')) + 2).map(e => e.detail)).toEqual(['b']);
    expect(readSessionActivity('s', a, 5)).toEqual([]);
    expect(readSessionActivity('s', b).map(e => e.detail)).toEqual(['other']);
    expect(readSessionActivity('s', a).map(e => e.detail)).toEqual(['a', 'b']);
  });
  it('does not convert malformed timestamp objects before event filters or during session reads', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify({ sessionId: 's', event: 'file.edited', ts: { toString: 'bad' } }));
    expect(readSessionActivity('s', dir)).toHaveLength(1);
    expect(readRecentActivity({ root: dir, events: ['status.posted'] })).toEqual([]);
    expect(readRecentActivity({ root: dir, tier: 'milestone' })).toEqual([]);
    expect(() => readRecentActivity({ root: dir })).toThrow(TypeError);
  });

  it('rehydrates tails after memory pressure and entry eviction without hiding older events', () => {
    const dir = root();
    // More than the retained parsed-tail budget, with each file below its tail
    // byte budget. Summary-only entries must support a later, earlier cursor.
    const text = Array.from({ length: 1000 }, (_, i) => line(String(i))).join('\n');
    for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(dir, `s${i}.jsonl`), text);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-07') })).toEqual([]);
    expect(readRecentActivity({ root: dir, sinceMs: Date.parse('2026-09-06'), limit: 2 }).map(e => e.detail)).toEqual(['0', '1']);
    const pressure = getActivityCacheStats();
    expect(pressure.bytes).toBeLessThanOrEqual(pressure.maxBytes);
    expect(pressure.parsedTails).toBeGreaterThan(0);
    expect(pressure.parsedTails).toBeLessThan(40);
    expect(readSessionActivity('s0', dir)).toHaveLength(1000);
    const other = root();
    for (let i = 0; i < 1030; i++) {
      fs.writeFileSync(path.join(other, `s${i}.jsonl`), line(String(i)));
      expect(readSessionActivity(`s${i}`, other)[0].detail).toBe(String(i));
    }
    expect(readSessionActivity('s0', dir)).toHaveLength(1000);
    expect(readSessionActivity('s0', other)[0].detail).toBe('0');
  });

  it('evicts summaries within the byte budget when no parsed payloads remain, and does not evict history to admit a payload', () => {
    // Each real tail budget is an independent cache key. An empty real file
    // exercises summary admission without oversized paths or a test-only
    // memory limit, including on macOS's 1024-byte PATH_MAX filesystem.
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), '');
    const count = 100_000;
    const options = { root: dir, sinceMs: Date.parse('2026-09-07') };
    for (let budget = 1; budget <= count; budget++) {
      expect(readRecentActivity({ ...options, maxBytesPerSession: budget })).toEqual([]);
    }
    const full = getActivityCacheStats();
    expect(full.maxBytes).toBe(32 * 1024 * 1024);
    expect(full.bytes).toBeLessThanOrEqual(full.maxBytes);
    expect(full.bytes).toBeGreaterThan(full.maxBytes - 16 * 1024);
    expect(full.parsedTails).toBe(0);
    expect(full.entries).toBeLessThan(count);
    // The newest summary stays warm, while the evicted oldest budget reads
    // the real file again and is admitted without exceeding the byte budget.
    expect(readRecentActivity({ ...options, maxBytesPerSession: count })).toEqual([]);
    expect(getActivityCacheStats().tailReads).toBe(full.tailReads);
    expect(readRecentActivity({ ...options, maxBytesPerSession: 1 })).toEqual([]);
    expect(getActivityCacheStats().tailReads).toBe(full.tailReads + 1);
    expect(getActivityCacheStats().bytes).toBeLessThanOrEqual(full.maxBytes);

    const other = root();
    fs.writeFileSync(path.join(other, 'payload.jsonl'), Array.from({ length: 100 }, () => line('last')).join('\n'));
    const cursor = { root: other, sinceMs: options.sinceMs };
    expect(readRecentActivity(cursor)).toEqual([]);
    const summary = getActivityCacheStats();
    expect(summary.bytes).toBeLessThanOrEqual(full.maxBytes);
    // The retained summary fits, but its payload cannot. Return real events
    // without exceeding the budget or evicting summaries to retain payloads.
    const last = readSessionActivity('payload', other);
    expect(last).toHaveLength(100);
    expect(last[0].detail).toBe('last');
    const rehydrated = getActivityCacheStats();
    expect(rehydrated.entries).toBe(summary.entries);
    expect(rehydrated.bytes).toBe(summary.bytes);
    expect(rehydrated.parsedTails).toBe(0);
    for (let i = 0; i < 10; i++) expect(readRecentActivity(cursor)).toEqual([]);
    expect(getActivityCacheStats().tailReads).toBe(rehydrated.tailReads);
  });

});
