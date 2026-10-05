/** File and directory fingerprinting shared by every resource checker. Two tiers: stat
 * (mtime+size) on the hot path, sha256 only on miss. */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/** Fingerprint of a single source file. */
export interface Fingerprint {
  path:   string;   // absolute source path at fingerprint time
  mtime:  number;   // stat.mtimeMs
  size:   number;   // stat.size in bytes
  sha256: string;   // hex digest of file contents
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** Fingerprint a single file. Returns null when the file is unreadable. */
export function fingerprintFile(filePath: string): Fingerprint | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, mtime: stat.mtimeMs, size: stat.size, sha256: sha256(content) };
  } catch {
    return null;
  }
}

/** Names never fingerprinted: OS metadata, VCS bookkeeping, dep caches, build outputs (matches the
 * writer's SKILL_COPY_IGNORE in `versions.ts`). Not a blanket dot-prefix skip: that would hide
 * `.claude-plugin/plugin.json` and silently break plugin staleness. */
const FINGERPRINT_SKIP = new Set([
  '.DS_Store',
  '.git',
  '.gitignore',
  '.venv',
  '__pycache__',
  'node_modules',
]);

/** Fingerprint all files in a directory recursively, sorted by absolute path for deterministic
 * order. Noise entries (`FINGERPRINT_SKIP`) are excluded. */
export function fingerprintDir(dirPath: string): Fingerprint[] {
  const results: Fingerprint[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (FINGERPRINT_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const fp = fingerprintFile(full);
        if (fp) results.push(fp);
      }
    }
  }
  walk(dirPath);
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return results;
}

/** Hot-path file staleness: stat-only when mtime+size match, sha256 on miss. */
export function isFileStale(stored: Fingerprint, currentPath: string): boolean {
  if (stored.path !== currentPath) return true;
  try {
    const stat = fs.statSync(currentPath);
    if (stat.mtimeMs === stored.mtime && stat.size === stored.size) return false;
    return sha256(fs.readFileSync(currentPath, 'utf-8')) !== stored.sha256;
  } catch {
    return true;
  }
}

/** Hot-path directory staleness: compare sorted paths first (add/remove/rename), then stat each
 * file, and sha256 only on stat mismatch. */
export function isDirStale(storedDirPath: string, storedFiles: Fingerprint[], currentDirPath: string): boolean {
  if (storedDirPath !== currentDirPath) return true;
  const currentPaths = walkDirPaths(currentDirPath);
  if (currentPaths.length !== storedFiles.length) return true;
  for (let i = 0; i < currentPaths.length; i++) {
    const stored = storedFiles[i];
    const cur = currentPaths[i];
    if (stored.path !== cur) return true;
    try {
      const stat = fs.statSync(cur);
      if (stat.mtimeMs === stored.mtime && stat.size === stored.size) continue;
      if (sha256(fs.readFileSync(cur, 'utf-8')) !== stored.sha256) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Walk a directory and return sorted absolute paths of every regular file, no content reads. Uses
 * the same FINGERPRINT_SKIP as `fingerprintDir` so both produce the same path set, which the
 * dir-stale comparison requires. */
function walkDirPaths(dirPath: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (FINGERPRINT_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) results.push(full);
    }
  }
  walk(dirPath);
  results.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return results;
}

/** True if two sorted-or-unsorted name sets differ. */
export function nameSetDiffers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.some((n, i) => n !== sortedB[i]);
}
