/** Cross-platform `tail -f`: a poll-based follower replacing the POSIX `tail` binary (absent on
 * Windows). Reads bytes appended every `intervalMs` and resets to 0 if the file shrinks
 * (rotation). Callers register SIGINT and call the returned stop(). */
import * as fs from 'fs';

export interface FollowOptions {
  /** Poll interval in milliseconds (default 500). */
  intervalMs?: number;
  /** Start at the current end of file (skip existing content). Default false. */
  fromEnd?: boolean;
}

export function followFile(
  filePath: string,
  onChunk: (text: string) => void,
  opts: FollowOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 500;
  let pos = 0;

  if (opts.fromEnd) {
    try { pos = fs.statSync(filePath).size; } catch { pos = 0; }
  } else {
    try {
      const initial = fs.readFileSync(filePath);
      if (initial.length > 0) onChunk(initial.toString('utf-8'));
      pos = initial.length;
    } catch { /* file may not exist yet — start at 0 and wait for it to appear */ }
  }

  const poll = () => {
    let size: number;
    try { size = fs.statSync(filePath).size; } catch { return; /* gone / not yet created */ }
    if (size < pos) pos = 0; // truncated or rotated — re-read from the top
    if (size <= pos) return;

    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(size - pos);
      const bytes = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += bytes;
      if (bytes > 0) onChunk(buf.subarray(0, bytes).toString('utf-8'));
    } catch { /* transient read error — retry next tick */ } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } }
    }
  };

  const timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
}
