
import * as fs from 'fs';
import * as path from 'path';

const RESOURCE_CONTENT_IGNORE = new Set([
  '.DS_Store',
  '.git',
  '.gitignore',
  '.venv',
  '__pycache__',
  'node_modules',
]);

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

export function filesContentMatch(a: string, b: string): boolean {
  const ab = readSafe(a);
  const bb = readSafe(b);
  if (ab == null || bb == null) return false;
  if (ab.equals(bb)) return true;
  return normalizeResourceContent(ab.toString('utf-8')) === normalizeResourceContent(bb.toString('utf-8'));
}

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
