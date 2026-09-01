/**
 * Self-update install plumbing.
 *
 * The hard requirement: an upgrade must replace the copy that is currently
 * running. A bare `npm install -g` writes into the global prefix of whatever
 * `npm` PATH happens to resolve — on machines with more than one node
 * installation (nvm + Homebrew + vendored runtimes) that prefix can belong to
 * a different node than the one this copy lives under. The install then
 * "succeeds" while the running copy stays stale and re-prompts forever.
 *
 * So every step here is anchored to the running package root on disk, never
 * to PATH resolution.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { spawnSync } from 'child_process';
// Leaf comparator only — do not pull the full versions.ts graph into every
// bootstrap that imports self-update (RUSH-2331).
import { compareVersions } from './agent-spec/primitives.js';
import { needsWindowsShell } from './platform/index.js';

export const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

/**
 * First published release that stopped the usage/auth-health probe from reading
 * Claude Code's interactive login (commit 3f3554c51). Pre-this versions on a
 * macOS box re-introduce the Touch ID storm + fleet-wide revocation class
 * (RUSH-2415 / RUSH-1822). Anything older is a latent regression while a fixed
 * copy sits next to it.
 */
export const TOUCH_ID_STORM_FIXED_SINCE = '1.22.30';

export type PackageManager = 'npm' | 'bun';

/**
 * The directory bun installs global packages into:
 *   <BUN_INSTALL>/install/global   (BUN_INSTALL defaults to ~/.bun)
 *
 * A globally-installed scoped package then lives at
 * `<bunGlobalDir>/node_modules/@phnx-labs/agents-cli` — note there is NO `lib`
 * segment, unlike npm's POSIX layout. That single difference is why an
 * npm-based upgrade silently misses a bun install (see deriveGlobalPrefix).
 */
export function bunGlobalDir(): string {
  const bunInstall = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  return path.join(bunInstall, 'install', 'global');
}

/**
 * Identify which package manager owns the install at `packageRoot`, so the
 * upgrade can shell out to the one that actually replaces this copy.
 *
 * bun lays a global package out as `<bunGlobalDir>/node_modules/<scoped pkg>`,
 * so the prefix (the parent of `node_modules`) is the bun global dir itself.
 * Everything else — npm's `<prefix>/lib/node_modules` and the Windows
 * `<prefix>/node_modules` — is treated as npm.
 *
 * Detection is path-based (no subprocess): it matches the resolved bun global
 * dir from BUN_INSTALL/$HOME, and falls back to the structural `.bun/install/
 * global` tail for a relocated BUN_INSTALL not exported into this process.
 */
export function detectPackageManager(packageRoot: string): PackageManager {
  const resolved = path.resolve(packageRoot);
  const prefix = path.dirname(path.dirname(path.dirname(resolved))); // strip <scope>/<pkg>/node_modules
  if (prefix === path.resolve(bunGlobalDir())) return 'bun';
  const parts = prefix.split(path.sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 1] === 'global' && parts[n - 2] === 'install' && parts[n - 3] === '.bun') {
    return 'bun';
  }
  return 'npm';
}

/** The shell command a user can run by hand to reproduce the upgrade for `manager`. */
function manualInstallHint(manager: PackageManager, packageRoot: string, spec: string): string {
  if (manager === 'bun') return `bun add -g ${spec}`;
  return `npm install -g --prefix ${deriveGlobalPrefix(packageRoot)} ${spec}`;
}

export interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string;
  dismissed?: string;
}

/** Read the cached update-check state from disk. Returns null if the file is missing or corrupt. */
export function readUpdateCache(file: string): UpdateCheckCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    /* cache file missing or corrupt */
    return null;
  }
}

/**
 * Persist the latest known version and current timestamp. Preserves an
 * existing `dismissed` marker — the background refresh must not erase a
 * user's "Skip this version" choice, or they get re-prompted for the exact
 * version they dismissed.
 */
export function saveUpdateCheck(file: string, latestVersion: string): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dismissed = readUpdateCache(file)?.dismissed;
    fs.writeFileSync(
      file,
      JSON.stringify({ lastCheck: Date.now(), latestVersion, ...(dismissed ? { dismissed } : {}) }),
    );
  } catch {
    /* best-effort cache update */
  }
}

/** Record that the user chose to skip `version`; suppresses prompts until a newer version appears. */
export function dismissUpdateVersion(file: string, version: string): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = readUpdateCache(file);
    fs.writeFileSync(
      file,
      JSON.stringify({
        lastCheck: existing?.lastCheck ?? Date.now(),
        latestVersion: version,
        dismissed: version,
      }),
    );
  } catch {
    /* best-effort */
  }
}

/** Whether the cached state warrants an upgrade prompt for a copy running `currentVersion`. */
export function shouldPromptUpgrade(cache: UpdateCheckCache | null, currentVersion: string): boolean {
  if (!cache?.latestVersion) return false;
  return (
    cache.latestVersion !== currentVersion &&
    compareVersions(cache.latestVersion, currentVersion) > 0 &&
    cache.latestVersion !== cache.dismissed
  );
}

/**
 * Short TTL for the multi-install PATH scan cache (RUSH-2324). The full
 * `findAgentsCliInstalls` walk over PATH + known roots costs ~1ms on a warm
 * box and runs on every ordinary CLI invocation via `maybeWarnMultiInstall`.
 * Same 5-minute window as the detached-sync spawn gate so both bootstrap
 * savings share one recency policy.
 */
