/** Incremental reader for the activity log directory, for `agents feed watch` (polled twice a
 * second; a real box holds 1,437 logs / 64 MB). Keeps a per-file cursor: the opening scan
 * records size, inode and mtime without opening files, so only later-appended bytes are read. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getActivityDir } from '../state.js';
import { ACTIVITY_TAIL_BYTES, parseActivityLine, type ActivityEvent } from './activity.js';

/** How often the stream falls back to a full directory stat sweep. */
const ACTIVITY_SWEEP_MS = 5_000;
/** Bytes behind the cursor re-verified before appended bytes are trusted. */
const ACTIVITY_ANCHOR_BYTES = 64;

const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

/** What one `stat` tells this reader about a log. */
interface FileStat {
  identity: string;
  size: number;
  mtimeNs: number;
  ctimeNs: number;
}

/** Could this file have changed since its cursor last looked? */
function changed(cursor: FileCursor, stat: FileStat): boolean {
  return stat.identity !== cursor.identity
    || stat.size !== cursor.size
    || stat.mtimeNs !== cursor.mtimeNs
    || stat.ctimeNs !== cursor.ctimeNs;
}

interface FileCursor {
  /** `dev:ino` of the tracked inode; a change means the path was replaced. */
  identity: string;
  /** Bytes of this inode already consumed. */
  offset: number;
  /** Trailing bytes after the last newline, waiting for the line to finish. */
  partial: Buffer;
  /** True when `partial` starts mid-record and must not be parsed. */
  partialIsFragment: boolean;
  /** The last ACTIVITY_ANCHOR_BYTES already consumed. Growth alone cannot distinguish an append
   * from a longer in-place rewrite, so these bytes are re-verified on the same read and a
   * mismatch restarts the file. */
  anchor: Buffer;
  /** Last observed size, mtime and ctime, so an untouched file is never opened. ctime is
   * load-bearing: a same-size rewrite that restores mtime is invisible to the others (same
   * keying as `activityStamp` in activity.ts). */
  size: number;
  mtimeNs: number;
  ctimeNs: number;
}

interface ActivityStreamOptions {
  /** Override the activity dir (tests). */
  root?: string;
  /** Newest bytes read from one file in one tick; a larger burst keeps only the tail, like
   * `readRecentActivity`. */
  maxBytesPerRead?: number;
  /** Full stat sweep cadence, covering anything the directory watcher misses. */
  sweepMs?: number;
  /** Subscribe to directory change notifications (default true). */
  watch?: boolean;
}

/** A cursor over the activity directory: construct it when the caller's cursor starts, then call
 * read once per tick. */
export class ActivityStream {
  private readonly dir: string;
  private readonly maxBytesPerRead: number;
  private readonly sweepMs: number;
  private readonly cursors = new Map<string, FileCursor>();
  private readonly dirty = new Set<string>();
  private watcher?: fs.FSWatcher;
  private watchRequested: boolean;
  private lastSweepMs = 0;
  /** False during the opening scan, so it registers history without reading it. */
  private started = false;
  /** Bytes read from activity logs since construction. Observability + tests. */
  bytesRead = 0;

  constructor(options: ActivityStreamOptions = {}) {
    this.dir = options.root ?? getActivityDir();
    this.maxBytesPerRead = options.maxBytesPerRead ?? ACTIVITY_TAIL_BYTES;
    this.sweepMs = options.sweepMs ?? ACTIVITY_SWEEP_MS;
    this.watchRequested = options.watch ?? true;
    // If the log directory doesn't exist yet, fs.watch throws ENOENT and only retries on the sweep
    // cadence, leaving early activity unwatched for up to `sweepMs`. Creating it up front lets the
    // watcher arm immediately.
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* best-effort: sweep() covers a dir that still isn't there */ }
    this.sweep(Date.now());
    this.armWatcher();
  }

  /** Events appended since the last call, newest first, filtered to `sinceMs` inclusive; same
   * shape and order as `readRecentActivity`. */
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

  /** Release the directory watcher. Safe to call more than once. */
  close(): void {
    this.watchRequested = false;
    this.watcher?.close();
    this.watcher = undefined;
  }

