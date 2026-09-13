/**
 * Shared content comparison for the resource-diff engine.
 *
 * `agents doctor` (and the plugin-drift describer) reconcile a version home's
 * copy of a resource against its resolved source by comparing bytes. Two shapes
 * of resource need it: a single file (a command, a rule, a transformed subagent)
 * and a whole directory tree (a skill, a plugin mirror, a copied workflow).
 * Both live here so every kind's differ shares ONE normalize rule, ONE ignore
 * set, and ONE symlink-skip policy instead of re-deriving them (the duplication
 * `doctor-diff.ts`'s `dirsContentMatch` had before PHNX-3504; the parallel
 * `skillDirsMatch` copies in `versions.ts` / `detectors/skills.ts` are a separate
 * follow-up cleanup so this change stays inside the fast-lane CI impact budget).
 *
 * Normalize: CRLF → LF and trim, so a trailing-newline / line-ending difference
 * between two independently-written trees is not reported as content drift. This
 * mirrors the byte compare `diffCommands` / `diffRules` already apply per file.
 */

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

function readSafe(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * True when two files exist and their normalized content is identical. A missing
 * or unreadable file on either side is a mismatch (never a silent match).
 */
export function filesContentMatch(a: string, b: string): boolean {
  const ac = readSafe(a);
  const bc = readSafe(b);
  if (ac == null || bc == null) return false;
  return normalizeResourceContent(ac) === normalizeResourceContent(bc);
}

/**
 * True when two directory trees hold the same set of names and every file under
 * them matches by normalized content. Symlinks and ignored entries are skipped
 * on both sides; a name present on one side only, or a file/dir type mismatch,
 * is a mismatch. An unreadable directory on either side is a mismatch.
 */
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
