
import * as fs from 'fs';
import * as path from 'path';
import { hookLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import type { FileEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

const NON_SCRIPT_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
]);

const SCRIPT_EXTENSIONS = new Set([
  '.sh', '.bash', '.zsh',
  '.py', '.js', '.ts', '.mjs', '.cjs',
  '.rb', '.pl', '.ps1',
]);

function isHookScript(full: string): boolean {


  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return false;
    const ext = path.extname(full).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(ext)) return true;
    if ((stat.mode & 0o111) === 0) return false;
    return !NON_SCRIPT_EXTENSIONS.has(ext);
  } catch { return false; }
}

export const hooksChecker: TypedResourceChecker<FileEntry> = {
  type: 'hooks',

  listNames(_cwd) {
    return listAcrossLayers(hookLayers(), 'hooks', (_, full) => isHookScript(full));
  },

  build(name, _cwd) {
    const resolved = resolveByName(
      hookLayers(),
      path.join('hooks', name),
      isHookScript
    );
    if (!resolved) return null;
    const fp = fingerprintFile(resolved.path);
    return fp ? { source: fp } : null;
  },

  isFresh(name, stored, _cwd) {
    const resolved = resolveByName(
      hookLayers(),
      path.join('hooks', name),
      isHookScript
    );
    if (!resolved) return false;
    return !isFileStale(stored.source, resolved.path);
  },
};
