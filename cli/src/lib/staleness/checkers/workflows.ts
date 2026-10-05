
import * as fs from 'fs';
import * as path from 'path';
import { firstWinsLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintDir, isDirStale } from '../fingerprint.js';
import type { DirEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function isWorkflowDir(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'WORKFLOW.md'));
  } catch { return false; }
}

export const workflowsChecker: TypedResourceChecker<DirEntry> = {
  type: 'workflows',

  listNames(cwd) {
    return listAcrossLayers(firstWinsLayers(cwd), 'workflows', (_, full) => isWorkflowDir(full));
  },

  build(name, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('workflows', name),
      isWorkflowDir
    );
    if (!resolved) return null;
    return { dirPath: resolved.path, files: fingerprintDir(resolved.path) };
  },

  isFresh(name, stored, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('workflows', name),
      isWorkflowDir
    );
    if (!resolved) return false;
    return !isDirStale(stored.dirPath, stored.files, resolved.path);
  },
};
