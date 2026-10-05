/** Shared content comparison for the resource-diff engine, for single files and whole directory
 * trees, so every kind's differ shares ONE normalize rule, ignore set and symlink-skip policy
 * (PHNX-3504). Normalize CRLF to LF and trim, so line-ending differences aren't drift. */

import * as fs from 'fs';
import * as path from 'path';

/** OS metadata / local tooling that is never synced into a version home. */
const RESOURCE_CONTENT_IGNORE = new Set([
  '.DS_Store',
  '.git',
  '.gitignore',
  '.venv',
  '__pycache__',
  'node_modules',
]);

/** CRLF → LF and trim, so line-ending / trailing-newline skew is not drift. */
export function normalizeResourceContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function readSafe(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** True when two files exist with identical normalized content; a missing or unreadable file is a
 * mismatch. Identical bytes match without decoding, so binary assets never go through the
 * normalizer. */
export function filesContentMatch(a: string, b: string): boolean {
  const ab = readSafe(a);
  const bb = readSafe(b);
  if (ab == null || bb == null) return false;
  if (ab.equals(bb)) return true;
  return normalizeResourceContent(ab.toString('utf-8')) === normalizeResourceContent(bb.toString('utf-8'));
}

/** True when two directory trees hold the same names and every file matches by normalized content;
 * symlinks and ignored entries are skipped on both sides, and name, type or unreadable-directory
 * differences are mismatches. */
export function dirsContentMatch(src: string, dst: string): boolean {
  const srcEntries = (() => {
    try { return fs.readdirSync(src, { withFileTypes: true }); } catch { return null; }
  })();
  const dstEntries = (() => {
    try { return fs.readdirSync(dst, { withFileTypes: true }); } catch { return null; }
  })();
  if (!srcEntries || !dstEntries) return false;

  const filter = (es: fs.Dirent[]) =>
    es
      .filter((e) => !e.isSymbolicLink() && !RESOURCE_CONTENT_IGNORE.has(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
  const srcF = filter(srcEntries);
  const dstF = filter(dstEntries);
  if (srcF.length !== dstF.length) return false;
  for (let i = 0; i < srcF.length; i++) {
    if (srcF[i].name !== dstF[i].name) return false;
    const a = path.join(src, srcF[i].name);
    const b = path.join(dst, dstF[i].name);
    if (srcF[i].isDirectory()) {
      if (!dstF[i].isDirectory()) return false;
      if (!dirsContentMatch(a, b)) return false;
    } else if (srcF[i].isFile()) {
      if (!dstF[i].isFile()) return false;
      if (!filesContentMatch(a, b)) return false;
    }
  }
  return true;
}
