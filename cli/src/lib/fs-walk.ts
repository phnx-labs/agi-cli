import * as fs from 'fs';
import * as path from 'path';

/** Recursively visits files with a given extension, calling onFile with path and mtime. Uses
 * readdir dirent types so only matching files (and symlinks, to preserve follow semantics) pay
 * a stat; on large session trees this roughly halves syscalls. */
function walkEntries(dir: string, ext: string, onFile: (filePath: string, mtimeMs: number, size: number) => void): void {
  function walk(d: string, depth: number) {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(d, entry.name);
      let isDirectory = entry.isDirectory();

      // Symlinks: dirent reports the link itself, but the previous stat-based
      // walk followed links into directories and matched linked files. Stat
      // (which follows) only for symlinks to keep that behavior.
      if (entry.isSymbolicLink()) {
        const stat = safeStatSync(full);
        if (!stat) continue;
        isDirectory = stat.isDirectory();
      }

      if (isDirectory) {
        walk(full, depth + 1);
      } else if (entry.name.endsWith(ext)) {
        const stat = safeStatSync(full);
        if (stat) onFile(full, stat.mtimeMs, stat.size);
      }
    }
  }

  walk(dir, 0);
}

/** A file surfaced by the walk, carrying the mtime+size from the walk's own stat. */
interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

/** Walks a directory for files with an extension, newest first, keeping each match's mtime and
 * size from the walk's own stat so callers comparing against the scan ledger skip a second stat
 * per file (Codex/Droid/routine scans). */
export function walkForFilesWithStat(dir: string, ext: string, limit: number): WalkedFile[] {
  const results: WalkedFile[] = [];
  walkEntries(dir, ext, (filePath, mtimeMs, size) => {
    results.push({ path: filePath, mtimeMs, size });
  });

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

/** Walk a directory recursively for files with a given extension, newest first. */
export function walkForFiles(dir: string, ext: string, limit: number): string[] {
  return walkForFilesWithStat(dir, ext, limit).map(r => r.path);
}

/** Newest mtime (ms) among files with the given extension, or null. Single pass tracking the
 * max, with no collection or sort; hot path for the `agents run` account-recency probe. */
export function latestFileMtimeMs(dir: string, ext: string): number | null {
  let latest: number | null = null;
  walkEntries(dir, ext, (_filePath, mtimeMs) => {
    if (latest === null || mtimeMs > latest) latest = mtimeMs;
  });
  return latest;
}

function safeStatSync(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
