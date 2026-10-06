
import * as path from 'node:path';
import * as fs from 'node:fs';
import { getBrowserRuntimeDir as getBrowserRuntimeDirRoot } from '../state.js';

export { getBrowserDurableDir } from '../state.js';

export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

export function profileOfCacheKey(key: string): string {
  const at = key.lastIndexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

export function listProfileCacheDirs(profileName: string): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (profileOfCacheKey(entry) === profileName) matches.push(path.join(root, entry));
  }
  return matches;
}
