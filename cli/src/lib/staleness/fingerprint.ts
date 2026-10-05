
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface Fingerprint {
  path:   string;
  mtime:  number;
  size:   number;
  sha256: string;
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function fingerprintFile(filePath: string): Fingerprint | null {
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { path: filePath, mtime: stat.mtimeMs, size: stat.size, sha256: sha256(content) };
  } catch {
    return null;
  }
}

// This mirrors copy-time noise exclusions; it is deliberately not a blanket dotfile rule
// because .claude-plugin/plugin.json is meaningful input.
const FINGERPRINT_SKIP = new Set([
  '.DS_Store',
  '.git',
  '.gitignore',
  '.venv',
  '__pycache__',
  'node_modules',
]);

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

export function isFileStale(stored: Fingerprint, currentPath: string): boolean {
  if (stored.path !== currentPath) return true;
  try {
    const stat = fs.statSync(currentPath);
    // Keep the hot path stat-only and pay for SHA only after metadata changes.
    if (stat.mtimeMs === stored.mtime && stat.size === stored.size) return false;
    return sha256(fs.readFileSync(currentPath, 'utf-8')) !== stored.sha256;
  } catch {
    return true;
  }
}

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

// Must share the skip set and sorted absolute-path order with fingerprintDir.
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

export function nameSetDiffers(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.some((n, i) => n !== sortedB[i]);
}
