import * as fs from 'fs';
import * as path from 'path';

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

interface WalkedFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export function walkForFilesWithStat(dir: string, ext: string, limit: number): WalkedFile[] {
  const results: WalkedFile[] = [];
  walkEntries(dir, ext, (filePath, mtimeMs, size) => {
    results.push({ path: filePath, mtimeMs, size });
  });

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}

export function walkForFiles(dir: string, ext: string, limit: number): string[] {
  return walkForFilesWithStat(dir, ext, limit).map(r => r.path);
}

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
