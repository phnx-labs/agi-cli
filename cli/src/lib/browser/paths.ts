/**
 * paths.ts — the on-disk browser layout the CONSUMER still reads.
 *
 * browser-cli owns the browser process, drivers and IPC, but it keeps every
 * on-disk path the in-repo subsystem used (integration contract §4). So
 * `agents browser sessions` (`sessions-list.ts`) and the feed's browser tool
 * rows (`feed/tool-activity.ts`) read a profile's captures straight off disk —
 * no daemon, no engine — and need just these path helpers. They were the pure
 * path corner of the deleted `profiles.ts` / `runtime-state.ts` engine files.
 *
 * A profile's live tasks and captures may live under a COMPOSITE runtime dir
 * (`<profile>@<endpoint>`, `<profile>@<endpoint>.<fork>`), not the bare
 * `<profile>` dir, so `listProfileCacheDirs` matches every dir that belongs to a
 * profile — the same last-`@` rule browser-cli names them with.
 */

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

/**
 * The profile a runtime-cache dir key belongs to. browser-cli keys a dir as
 * `<profile>`, `<profile>@<endpoint>`, or `<profile>@<endpoint>.<fork>`. The
 * profile name may itself contain `@` (`me@work`), so split on the LAST one.
 */
function profileOfCacheKey(key: string): string {
  const at = key.lastIndexOf('@');
  return at === -1 ? key : key.slice(0, at);
}

/**
 * Every runtime-cache dir that belongs to a profile, composite forms included.
 * Empty when the root does not exist yet.
 */
export function listProfileCacheDirs(profileName: string): string[] {
  const root = getBrowserRuntimeDir();
  if (!fs.existsSync(root)) return [];
  const matches: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (profileOfCacheKey(entry) === profileName) matches.push(path.join(root, entry));
  }
  return matches;
}
