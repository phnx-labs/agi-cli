/** The on-disk browser layout the consumer reads. browser-cli keeps every path the in-repo
 * subsystem used (contract §4), so `agents browser sessions` and the feed's tool rows read
 * captures straight off disk. Profile data may sit under a composite dir (`<profile>@<endpoint>`). */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { getBrowserRuntimeDir as getBrowserRuntimeDirRoot } from '../state.js';

export { getBrowserDurableDir } from '../state.js';

/** Root of the browser runtime cache — `~/.agents/.cache/browser/`. */
export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

/** The runtime cache dir for one profile's bare name. */
export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

/** The profile a runtime-cache dir key belongs to: `<profile>`, `<profile>@<endpoint>` or
 * `<profile>@<endpoint>.<fork>`. A profile name may contain `@` (`me@work`), so split on the last
 * one. */
function profileOfCacheKey(key: string): string {
  const at = key.lastIndexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/** Every runtime-cache dir belonging to a profile, composite forms included; empty if the root is
 * missing. */
export function listProfileCacheDirs(profileName: string): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (profileOfCacheKey(entry) === profileName) matches.push(path.join(root, entry));
  }
  return matches;
}