  /** Which log names could have changed since the previous tick. */
  private candidates(nowMs: number): string[] {
    // A watcher that never armed (unsupported filesystem, or a directory that
    // did not exist at construction) means every tick sweeps. That is the
    // fallback: never a silent no-op that would drop events.
    if (!this.watcher) this.armWatcher();
    if (!this.watcher || nowMs - this.lastSweepMs >= this.sweepMs) this.sweep(nowMs);
    const names = [...this.dirty];
    this.dirty.clear();
    return names;
  }

  /** Stats every log and marks those that may have changed. Opens nothing: logs seen by the
   * opening scan are registered past their own bytes, so history is never replayed. */
  private sweep(nowMs: number): void {
    this.lastSweepMs = nowMs;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return; // The directory appears with the first logged event.
    }
    const seen = new Set<string>();
    for (const name of names) {
      seen.add(name);
      const stat = this.statOf(name);
      if (!stat) continue;
      const cursor = this.cursors.get(name);
      if (!cursor) {
        // A log first seen after the opening scan is new work: left
        // unregistered so `readFile` opens it from a bounded tail.
        if (this.started) this.dirty.add(name);
        else this.cursors.set(name, {
          identity: stat.identity, offset: stat.size, partial: EMPTY, partialIsFragment: false,
          anchor: EMPTY, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
        });
        continue;
      }
      if (changed(cursor, stat)) this.dirty.add(name);
    }
    // A cursor is dropped only when its log is gone. No size cap: the map cannot outgrow the
    // directory the sweep already enumerates, and dropping a live log's cursor would replay a tail
    // of it as duplicates.
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
      return undefined; // Deleted between readdir and stat.
    }
  }

  /** A cursor starting at a bounded tail of the file as it stands right now. */
  private freshCursor(stat: FileStat): FileCursor {
    const offset = Math.max(0, stat.size - this.maxBytesPerRead);
    return {
      identity: stat.identity, offset, partial: EMPTY, partialIsFragment: offset > 0,
      anchor: EMPTY, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
    };
  }

  /** Read and parse only the bytes appended to one log since its cursor. */
  private readFile(name: string, restarted = false): ActivityEvent[] {
    const stat = this.statOf(name);
    if (!stat) { this.cursors.delete(name); return []; }
    let cursor = this.cursors.get(name);
    // Unseen, replaced, truncated or rewritten-in-place logs restart from a bounded tail; the
    // caller's `sinceMs` drops older events. ctime is tracked for the same-length case: the anchor
    // catches growth and the offset compare catches a shrink.
    if (!cursor || cursor.identity !== stat.identity || stat.size < cursor.offset
      || (stat.size === cursor.size && stat.ctimeNs !== cursor.ctimeNs)) {
      cursor = this.freshCursor(stat);
      this.cursors.set(name, cursor);
    }
    cursor.size = stat.size;
    cursor.mtimeNs = stat.mtimeNs;
    cursor.ctimeNs = stat.ctimeNs;
    if (stat.size <= cursor.offset) return [];
    // A burst larger than the budget keeps the newest bytes; the skipped span is
    // exactly what the bounded-tail reader would have dropped as well.
    const start = Math.max(cursor.offset, stat.size - this.maxBytesPerRead);
    if (start > cursor.offset) {
      cursor.partial = EMPTY;
      cursor.partialIsFragment = true;
      cursor.anchor = EMPTY;
    }
    const verify = Math.min(cursor.anchor.length, start);
    const buf = this.readRange(name, start - verify, stat.size - start + verify);
    if (buf === undefined) return []; // Transient I/O error: retry next tick.
    if (verify > 0 && !buf.subarray(0, verify).equals(cursor.anchor.subarray(cursor.anchor.length - verify))) {
      // The bytes behind the cursor changed, so this file was rewritten rather
      // than appended to. Restart it once from a bounded tail.
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
    // Hold an unterminated trailing line: the writer appends whole
    // newline-terminated records (`appendActivityEvent`), so a tail without a
    // newline is a write in progress and completes on a later tick.
    cursor.partial = end < 0 ? chunk : chunk.subarray(end + 1);
    cursor.partialIsFragment = end < 0 ? fragment : false;
    if (end < 0) return [];
    const lines = chunk.subarray(0, end).toString('utf-8').split('\n');
    // A range that began mid-file starts inside a record; that leading fragment
    // is not one, exactly as the bounded-tail reader drops it.
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
      // A watch error (the directory is removed) degrades to sweeping rather
      // than taking down the watcher process.
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined; });
    } catch {
      this.watcher = undefined;
    }
  }
}
