import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readRecentActivity } from './activity.js';
import { ActivityStream } from './activity-stream.js';

const roots: string[] = [];
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-stream-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function line(sessionId: string, detail: string, ts: string, event = 'status.posted'): string {
  return `${JSON.stringify({ v: 1, sessionId, event, ts, detail, host: 'box', runtime: 'headless' })}\n`;
}

/** Waits until the filesystem timestamp clock advances: Linux ctime is coarse, so two writes in
 * one tick share a ctime and the same-length-rewrite check has nothing to see. A filesystem
 * property, so the test waits it out. */
async function tickFsClock(dir: string): Promise<void> {
  const probe = path.join(dir, '.tick');
  fs.writeFileSync(probe, 'a');
  const start = fs.statSync(probe, { bigint: true }).ctimeNs;
  const deadline = Date.now() + 5_000;
  for (let i = 0; ; i += 1) {
    fs.writeFileSync(probe, `b${i}`);
    if (fs.statSync(probe, { bigint: true }).ctimeNs !== start) break;
    if (Date.now() > deadline) throw new Error('filesystem ctime never advanced');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  fs.unlinkSync(probe);
}

async function settle(ms = 120): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe('incremental activity stream over real files', () => {
  it('emits exactly what readRecentActivity emits for the same appended lines', () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 'a.jsonl'), line('a', 'old-a', '2026-09-05T00:00:00.000Z'));
    fs.writeFileSync(path.join(dir, 'b.jsonl'), line('b', 'old-b', '2026-09-05T00:00:01.000Z'));
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const stream = new ActivityStream({ root: dir, watch: false });

    fs.appendFileSync(path.join(dir, 'a.jsonl'), line('a', 'a-2', '2026-09-06T00:00:02.000Z'));
    fs.appendFileSync(path.join(dir, 'b.jsonl'), line('b', 'b-1', '2026-09-06T00:00:01.000Z'));
    fs.appendFileSync(path.join(dir, 'a.jsonl'), line('a', 'a-3', '2026-09-06T00:00:03.000Z'));
    fs.writeFileSync(path.join(dir, 'c.jsonl'), line('c', 'c-1', '2026-09-06T00:00:00.000Z'));

    const streamed = stream.read(sinceMs);
    const oneShot = readRecentActivity({ root: dir, sinceMs });
    expect(streamed).toEqual(oneShot);
    expect(streamed.map((event) => event.detail)).toEqual(['a-3', 'a-2', 'b-1', 'c-1']);
    stream.close();
  });

  it('reads only the appended bytes, not the corpus, across a thousand session logs', () => {
    const dir = root();
    for (let i = 0; i < 1_000; i++) {
      fs.writeFileSync(path.join(dir, `s${i}.jsonl`), line(`s${i}`, `seed-${i}`, '2026-09-05T00:00:00.000Z'));
    }
    const corpusBytes = fs.readdirSync(dir).reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
    expect(corpusBytes).toBeGreaterThan(100_000);

    const stream = new ActivityStream({ root: dir, watch: false });
    expect(stream.bytesRead).toBe(0);

    const appended = line('s7', 'live', '2026-09-06T00:00:00.000Z');
    fs.appendFileSync(path.join(dir, 's7.jsonl'), appended);
    const events = stream.read(Date.parse('2026-09-06T00:00:00.000Z'));
    expect(events.map((event) => event.detail)).toEqual(['live']);
    expect(stream.bytesRead).toBe(Buffer.byteLength(appended));

    const before = stream.bytesRead;
    expect(stream.read(Date.parse('2026-09-06T00:00:00.000Z'))).toEqual([]);
    expect(stream.bytesRead).toBe(before);
    stream.close();
  });

  it('holds a half-written line until its newline arrives, and emits it exactly once', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '');
    const stream = new ActivityStream({ root: dir, watch: false });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const record = line('s', 'torn', '2026-09-06T00:00:00.000Z');

    fs.appendFileSync(file, record.slice(0, 20));
    expect(stream.read(sinceMs)).toEqual([]);
    fs.appendFileSync(file, record.slice(20));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['torn']);
    expect(stream.read(sinceMs)).toEqual([]);
    stream.close();
  });

  it('recovers from an in-place rewrite, truncation, atomic replacement, deletion, and a log created later', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, line('s', 'seed', '2026-09-05T00:00:00.000Z'));
    const stream = new ActivityStream({ root: dir, watch: false });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    fs.appendFileSync(file, line('s', 'appended', '2026-09-06T00:00:00.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['appended']);

    fs.writeFileSync(file, line('s', 'rewritten-in-place-and-longer', '2026-09-06T00:00:01.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['rewritten-in-place-and-longer']);

    fs.writeFileSync(file, line('s', 'short', '2026-09-06T00:00:02.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['short']);

    const staged = path.join(dir, 'staged');
    fs.writeFileSync(staged, line('s', 'replaced', '2026-09-06T00:00:03.000Z'));
    fs.renameSync(staged, file);
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['replaced']);

    fs.writeFileSync(path.join(dir, 'new.jsonl'), line('new', 'fresh', '2026-09-06T00:00:04.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['fresh']);

    fs.unlinkSync(file);
    expect(stream.read(sinceMs)).toEqual([]);
    stream.close();
  });

  it('reads a same-length in-place rewrite that leaves size and mtime untouched', async () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    // Two records of identical byte length leave size and the 64-byte anchor unchanged, and both
    // share one mtime. ctime is the only remaining signal; without it the reader retires the file
    // and never emits the rewrite.
    const before = line('s', 'aaaaaaaa', '2026-09-06T00:00:01.000Z');
    const after = line('s', 'bbbbbbbb', '2026-09-06T00:00:02.000Z');
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    const pinned = new Date('2026-09-06T12:00:00.000Z');

    fs.writeFileSync(file, '');
    const stream = new ActivityStream({ root: dir, watch: false });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    fs.appendFileSync(file, before);
    fs.utimesSync(file, pinned, pinned);
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['aaaaaaaa']);
    const was = fs.statSync(file, { bigint: true });

    await tickFsClock(dir);
    fs.writeFileSync(file, after);
    fs.utimesSync(file, pinned, pinned);
    const now = fs.statSync(file, { bigint: true });
    expect(now.size).toBe(was.size);
    expect(now.mtimeNs).toBe(was.mtimeNs);
    expect(now.ctimeNs).not.toBe(was.ctimeNs);

    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['bbbbbbbb']);
    stream.close();
  });

  it('never replays a log it is already tracking, however many logs there are', () => {
    const dir = root();
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const files = Array.from({ length: 40 }, (_, i) => path.join(dir, `s${i}.jsonl`));
    for (const [i, file] of files.entries()) fs.writeFileSync(file, line(`s${i}`, `seed-${i}`, '2026-09-05T00:00:00.000Z'));
    const stream = new ActivityStream({ root: dir, watch: false });

    fs.appendFileSync(files[0], line('s0', 'appended', '2026-09-06T00:00:00.000Z'));
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['appended']);
    for (let tick = 1; tick <= 5; tick += 1) {
      expect(stream.read(sinceMs, Date.now() + tick * 10_000)).toEqual([]);
    }
    expect(stream.bytesRead).toBe(Buffer.byteLength(line('s0', 'appended', '2026-09-06T00:00:00.000Z')));
    stream.close();
  });

  it('keeps only the newest bytes when one tick appends more than the read budget', () => {
    const dir = root();
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, '');
    const stream = new ActivityStream({ root: dir, watch: false, maxBytesPerRead: 400 });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    const burst = Array.from({ length: 20 }, (_, i) => line('s', `burst-${i}`, `2026-09-06T00:00:${String(i).padStart(2, '0')}.000Z`)).join('');
    expect(Buffer.byteLength(burst)).toBeGreaterThan(400);
    fs.appendFileSync(file, burst);
    const details = stream.read(sinceMs).map((event) => event.detail);
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]).toBe('burst-19');
    expect(stream.bytesRead).toBeLessThanOrEqual(400);
    stream.close();
  });

  it('picks up an appended log through the directory watcher without sweeping every tick', async () => {
    const dir = root();
    fs.writeFileSync(path.join(dir, 's.jsonl'), line('s', 'seed', '2026-09-05T00:00:00.000Z'));
    const stream = new ActivityStream({ root: dir, sweepMs: 3_600_000 });
    const sinceMs = Date.parse('2026-09-06T00:00:00.000Z');
    fs.appendFileSync(path.join(dir, 's.jsonl'), line('s', 'watched', '2026-09-06T00:00:00.000Z'));
    await settle();
    expect(stream.read(sinceMs).map((event) => event.detail)).toEqual(['watched']);
    stream.close();
  });
});