export const MULTI_INSTALL_SCAN_TTL_MS = 5 * 60 * 1000;

/** On-disk shape for the multi-install scan cache (beside `.update-check`). */
export interface MultiInstallScanCache {
  scannedAt: number;
  /** Full PATH string at scan time — any change invalidates the cache. */
  pathEnv: string;
  runningRoot: string;
  runningVersion: string;
  inventory: MultiInstallInventoryEntry[];
}

/** Read a multi-install scan cache. Returns null if missing or corrupt. */
export function readMultiInstallScanCache(file: string): MultiInstallScanCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<MultiInstallScanCache>;
    if (
      typeof raw.scannedAt !== 'number' ||
      typeof raw.pathEnv !== 'string' ||
      typeof raw.runningRoot !== 'string' ||
      typeof raw.runningVersion !== 'string' ||
      !Array.isArray(raw.inventory)
    ) {
      return null;
    }
    // A cache written before the entries carried running/autoPurgeable
    // (RUSH-2705) cannot drive the banner's remedy choice — treat it as
    // corrupt so the caller re-scans rather than mis-advertising --fix.
    const entries = raw.inventory as Array<Partial<MultiInstallInventoryEntry>>;
    if (entries.some(
      (entry) => typeof entry?.running !== 'boolean' || typeof entry?.autoPurgeable !== 'boolean',
    )) {
      return null;
    }
    return raw as MultiInstallScanCache;
  } catch {
    return null;
  }
}

/** Persist a multi-install scan result. Best-effort. */
export function writeMultiInstallScanCache(file: string, cache: MultiInstallScanCache): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {
    /* best-effort */
  }
}

/**
 * Whether a multi-install scan cache is still usable for this invocation.
 * Invalid when missing, past TTL, PATH changed, or the running copy identity
 * (root / version) changed — those are exactly the cases where a re-scan can
 * surface a different inventory and re-fire the warning.
 */
export function isMultiInstallScanFresh(
  cache: MultiInstallScanCache | null,
  pathEnv: string,
  runningRoot: string,
  runningVersion: string,
  now: number = Date.now(),
  ttlMs: number = MULTI_INSTALL_SCAN_TTL_MS,
): boolean {
  if (!cache) return false;
  if (now - cache.scannedAt >= ttlMs) return false;
  if (cache.pathEnv !== pathEnv) return false;
  if (cache.runningRoot !== runningRoot) return false;
  if (cache.runningVersion !== runningVersion) return false;
  return true;
}

/**
 * Resolve the multi-install inventory, hitting the on-disk scan cache when
 * fresh. Callers that only need the inventory (the bootstrap multi-install
 * warning) avoid the ~1ms PATH walk on the warm path (RUSH-2324).
 */
export function resolveMultiInstallInventory(
  runningRoot: string,
  runningVersion: string,
  pathEnv: string,
  cacheFile: string,
  opts: {
    now?: number;
    ttlMs?: number;
    findOpts?: FindAgentsCliInstallsOptions;
  } = {},
): MultiInstallInventoryEntry[] {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? MULTI_INSTALL_SCAN_TTL_MS;
  const cached = readMultiInstallScanCache(cacheFile);
  if (isMultiInstallScanFresh(cached, pathEnv, runningRoot, runningVersion, now, ttlMs)) {
    return cached!.inventory;
  }
  const inventory = buildMultiInstallInventory(
    runningRoot,
    runningVersion,
    findAgentsCliInstalls(pathEnv, opts.findOpts),
  );
  writeMultiInstallScanCache(cacheFile, {
    scannedAt: now,
    pathEnv,
    runningRoot,
    runningVersion,
    inventory,
  });
  return inventory;
}

/**
 * Whether `p` is Bun's embedded virtual filesystem — where a standalone
 * executable exposes its bundled sources. Nothing there exists on disk: it
 * cannot be stat'd, installed into, or compared against a real install path.
 *
 * Matches the root itself (`/$bunfs`) as well as paths under it, because
 * `<__dirname>/..` from the embedded entry produces exactly that bare root.
 * daemon.ts carries a narrower under-the-root-only guard for deciding what may
 * be supervised; the two are deliberately not shared.
 */
function isBunVirtualPath(p: string): boolean {
  return /(^|[/\\])\$bunfs([/\\]|$)/.test(p);
}

/** Whether `dir` is the root of an installed copy of this package. */
function isPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return pkg.name === NPM_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * The on-disk package root of the copy that is currently running.
 *
 * For a plain JS install this is just `<__dirname>/..`. Under the compiled
 * standalone binary (shipped since 1.20.53) it is not: Bun sets `__dirname` to
 * its embedded virtual FS, so `<__dirname>/..` yields `/$bunfs` — a path that
 * exists nowhere. That phantom value was reported as a second install by the
 * multi-install check, and rejected by deriveGlobalPrefix as "not an
 * npm-managed install", so every self-upgrade from a compiled copy failed.
 *
 * The physical executable is `process.execPath`, which ships inside the
 * package (`<packageRoot>/dist/bin/agents`). Walk up from it to the directory
 * whose package.json actually names this package rather than assuming a fixed
 * depth, so a change to the dist layout surfaces as a clear throw here instead
 * of a wrong prefix that npm would happily install into.
 */
