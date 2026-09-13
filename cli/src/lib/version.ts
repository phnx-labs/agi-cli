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

/**
 * Well-known locations of the `agents` launcher for PATH-less GUI/launchd
 * processes (the menu-bar helper inherits no login PATH). Also the anchor for
 * recovering the on-disk install layout when the CLI runs as a Bun single-file
 * binary — see {@link resolveInstalledLayout}.
 */
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

/**
 * Pure derivation (no I/O) of an install's on-disk layout from the realpath of
 * its `agents` launcher. A launcher lives at `<pkg>/dist/bin/agents`, so two
 * levels up is `<pkg>/dist`. Exported for unit testing so the dirname chain the
 * Bun-binary fallback depends on stays locked.
 */
export function installLayoutFromBin(realBin: string): InstallLayout {
  const distDir = path.dirname(path.dirname(realBin)); // <pkg>/dist/bin/agents -> <pkg>/dist
  return {
    distDir,
    entryPath: path.join(distDir, 'index.js'),
    pkgJsonPath: path.join(distDir, '..', 'package.json'),
  };
}

/**
 * Resolve the on-disk install layout of the running CLI by following the
 * `agents` launcher symlink.
 *
 * When the CLI runs as a Bun single-file executable, `import.meta.url` points
 * inside the virtual bundle (`/$bunfs/…`), so sibling-relative resolution can't
 * see the shipped `package.json`, `dist/index.js`, or `MenubarHelper.app` on
 * disk. The launcher symlink points at the real files; walk up from it. Returns
 * null when no launcher is found (dev/tsx runs, or a box without the helper) —
 * callers keep their in-bundle resolution as the primary path and use this only
 * as the fallback.
 */
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

/**
 * Resolve the CLI version from the shipping package.json. Used by the daemon
 * to answer `IPCAction: 'version'` and by the client to detect daemon drift —
 * a dev-build CLI talking to a launchd-managed registry daemon would silently
 * get stale behavior without this check.
 *
 * Primary read is relative to this module; when that fails (the Bun single-file
 * binary can't read its own bundled package.json), fall back to the on-disk
 * install found via the launcher symlink so callers like the menu bar don't see
 * a bogus `unknown`.
 *
 * `pkgJsonPath` is an optional override of the shipping package.json path,
 * accepted by both this function and {@link getCliVersionFresh}. Every
 * production call site uses the zero-argument form and gets the real on-disk
 * path below; the parameter exists only so a unit test can point both
 * functions at a fixture package.json instead of the real one shared by every
 * parallel test fork.
 */
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

/**
 * Read the version from package.json on disk every call, bypassing the cache.
 *
 * `getCliVersion()` memoizes the version a long-running process *started* with.
 * After `npm i -g` overwrites the install in place, the on-disk package.json
 * changes but the running process keeps its old in-memory code. Comparing this
 * fresh read against the cached startup value is how a daemon/broker detects it
 * is now stale and should reload onto the new code (self-healing). Returns
 * 'unknown' on any error.
 */
export function getCliVersionFresh(
  pkgJsonPath: string = path.join(__dirname, '..', '..', 'package.json')
): string {
  return readVersionAt(pkgJsonPath) ?? readInstalledPackageVersion() ?? 'unknown';
}
