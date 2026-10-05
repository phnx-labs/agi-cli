/** Hooks staleness: one executable file per hook. The project layer is excluded by design: a cloned
 * repo's `.agents/hooks/foo` must not plant a hook that fires on the next agent run (see
 * `versions.ts:1832-1836`). */

import * as fs from 'fs';
import * as path from 'path';
import { hookLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import type { FileEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

/** Extensions that are NEVER hooks — docs, configuration, plain data. */
const NON_SCRIPT_EXTENSIONS = new Set([
  '.md', '.markdown', '.rst', '.txt',
  '.yaml', '.yml', '.json', '.toml', '.ini', '.conf',
]);

/** Extensions that explicitly mark a file as a script regardless of exec bit. */
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
    // Otherwise require exec bit AND a non-data extension. Older sync runs
    // chmod 0o755'd everything including `promptcuts.yaml` / `README.md`,
    // so exec bit alone can't be trusted.
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