export function resolveRunningPackageRoot(
  dirname: string,
  execPath: string = process.execPath,
): string {
  const fromDirname = path.resolve(dirname, '..');
  if (!isBunVirtualPath(fromDirname)) return fromDirname;

  if (!execPath || isBunVirtualPath(execPath)) {
    throw new Error(
      `Cannot locate the running agents-cli install: __dirname is the Bun virtual path ${fromDirname} ` +
        `and process.execPath (${execPath || '(empty)'}) is not a real file. ` +
        `Reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }

  let dir = path.dirname(path.resolve(execPath));
  for (;;) {
    if (isPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Cannot locate the running agents-cli install: no ${NPM_PACKAGE_NAME} package.json above ` +
          `${execPath}. Reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
      );
    }
    dir = parent;
  }
}

/**
 * Derive the npm global prefix that owns the install at `packageRoot`.
 *
 * npm's global layout for a scoped package:
 *   POSIX:   <prefix>/lib/node_modules/@phnx-labs/agents-cli
 *   Windows: <prefix>/node_modules/@phnx-labs/agents-cli
 *
 * Throws when `packageRoot` is not inside a node_modules tree (e.g. running
 * from a source checkout) — there is no prefix to install into, and guessing
 * one is exactly the bug this module exists to prevent.
 */
export function deriveGlobalPrefix(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  // Two levels up from the package root: the scope dir, then node_modules.
  const nodeModulesDir = path.dirname(path.dirname(resolved));
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    throw new Error(
      `${resolved} is not an npm-managed install; reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }
  const parent = path.dirname(nodeModulesDir);
  return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

/**
 * Sweep npm arborist's "retired" staging dir for `packageRoot` before a
 * reify (PHNX-3393).
 *
 * npm (@npmcli/arborist) reifies an install by first renaming the tree it is
 * about to replace out of the way into a sibling directory —
 * `retirePath(from)` in arborist's own source names it
 * `.<basename>-<8-char sha1 hash of the full path>`, sibling to `from` — then
 * stages the new tree and renames it into place. Because the hash is a pure
 * function of `packageRoot`'s path, that staging path is IDENTICAL on every
 * reify of this install. A crash between the retire-rename and the final
 * rename (SIGKILL, a killed terminal, a box that lost power mid-upgrade)
 * leaves that exact directory behind, non-empty. `rename(2)` cannot replace a
 * non-empty directory, so every subsequent upgrade's reify fails ENOTEMPTY at
 * the same path forever — nothing about a plain retry ever clears it.
 *
 * Removing any stale `.<basename>-*` sibling before install self-heals this:
 * npm re-stages cleanly once the collision is gone. Matches only the
 * retire-path shape (a dot-prefixed sibling starting with the package's own
 * basename), so an unrelated dotfile in the same directory is left alone.
 * Best-effort per entry: one unremovable sibling must not block the rest.
 */
export function sweepStaleInstallStaging(packageRoot: string): string[] {
  const resolved = path.resolve(packageRoot);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stagingPattern = new RegExp(`^\\.${escapedBase}-[a-zA-Z0-9]+$`);

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const entry of entries) {
    if (!stagingPattern.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      swept.push(full);
    } catch {
      /* best-effort — one unremovable stager must not block the rest */
    }
  }
  return swept;
}

/**
 * Install `spec` into an explicit global prefix. `--prefix` pins the
 * destination no matter which npm binary PATH resolves. `--ignore-scripts`
 * skips lifecycle scripts; the caller refreshes alias shims afterwards via
 * refreshAliasShims().
 *
 * `signal`, when passed, is wired into `execFile`'s own `signal` option —
 * Node kills the child process on abort and the returned promise rejects,
 * rather than the caller merely giving up on awaiting an orphaned process
 * (self-update-service.ts's daemon tick needs a real kill here: on a
 * deadline abort an un-killed `npm install -g` keeps writing into the same
 * global prefix a subsequent retry then installs into concurrently).
 */
export async function installPackageIntoPrefix(spec: string, prefix: string, signal?: AbortSignal): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  // On Windows `npm` is `npm.cmd`; execFile cannot run it without a shell (ENOENT).
  await execFileAsync('npm', ['install', '-g', '--prefix', prefix, spec, '--ignore-scripts'], {
    shell: needsWindowsShell('npm'),
    signal,
  });
}

/**
 * Install `spec` into bun's global store with `bun add -g`. bun writes to
 * `<bunGlobalDir>/node_modules/<pkg>`, which is exactly the running package
 * root for a bun install — so verifyInstalledVersion() sees the new version
 * in place. bun skips untrusted lifecycle scripts, so the caller refreshes
 * alias shims afterwards via refreshAliasShims() rather than relying on the
 * package's postinstall hook.
 *
 * `signal` behaves exactly as documented on {@link installPackageIntoPrefix}.
 */
export async function installPackageWithBun(spec: string, signal?: AbortSignal): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  // On Windows `bun` resolves to `bun.exe`/`bun.cmd`; force shell for the .cmd case.
  // --ignore-scripts: the tarball has already been integrity-verified, but its
  // lifecycle scripts must not run at install time (the caller refreshes shims
  // explicitly via refreshAliasShims()) — same fail-closed posture as the npm path.
  await execFileAsync('bun', ['add', '-g', spec, '--ignore-scripts'], { shell: needsWindowsShell('bun'), signal });
}

