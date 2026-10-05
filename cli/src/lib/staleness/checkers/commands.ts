/** Commands staleness: one `.md` file per command, first-wins across project > user > system >
 * extras. */

import * as fs from 'fs';
import * as path from 'path';
import { firstWinsLayers, listAcrossLayers, resolveByName } from '../layers.js';
import { fingerprintFile, isFileStale } from '../fingerprint.js';
import type { FileEntry } from '../types.js';
import type { TypedResourceChecker } from './types.js';

export const commandsChecker: TypedResourceChecker<FileEntry> = {
  type: 'commands',

  listNames(cwd) {
    return listAcrossLayers(
      firstWinsLayers(cwd),
      'commands',
      (name) => name.endsWith('.md')
    ).map((n) => n.replace(/\.md$/, ''));
  },

  build(name, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('commands', `${name}.md`),
      (p) => fs.existsSync(p)
    );
    if (!resolved) return null;
    const fp = fingerprintFile(resolved.path);
    return fp ? { source: fp } : null;
  },

  isFresh(name, stored, cwd) {
    const resolved = resolveByName(
      firstWinsLayers(cwd),
      path.join('commands', `${name}.md`),
      (p) => fs.existsSync(p)
    );
    if (!resolved) return false;
    return !isFileStale(stored.source, resolved.path);
  },
};
