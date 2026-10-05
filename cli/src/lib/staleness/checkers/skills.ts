
import * as fs from 'fs';
import * as path from 'path';
import { firstWinsLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintDir, isDirStale } from '../fingerprint.js';
import type { DirEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

function isSkillDir(full: string): boolean {
  try {
    return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'SKILL.md'));
  } catch { return false; }
}

export const skillsChecker: TypedResourceChecker<DirEntry> = {
  type: 'skills',

  listNames(cwd) {
    return listAcrossLayers(firstWinsLayers(cwd), 'skills', (_, full) => isSkillDir(full));
  },

  build(name, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('skills', name),
      isSkillDir
    );
    if (!resolved) return null;
    return { dirPath: resolved.path, files: fingerprintDir(resolved.path) };
  },

  isFresh(name, stored, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('skills', name),
      isSkillDir
    );
    if (!resolved) return false;
    return !isDirStale(stored.dirPath, stored.files, resolved.path);
  },
};