/**
 * Verify a downloaded tarball's bytes against a Subresource Integrity (SRI)
 * string of the form `sha512-<base64>` — npm's `dist.integrity`. Recomputes the
 * digest over the actual bytes with the named algorithm and compares it, in
 * constant time, to the decoded expected digest.
 *
 * Fails closed: a malformed SRI, an algorithm weaker than sha512, or any digest
 * mismatch throws. This is the gate that makes self-update refuse a tampered or
 * corrupted tarball *before* it is ever handed to a package manager to install.
 */
export function verifyTarballIntegrity(tarball: Buffer, integrity: string): void {
  const dash = integrity.indexOf('-');
  if (dash <= 0) {
    throw new Error(`malformed integrity string: ${JSON.stringify(integrity)}`);
  }
  const algorithm = integrity.slice(0, dash);
  const expectedBase64 = integrity.slice(dash + 1);
  // npm publishes sha512 SRI; refuse to verify against anything weaker rather
  // than silently accepting a downgraded (e.g. sha1) attestation.
  if (algorithm !== 'sha512') {
    throw new Error(`unsupported integrity algorithm '${algorithm}' (expected sha512)`);
  }
  const expected = Buffer.from(expectedBase64, 'base64');
  const actual = createHash('sha512').update(tarball).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(
      `integrity check failed: tarball hash sha512-${actual.toString('base64')} ` +
        `does not match expected ${integrity}`,
    );
  }
}

/**
 * Download the published tarball at `tarballUrl` and prove its bytes match
 * `integrity` before returning a path to it on disk. The returned .tgz is safe
 * to hand to `npm install`/`bun add` — it has been verified byte-for-byte
 * against the registry attestation. Fails closed: a non-200, a download error,
 * or a hash mismatch throws and no file path is returned, so the caller never
 * installs an unverified artifact.
 *
 * `signal`, when passed, aborts the fetch alongside the own `timeoutMs` timer
 * (whichever fires first) — a real cancellation of the in-flight request, not
 * just an abandoned await.
 */
export async function downloadVerifiedTarball(
  tarballUrl: string,
  integrity: string,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(tarballUrl, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  if (!response.ok) {
    throw new Error(`could not download tarball from ${tarballUrl} (HTTP ${response.status})`);
  }
  const tarball = Buffer.from(await response.arrayBuffer());
  verifyTarballIntegrity(tarball, integrity);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-cli-upgrade-'));
  const file = path.join(dir, path.basename(new URL(tarballUrl).pathname) || 'package.tgz');
  fs.writeFileSync(file, tarball);
  return file;
}

/** Read the version field of the package.json at `packageRoot`, fresh from disk. */
export function readInstalledVersion(packageRoot: string): string {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')).version;
}

/**
 * Assert that the install at `packageRoot` now carries `expectedVersion`.
 * npm exiting 0 only proves it wrote *somewhere*; this proves it wrote *here*.
 */
export function verifyInstalledVersion(packageRoot: string, expectedVersion: string): void {
  const actual = readInstalledVersion(packageRoot);
  if (actual !== expectedVersion) {
    const manager = detectPackageManager(packageRoot);
    const hint = manualInstallHint(manager, packageRoot, `${NPM_PACKAGE_NAME}@${expectedVersion}`);
    throw new Error(
      `the package manager reported success but ${packageRoot} is still ${actual} (expected ${expectedVersion}). ` +
        `Run manually: ${hint}`,
    );
  }
}

/**
 * Re-run the freshly installed copy's postinstall in shims-only mode so the
 * bare-command aliases (secrets, sessions, ...) pick up the new entrypoint
 * and any aliases added in the new version. Best-effort: a failure here
 * leaves the previous shims in place, which still point at the (now
 * upgraded) package root.
 */
export function refreshAliasShims(packageRoot: string): void {
  spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'postinstall.js')], {
    env: { ...process.env, AGENTS_POSTINSTALL_SHIMS_ONLY: '1' },
    stdio: 'ignore',
  });
}

/** One global bin link the upgrade reconciled: what it is and what happened. */
export interface BinLinkRepair {
  /** The `package.json#bin` key (`agents`, `ag`, `browser`, `computer`). */
  name: string;
  /** `<prefix>/bin/<name>` — the PATH entry the box's shell resolves. */
  linkPath: string;
  /** Absolute path the link must resolve to (`<packageRoot>/<bin target>`). */
  target: string;
  /**
   * `ok` — already resolved to the freshly-installed target.
   * `repaired` — was missing / dangling / pointing elsewhere, now relinked.
   * `failed` — could not be made to resolve (see `error`).
   */
  action: 'ok' | 'repaired' | 'failed';
  /** Set only for `failed`: why the relink did not take. */
  error?: string;
}

/** Resolve `p` through symlinks, or null when it does not resolve (missing/dangling). */
function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Reconcile one `<binDir>/<name>` link to `target`. A link that already resolves
 * to `target` is left untouched (`ok`); anything else — absent, dangling, or
 * pointing at a stale/foreign path — is replaced with a fresh **relative**
 * symlink (`../lib/node_modules/@phnx-labs/agents-cli/dist/index.js`), the exact
 * shape npm and the by-hand zion repair both produced, then re-verified. A
 * repair that still does not resolve (target missing, unwritable bin dir) is
 * reported `failed` with the reason rather than silently swallowed.
 */
