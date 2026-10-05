import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActivityDir } from '../state.js';
import { ACTIVITY_TAIL_BYTES, parseActivityLine, type ActivityEvent } from './activity.js';

const ACTIVITY_SWEEP_MS = 5_000;
const ACTIVITY_ANCHOR_BYTES = 64;

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

interface FileStat {
  identity: string;
  size: number;
  mtimeNs: number;
  ctimeNs: number;
}

function changed(cursor: FileCursor, stat: FileStat): boolean {
  return stat.identity !== cursor.identity
    || stat.size !== cursor.size
    || stat.mtimeNs !== cursor.mtimeNs
    || stat.ctimeNs !== cursor.ctimeNs;
}

interface FileCursor {
  identity: string;
  offset: number;
  partial: Buffer;
  partialIsFragment: boolean;
  anchor: Buffer;
  size: number;
  mtimeNs: number;
  ctimeNs: number;
}

interface ActivityStreamOptions {
  root?: string;
  maxBytesPerRead?: number;
  sweepMs?: number;
  watch?: boolean;
}

export class ActivityStream {
  private readonly dir: string;
  private readonly maxBytesPerRead: number;
  private readonly sweepMs: number;
  private readonly cursors = new Map<string, FileCursor>();
  private readonly dirty = new Set<string>();
  private watcher?: fs.FSWatcher;
  private watchRequested: boolean;
  private lastSweepMs = 0;
  private started = false;
  bytesRead = 0;

  constructor(options: ActivityStreamOptions = {}) {
    this.dir = options.root ?? getActivityDir();
    this.maxBytesPerRead = options.maxBytesPerRead ?? ACTIVITY_TAIL_BYTES;
    this.sweepMs = options.sweepMs ?? ACTIVITY_SWEEP_MS;
    this.watchRequested = options.watch ?? true;
    // Arm immediately when the first log appears; failed watchers still recover through sweeps.
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch {  }
    this.sweep(Date.now());
    this.armWatcher();
  }

  read(sinceMs: number, nowMs = Date.now()): ActivityEvent[] {
    const out: ActivityEvent[] = [];
    for (const name of this.candidates(nowMs)) {
      for (const event of this.readFile(name)) {
        const at = Date.parse(event.ts);
        if (Number.isFinite(at) && at >= sinceMs) out.push(event);
      }
    }
    out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return out;
  }

  close(): void {
    this.watchRequested = false;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private candidates(nowMs: number): string[] {
    if (!this.watcher) this.armWatcher();
    if (!this.watcher || nowMs - this.lastSweepMs >= this.sweepMs) this.sweep(nowMs);
    const names = [...this.dirty];
    this.dirty.clear();
    return names;
  }

  private sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const stat = this.statOf(name);
      if (!stat) continue;
      const cursor = this.cursors.get(name);
      if (!cursor) {
        // Opening discovery registers history at EOF; files discovered later are live work.
        if (this.started) this.dirty.add(name);
        else this.cursors.set(name, {
          identity: stat.identity, offset: stat.size, partial: EMPTY, partialIsFragment: false,
          anchor: EMPTY, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
        });
        continue;
      }
      if (changed(cursor, stat)) this.dirty.add(name);
    }
    // Never cap live cursors: eviction would replay a retained tail as duplicate events.
    for (const name of [...this.cursors.keys()]) if (!seen.has(name)) this.cursors.delete(name);
    this.started = true;
  }

  private statOf(name: string): FileStat | undefined {
    try {
      const st = fs.statSync(path.join(this.dir, name), { bigint: true });
      return {
        identity: `${st.dev}:${st.ino}`,
        size: Number(st.size),
        mtimeNs: Number(st.mtimeNs),
        ctimeNs: Number(st.ctimeNs),
      };
    } catch {
      return undefined;
    }
  }

  private freshCursor(stat: FileStat): FileCursor {
    const offset = Math.max(0, stat.size - this.maxBytesPerRead);
    return {
      identity: stat.identity, offset, partial: EMPTY, partialIsFragment: offset > 0,
      anchor: EMPTY, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
    };
  }

  private readFile(name: string, restarted = false): ActivityEvent[] {
    const stat = this.statOf(name);
    if (!stat) { this.cursors.delete(name); return []; }
    let cursor = this.cursors.get(name);
    // ctime catches same-size rewrites; the trailing anchor catches longer in-place rewrites.
    if (!cursor || cursor.identity !== stat.identity || stat.size < cursor.offset
      || (stat.size === cursor.size && stat.ctimeNs !== cursor.ctimeNs)) {
      cursor = this.freshCursor(stat);
      this.cursors.set(name, cursor);
    }
    cursor.size = stat.size;
    cursor.mtimeNs = stat.mtimeNs;
    cursor.ctimeNs = stat.ctimeNs;
    if (stat.size <= cursor.offset) return [];
    const start = Math.max(cursor.offset, stat.size - this.maxBytesPerRead);
    if (start > cursor.offset) {
      cursor.partial = EMPTY;
      cursor.partialIsFragment = true;
      cursor.anchor = EMPTY;
    }
    const verify = Math.min(cursor.anchor.length, start);
    const buf = this.readRange(name, start - verify, stat.size - start + verify);
    // I/O failure never advances the consumed offset, so a future candidate can retry these bytes.
    if (buf === undefined) return [];
    if (verify > 0 && !buf.subarray(0, verify).equals(cursor.anchor.subarray(cursor.anchor.length - verify))) {
      if (restarted) return [];
      this.cursors.delete(name);
      return this.readFile(name, true);
    }
    const fresh = buf.subarray(verify);
    cursor.offset = stat.size;
    cursor.anchor = Buffer.concat([cursor.anchor, fresh]).subarray(-ACTIVITY_ANCHOR_BYTES);
    const chunk = Buffer.concat([cursor.partial, fresh]);
    const fragment = cursor.partialIsFragment;
    const end = chunk.lastIndexOf(NEWLINE);
    cursor.partial = end < 0 ? chunk : chunk.subarray(end + 1);
    cursor.partialIsFragment = end < 0 ? fragment : false;
    if (end < 0) return [];
    const lines = chunk.subarray(0, end).toString('utf-8').split('\n');
    if (fragment) lines.shift();
    const events: ActivityEvent[] = [];
    for (const line of lines) {
      const event = parseActivityLine(line);
      if (event) events.push(event);
    }
    return events;
  }

  private readRange(name: string, start: number, length: number): Buffer | undefined {
    let fd: number | undefined;
    try {
      fd = fs.openSync(path.join(this.dir, name), 'r');
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      this.bytesRead += read;
      return buf.subarray(0, read);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private armWatcher(): void {
    if (!this.watchRequested || this.watcher) return;
    try {
      this.watcher = fs.watch(this.dir, (_event, name) => {
        if (typeof name === 'string' && name.endsWith('.jsonl')) this.dirty.add(name);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch {
      this.watcher = undefined;
    }
  }
}
