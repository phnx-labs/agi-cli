import * as fs from 'fs';

export interface FollowOptions {
  intervalMs?: number;
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
    } catch {  }
  }

  const poll = () => {
    let size: number;
    try { size = fs.statSync(filePath).size; } catch { return;  }
    if (size < pos) pos = 0;
    if (size <= pos) return;

    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(size - pos);
      const bytes = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += bytes;
      if (bytes > 0) onChunk(buf.subarray(0, bytes).toString('utf-8'));
    } catch {  } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {  } }
    }
  };

  const timer = setInterval(poll, intervalMs);
  return () => clearInterval(timer);
}
