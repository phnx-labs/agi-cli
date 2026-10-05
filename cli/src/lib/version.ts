import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cached: string | null = null;

/** Read a `version` string from a package.json, or null if unreadable. */
function readVersionAt(pkgPath: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return String(pkg.version || '') || null;
  } catch {
    return null;
  }
}

/** Well-known `agents` launcher locations for PATH-less GUI/launchd processes (the menu-bar helper),
 * and the anchor for recovering the install layout in a Bun binary (`resolveInstalledLayout`). */
export function resolveAgentsBin(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'agents'),
    '/opt/homebrew/bin/agents',
    '/usr/local/bin/agents',
    path.join(home, '.npm-global', 'bin', 'agents'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

interface InstallLayout {
  /** The install's `dist/` directory (holds `index.js` + `lib/`). */
  distDir: string;
  /** The compiled CLI entry, `dist/index.js`. */
  entryPath: string;
  /** The shipping `package.json`, `dist/../package.json`. */
  pkgJsonPath: string;
}

/** Pure derivation of the install layout from the launcher's realpath (`<pkg>/dist/bin/agents`, two
 * levels up is `<pkg>/dist`); exported so the Bun-binary fallback's dirname chain stays tested. */
export function installLayoutFromBin(realBin: string): InstallLayout {
  const distDir = path.dirname(path.dirname(realBin)); // <pkg>/dist/bin/agents -> <pkg>/dist
  return {
    distDir,
    entryPath: path.join(distDir, 'index.js'),
    pkgJsonPath: path.join(distDir, '..', 'package.json'),
  };
}

/** Resolve the install layout via the `agents` launcher symlink: in a Bun single-file binary
 * `import.meta.url` is `/$bunfs/...` and cannot see `package.json`, `dist/index.js` or
 * `MenubarHelper.app`. Null when no launcher; fallback only. */
export function resolveInstalledLayout(): InstallLayout | null {
  const bin = resolveAgentsBin();
  if (!bin) return null;
  try {
    const layout = installLayoutFromBin(fs.realpathSync(bin));
    // Validate we landed on a real dist (guards an unexpected launcher layout).
    if (fs.existsSync(layout.entryPath)) return layout;
  } catch {
    /* ignore */
  }
  return null;
}

/** Resolve the CLI version from the shipping package.json; the daemon answers IPC `version` with it
 * and clients detect daemon drift. A Bun binary cannot read it, so it falls back via the launcher
 * symlink. `pkgJsonPath` exists only for unit tests. */
export function getCliVersion(
  pkgJsonPath: string = path.join(__dirname, '..', '..', 'package.json')
): string {
  if (cached) return cached;
  cached = readVersionAt(pkgJsonPath) ?? readInstalledPackageVersion() ?? 'unknown';
  return cached;
}

/** Version from the on-disk install (Bun-binary fallback). */
function readInstalledPackageVersion(): string | null {
  const layout = resolveInstalledLayout();
  return layout ? readVersionAt(layout.pkgJsonPath) : null;
}

/** Read the version from package.json on every call, bypassing the cache. After `npm i -g`
 * overwrites the install, comparing it with the startup `getCliVersion()` tells a daemon it is
 * stale and should reload. 'unknown' on error. */
export function getCliVersionFresh(
  pkgJsonPath: string = path.join(__dirname, '..', '..', 'package.json')
): string {
  return readVersionAt(pkgJsonPath) ?? readInstalledPackageVersion() ?? 'unknown';
}