function reconcileBinLink(name: string, linkPath: string, target: string): BinLinkRepair {
  const wanted = realpathOrNull(target);
  if (wanted !== null && realpathOrNull(linkPath) === wanted) {
    return { name, linkPath, target, action: 'ok' };
  }
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    // Replace whatever is there (a dangling link, a stale link, or nothing).
    fs.rmSync(linkPath, { force: true });
    fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
    const resolved = realpathOrNull(linkPath);
    if (resolved !== null && resolved === realpathOrNull(target)) {
      return { name, linkPath, target, action: 'repaired' };
    }
    return {
      name,
      linkPath,
      target,
      action: 'failed',
      error:
        resolved === null
          ? `link created but still does not resolve (is ${target} present?)`
          : `link resolves to ${resolved}, not ${target}`,
    };
  } catch (err) {
    return { name, linkPath, target, action: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The global bin links the upgrade OWNS: `<prefix>/bin/<name>` for every
 * `package.json#bin` entry (`agents`, `ag`, `browser`, `computer`).
 *
 * npm creates these on a normal `install -g`, but a box with several installs
 * (or a reify interrupted after the old links were retired) can end an upgrade
 * with the package at the new version and these links **missing** — the state
 * that stranded zion (PHNX-2768): `/opt/homebrew/lib/node_modules/...` at
 * 1.22.40 but `/opt/homebrew/bin/{agents,ag,browser,computer}` gone, so every
 * `agents` invocation was "command not found" until the links were relinked by
 * hand. The rollout probe reported it `unverified`; the box was left broken.
 *
 * So the upgrade verifies these links right after installing and **restores any
 * that are wrong** — covering the sibling entrypoints, not just `agents`, since
 * `ag`/`browser`/`computer` share the same failure. Each link is reconciled
 * independently; a link that cannot be made to resolve is reported `failed` so
 * the caller can fail loud (the rollout then marks the box failed, not merely
 * unverified) instead of returning a box the package upgraded but cannot run.
 *
 * POSIX only — Windows npm bins are `.cmd`/`.ps1` shims, not symlinks, so this
 * relink shape does not apply and the caller skips it there. `prefix` is the
 * npm global prefix from {@link deriveGlobalPrefix}; the bun path uses its own
 * bin layout and is out of scope.
 */
export function ensureGlobalBinLinks(packageRoot: string, prefix: string): BinLinkRepair[] {
  let bin: Record<string, string>;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    bin = pkg && typeof pkg.bin === 'object' && pkg.bin !== null ? (pkg.bin as Record<string, string>) : {};
  } catch (err) {
    throw new Error(
      `could not read bin entries from ${path.join(packageRoot, 'package.json')}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const binDir = path.join(prefix, 'bin');
  const repairs: BinLinkRepair[] = [];
  for (const [name, rel] of Object.entries(bin)) {
    if (typeof rel !== 'string' || !rel) continue;
    repairs.push(reconcileBinLink(name, path.join(binDir, name), path.resolve(packageRoot, rel)));
  }
  return repairs;
}

/**
 * The package root a resolved `agents` entrypoint belongs to, or null when the
 * path is not an agents-cli entry at all. Two shipped shapes:
 *   <packageRoot>/dist/index.js    — the JS entry npm links as `agents`
 *   <packageRoot>/dist/bin/agents  — the compiled standalone executable
 */
function packageRootForEntry(real: string): string | null {
  const distDir = path.dirname(real);
  if (path.basename(real) === 'index.js' && path.basename(distDir) === 'dist') {
    return path.dirname(distDir);
  }
  if (
    path.basename(real) === 'agents' &&
    path.basename(distDir) === 'bin' &&
    path.basename(path.dirname(distDir)) === 'dist'
  ) {
    return path.dirname(path.dirname(distDir));
  }
  return null;
}

export interface AgentsCliInstall {
  /** The PATH entry (`<dir>/agents`) that resolves to this install, when found through PATH. */
  binPath?: string;
  /** Package root containing package.json and dist/. */
  packageRoot: string;
  version: string;
  /** Whether this copy uses the serialized, atomic helper-bundle installer. */
  atomicHelperInstall: boolean;
}

export interface FindAgentsCliInstallsOptions {
  homeDir?: string;
  fnmDir?: string;
  npmCacheDir?: string;
  globalNodeModulesDirs?: string[];
}

export interface MultiInstallInventoryEntry {
  packageRoot: string;
  version: string;
  note: string;
  /** True for the copy that is currently executing. */
  running: boolean;
  /**
   * True when a bare `agents doctor --fix` deletes this copy (RUSH-2415:
   * npx-cache / unsafe-legacy / pre-1.22.30 with a fixed peer). False for the
   * running copy and for any duplicate --fix will not touch — a healthy
   * >=1.22.30 peer, or a pre-1.22.30 copy with no fixed peer to fall back to;
   * both need the manual command from manualUninstallCommand() (RUSH-2705/2713).
   */
  autoPurgeable: boolean;
}

/** Best-effort canonical path; keeps the input when realpath fails. */
function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Ensure the running copy participates in classification (the "has a fixed
 * peer" check) even when the PATH scan missed it — a source tree or unusual
 * layout. The running root is never deleted regardless.
 */
function withRunningInstall(
  installs: AgentsCliInstall[],
  runningRoot: string,
  runningVersion: string,
): AgentsCliInstall[] {
  const runningCanonical = canonicalPath(runningRoot);
  const already = installs.some(
    (install) => canonicalPath(install.packageRoot) === runningCanonical,
  );
  if (already) return installs;
  return [...installs, {
    packageRoot: runningRoot,
    version: runningVersion,
    // Unknown for a synthetic entry — classify only uses version for the
    // fixed-peer check; the running root is never deleted regardless.
    atomicHelperInstall: true,
  }];
}

/**
 * The exact shell command that removes the install at `packageRoot` by hand —
 * the remedy for duplicates `doctor --fix` deliberately will not purge
 * (RUSH-2705). `--prefix` pins the target tree no matter which npm binary
 * PATH resolves, mirroring installPackageIntoPrefix.
 */
export function manualUninstallCommand(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  if (detectPackageManager(resolved) === 'bun') {
    return `bun remove -g ${NPM_PACKAGE_NAME}`;
  }
  try {
    return `npm uninstall -g --prefix '${deriveGlobalPrefix(resolved)}' ${NPM_PACKAGE_NAME}`;
  } catch {
    // Not inside a node_modules tree — no npm prefix owns it; deleting the
    // directory is the only removal there is.
    return `rm -rf '${resolved}'`;
  }
}

export function buildMultiInstallInventory(
  runningRoot: string,
  runningVersion: string,
  installs: AgentsCliInstall[],
): MultiInstallInventoryEntry[] {
  const runningCanonical = canonicalPath(runningRoot);
  const removableRoots = new Set(
    classifyRemovableAgentsCliInstalls(
      runningRoot,
      withRunningInstall(installs, runningRoot, runningVersion),
    ).map((candidate) => candidate.packageRoot),
  );
  const byRoot = new Map<string, MultiInstallInventoryEntry>();
  byRoot.set(runningRoot, {
    packageRoot: runningRoot,
    version: runningVersion,
    note: 'running',
    running: true,
    autoPurgeable: false,
  });
  for (const install of installs) {
    const running = canonicalPath(install.packageRoot) === runningCanonical;
    const notes = [running
      ? 'running'
      : install.binPath
        ? `agents on PATH: ${install.binPath}`
        : 'discovered install'];
    if (!install.atomicHelperInstall) notes.push('unsafe legacy helper installer — remove this copy');
    byRoot.set(install.packageRoot, {
      packageRoot: install.packageRoot,
      version: install.version,
      note: notes.join('; '),
      running,
      autoPurgeable: !running && removableRoots.has(canonicalPath(install.packageRoot)),
    });
  }
  return [...byRoot.values()];
}

/** Why a discovered install is safe to delete without an interactive confirm. */
export type RemovableInstallReason =
  | 'npx-cache'
  | 'unsafe-legacy-helper'
  | 'pre-fixed-version';

export interface RemovableAgentsCliInstall {
  packageRoot: string;
  version: string;
  reasons: RemovableInstallReason[];
}

export interface PurgeRemovableInstallsResult {
  removed: RemovableAgentsCliInstall[];
  failed: Array<RemovableAgentsCliInstall & { error: string }>;
  skippedRunning: number;
}

/** True when the package root lives under npm's `_npx` cache (ephemeral runs). */
export function isNpxCacheInstall(packageRoot: string): boolean {
  // Split on either separator so a POSIX-shaped path is still recognized when
  // this runs on Windows (doctor --fix / tests pass forward literal `_npx`
  // paths from other boxes). `path.sep` alone missed `/home/…/_npx/…` on win32.
  const parts = packageRoot.split(/[\\/]/);
  return parts.includes('_npx');
}

/**
 * A release string that is at least TOUCH_ID_STORM_FIXED_SINCE, or a side-by-side
 * dev build (`0.0.0-dev.*`) which tracks main and therefore carries the fix.
 * Non-semver junk never qualifies as "fixed" — better to leave a weird copy
 * alone than delete the only working install.
 */
export function isTouchIdStormFixedVersion(version: string): boolean {
  if (version.startsWith('0.0.0-dev.') || version === '0.0.0-dev') return true;
  // compareVersions is numeric-segment only; refuse anything that does not
  // look like a release before treating it as "older than fixed".
  if (!/^\d+(\.\d+)*/.test(version)) return false;
  return compareVersions(version, TOUCH_ID_STORM_FIXED_SINCE) >= 0;
}

/**
 * Classify discovered installs that doctor --fix / upgrade may delete.
 *
 * Never marks the running package root. Auto-purge is limited to copies that
 * cannot be the intended primary install:
 *   - npx-cache trees (ephemeral)
 *   - pre-atomic-helper-installer trees ("unsafe legacy helper installer")
 *   - pre-TOUCH_ID_STORM_FIXED_SINCE trees, but only when at least one fixed
 *     copy already exists on the box (so we never strand the machine)
 *
 * A pre-fixed copy that is also the only install stays — the user must upgrade
 * it in place rather than delete it.
 */
export function classifyRemovableAgentsCliInstalls(
  runningRoot: string,
  installs: AgentsCliInstall[],
  opts: { fixedSince?: string } = {},
): RemovableAgentsCliInstall[] {
  const fixedSince = opts.fixedSince ?? TOUCH_ID_STORM_FIXED_SINCE;
  let runningCanonical = runningRoot;
  try {
    runningCanonical = fs.realpathSync(runningRoot);
  } catch {
    /* keep as given */
  }

  // A fixed peer is any install (including the running copy) that carries the
  // Touch-ID-storm fix. Pre-fixed trees are only deleted when such a peer
  // exists, so a lone stale install is never purged out from under the user.
  const hasFixedPeer = installs.some((install) => isTouchIdStormFixedVersion(install.version));

  const out: RemovableAgentsCliInstall[] = [];
  for (const install of installs) {
    let root = install.packageRoot;
    try {
      root = fs.realpathSync(install.packageRoot);
    } catch {
      /* keep */
    }
    if (root === runningCanonical) continue;

    const reasons: RemovableInstallReason[] = [];
    if (isNpxCacheInstall(root) || isNpxCacheInstall(install.packageRoot)) {
      reasons.push('npx-cache');
    }
    if (!install.atomicHelperInstall) {
      reasons.push('unsafe-legacy-helper');
    }
    if (
      hasFixedPeer
      && /^\d+(\.\d+)*/.test(install.version)
      && compareVersions(install.version, fixedSince) < 0
    ) {
      reasons.push('pre-fixed-version');
    }
    if (reasons.length === 0) continue;
    out.push({ packageRoot: root, version: install.version, reasons });
  }
  return out;
}

/**
 * Delete classified removable package roots from disk. Re-reads package.json
 * immediately before the unlink so a path that is no longer @phnx-labs/agents-cli
 * is never removed. Best-effort: one failure does not stop the rest.
 */
export function purgeRemovableAgentsCliInstalls(
  candidates: RemovableAgentsCliInstall[],
  opts: { dryRun?: boolean; runningRoot?: string } = {},
): PurgeRemovableInstallsResult {
  const result: PurgeRemovableInstallsResult = {
    removed: [],
    failed: [],
    skippedRunning: 0,
  };
  let runningCanonical: string | undefined;
  if (opts.runningRoot) {
    try {
      runningCanonical = fs.realpathSync(opts.runningRoot);
    } catch {
      runningCanonical = opts.runningRoot;
    }
  }

  for (const candidate of candidates) {
    let root = candidate.packageRoot;
    try {
      root = fs.realpathSync(candidate.packageRoot);
    } catch {
      /* keep */
    }
    if (runningCanonical && root === runningCanonical) {
      result.skippedRunning += 1;
      continue;
    }
    // Refuse anything that no longer looks like our package.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as {
        name?: unknown;
      };
      if (pkg.name !== NPM_PACKAGE_NAME) {
        result.failed.push({
          ...candidate,
          packageRoot: root,
          error: `package.json name is ${String(pkg.name)}, not ${NPM_PACKAGE_NAME}`,
        });
        continue;
      }
    } catch (err) {
      result.failed.push({
        ...candidate,
        packageRoot: root,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (opts.dryRun) {
      result.removed.push({ ...candidate, packageRoot: root });
      continue;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
      result.removed.push({ ...candidate, packageRoot: root });
    } catch (err) {
      result.failed.push({
        ...candidate,
        packageRoot: root,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** A detected duplicate that `doctor --fix` will not purge (RUSH-2705). */
export interface UnresolvedDuplicateInstall {
  packageRoot: string;
  version: string;
  /** Exact shell command that removes this copy by hand. */
  manualRemoveCommand: string;
}

export interface RemediateStaleInstallsResult extends PurgeRemovableInstallsResult {
  inventory: MultiInstallInventoryEntry[];
  candidates: RemovableAgentsCliInstall[];
  /**
   * Duplicates detected but NOT auto-purged, for either reason:
   *   1. a healthy >=1.22.30 global (safe, just redundant), or
   *   2. a pre-1.22.30 copy left alone only because no fixed peer exists to fall
   *      back to (the anti-stranding guard) — this one is genuinely vulnerable,
   *      not healthy.
   * Either way the caller must surface manualRemoveCommand — otherwise the
   * multi-install warning keeps firing with no working remedy (RUSH-2705/2713).
   */
  unresolved: UnresolvedDuplicateInstall[];
}

/**
 * Scan + classify + purge in one call. Used by `agents doctor --fix` and
 * `agents upgrade` so both paths remediate the same set of latent copies.
 */
export function remediateStaleAgentsCliInstalls(opts: {
  runningRoot: string;
  runningVersion?: string;
  pathEnv?: string;
  findOpts?: FindAgentsCliInstallsOptions;
  dryRun?: boolean;
}): RemediateStaleInstallsResult {
  const pathEnv = opts.pathEnv ?? (process.env.PATH || '');
  let installs = findAgentsCliInstalls(pathEnv, opts.findOpts);
  // Ensure the running root participates in "has a fixed peer" even when the
  // PATH scan missed it (source tree, unusual layout).
  if (opts.runningVersion) {
    installs = withRunningInstall(installs, opts.runningRoot, opts.runningVersion);
  }
  const candidates = classifyRemovableAgentsCliInstalls(opts.runningRoot, installs);
  const purge = purgeRemovableAgentsCliInstalls(candidates, {
    dryRun: opts.dryRun,
    runningRoot: opts.runningRoot,
  });
  const inventory = buildMultiInstallInventory(
    opts.runningRoot,
    opts.runningVersion ?? 'unknown',
    installs,
  );
  const unresolved = inventory
    .filter((entry) => !entry.running && !entry.autoPurgeable)
    .map((entry) => ({
      packageRoot: entry.packageRoot,
      version: entry.version,
      manualRemoveCommand: manualUninstallCommand(entry.packageRoot),
    }));
  return { ...purge, candidates, inventory, unresolved };
}

function childDirectories(parent: string): string[] {
  try {
    return fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(parent, entry.name));
  } catch {
    return [];
  }
}

function knownPackageRoots(opts: FindAgentsCliInstallsOptions): string[] {
  const homeDir = opts.homeDir ?? os.homedir();
  const fnmRoots = opts.fnmDir !== undefined
    ? [opts.fnmDir]
    : [process.env.FNM_DIR, path.join(homeDir, '.local', 'share', 'fnm')]
      .filter((value): value is string => Boolean(value));
  const roots: string[] = [];
  const packageTail = path.join('lib', 'node_modules', ...NPM_PACKAGE_NAME.split('/'));

  for (const nodeDir of childDirectories(path.join(homeDir, '.nvm', 'versions', 'node'))) {
    roots.push(path.join(nodeDir, packageTail));
  }
  for (const fnmRoot of fnmRoots) {
    for (const versionDir of childDirectories(path.join(fnmRoot, 'node-versions'))) {
      roots.push(path.join(versionDir, 'installation', packageTail));
    }
  }

  roots.push(
    path.join(homeDir, '.volta', 'tools', 'image', 'packages', ...NPM_PACKAGE_NAME.split('/'), packageTail),
    path.join(homeDir, '.local', packageTail),
    path.join(homeDir, '.bun', 'install', 'global', 'node_modules', ...NPM_PACKAGE_NAME.split('/')),
  );

  const npmCacheDir = opts.npmCacheDir ?? process.env.npm_config_cache ?? path.join(homeDir, '.npm');
  for (const npxRunDir of childDirectories(path.join(npmCacheDir, '_npx'))) {
    roots.push(path.join(npxRunDir, 'node_modules', ...NPM_PACKAGE_NAME.split('/')));
  }

  const globalNodeModulesDirs = opts.globalNodeModulesDirs ?? [
    '/opt/homebrew/lib/node_modules',
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  for (const nodeModulesDir of globalNodeModulesDirs) {
    roots.push(path.join(nodeModulesDir, ...NPM_PACKAGE_NAME.split('/')));
  }
  return roots;
}

function readAgentsCliInstall(packageRoot: string, binPath?: string): AgentsCliInstall | null {
  let canonicalRoot: string;
  let pkg: { name?: unknown; version?: unknown };
  try {
    canonicalRoot = fs.realpathSync(packageRoot);
    pkg = JSON.parse(fs.readFileSync(path.join(canonicalRoot, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (pkg.name !== NPM_PACKAGE_NAME || typeof pkg.version !== 'string') return null;
  return {
    ...(binPath ? { binPath } : {}),
    packageRoot: canonicalRoot,
    version: pkg.version,
    atomicHelperInstall: fs.existsSync(path.join(canonicalRoot, 'dist', 'lib', 'app-bundle-install.js')),
  };
}

/**
 * Resolve every `agents` entrypoint on PATH, then inspect the bounded global
 * install layouts used by NVM, fnm, Volta, Bun, npm, and npx. More than one
 * distinct package root means upgrades,
 * shims, and the command the user types can act on different copies — the
 * divergence behind silently-failing self-updates.
 *
 * npm bin entries are symlinks that resolve to `<packageRoot>/dist/index.js`
 * (the dev install's `~/.local/bin/agents` chains through the dev prefix to
 * the same shape). A shim pointed at the compiled standalone binary resolves
 * to `<packageRoot>/dist/bin/agents` instead; that shape counts too, otherwise
 * the copy that actually runs — the compiled one is typically first on PATH —
 * is invisible to this scan and its root looks like a separate install.
 * Anything that resolves to neither shape inside a package named
 * @phnx-labs/agents-cli is some other tool and is skipped.
 * POSIX-only: Windows npm bins are .cmd wrappers, not symlinks.
 */
export function findAgentsCliInstalls(
  pathEnv: string,
  opts: FindAgentsCliInstallsOptions = {},
): AgentsCliInstall[] {
  if (process.platform === 'win32') return [];
  const installs: AgentsCliInstall[] = [];
  const seenRoots = new Set<string>();
  const addInstall = (install: AgentsCliInstall | null): void => {
    if (!install || seenRoots.has(install.packageRoot)) return;
    seenRoots.add(install.packageRoot);
    installs.push(install);
  };
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'agents');
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue; // missing or dangling symlink
    }
    const packageRoot = packageRootForEntry(real);
    if (!packageRoot) continue;
    addInstall(readAgentsCliInstall(packageRoot, candidate));
  }
  for (const packageRoot of knownPackageRoots(opts)) {
    addInstall(readAgentsCliInstall(packageRoot));
  }
  return installs;
}
