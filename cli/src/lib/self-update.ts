/** Self-update install plumbing. An upgrade must replace the running copy, so every step is
 * anchored to the running package root on disk, never to PATH resolution. A bare `npm install -g`
 * can write into a different node's prefix and "succeed" while the running copy stays stale. */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
// Leaf comparator only — do not pull the full versions.ts graph into every
// bootstrap that imports self-update (RUSH-2331).
import { compareVersions } from './agent-spec/primitives.js';
import { needsWindowsShell } from './platform/index.js';

export const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

/** First release that stopped the usage/auth-health probe from reading Claude Code's interactive
 * login (commit 3f3554c51). Older versions on macOS re-introduce the Touch ID storm and fleet-wide
 * revocation (RUSH-2415 / RUSH-1822). */
export const TOUCH_ID_STORM_FIXED_SINCE = '1.22.30';

export type PackageManager = 'npm' | 'bun';

/** The directory bun installs global packages into: <BUN_INSTALL>/install/global (default ~/.bun).
 * A scoped package lives at `<bunGlobalDir>/node_modules/@phnx-labs/agents-cli` with no `lib`
 * segment, which is why an npm upgrade misses a bun install. */
export function bunGlobalDir(): string {
  const bunInstall = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  return path.join(bunInstall, 'install', 'global');
}

/** Identify which package manager owns the install at `packageRoot` so the upgrade uses the right
 * one. Bun is `<bunGlobalDir>/node_modules/<pkg>`; all else is npm. Path-based, no subprocess,
 * with a `.bun/install/global` fallback for a relocated BUN_INSTALL. */
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

/** Persist the latest known version and timestamp, preserving an existing `dismissed` marker so a
 * background refresh never re-prompts a skipped version. */
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

/** Short TTL for the multi-install PATH scan cache (RUSH-2324); the scan runs on every invocation
 * via `maybeWarnMultiInstall`. Same 5-minute window as the detached-sync spawn gate. */
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

/** Whether a multi-install scan cache is still usable: invalid when missing, past TTL, PATH
 * changed, or the running copy's root/version changed. */
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

/** Resolve the multi-install inventory, using the on-disk scan cache when fresh to skip the PATH
 * walk (RUSH-2324). */
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

/** Whether `p` is Bun's embedded virtual filesystem (`/$bunfs` and below), which cannot be stat'd
 * or installed into. Matches the bare root too, since `<__dirname>/..` from the embedded entry
 * yields it. daemon.ts has a narrower guard; the two are deliberately not shared. */
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

/** The on-disk package root of the running copy: walk up from the calling module to the
 * package.json naming this package, never assuming a fixed depth (2026-09-07 incident). Under the
 * compiled binary `__dirname` is Bun's virtual FS, so use `process.execPath`. */
export function resolveRunningPackageRoot(
  dirname: string,
  execPath: string = process.execPath,
): string {
  if (!isBunVirtualPath(dirname)) {
    // Walk up from the calling module's directory to the package.json naming this package. The old
    // `path.resolve(dirname, '..')` was wrong below dist/ and broke every daemon self-update tick
    // (2026-09-07).
    const found = findPackageRootAbove(dirname);
    if (found) return found;
    throw new Error(
      `Cannot locate the running agents-cli install: no ${NPM_PACKAGE_NAME} package.json above ` +
        `${dirname}. Reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }

  if (!execPath || isBunVirtualPath(execPath)) {
    throw new Error(
      `Cannot locate the running agents-cli install: __dirname is the Bun virtual path ${dirname} ` +
        `and process.execPath (${execPath || '(empty)'}) is not a real file. ` +
        `Reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }

  const found = findPackageRootAbove(path.dirname(path.resolve(execPath)));
  if (found) return found;
  throw new Error(
    `Cannot locate the running agents-cli install: no ${NPM_PACKAGE_NAME} package.json above ` +
      `${execPath}. Reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
  );
}

/** Nearest ancestor of `start` (inclusive) whose package.json names this package, or null. */
function findPackageRootAbove(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Derive the npm global prefix owning the install at `packageRoot` (POSIX
 * `<prefix>/lib/node_modules/...`, Windows `<prefix>/node_modules/...`). Throws outside a
 * node_modules tree (e.g. a source checkout): guessing a prefix is the bug this module prevents. */
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

/** Sweep npm arborist's retired staging dir before a reify (PHNX-3393). Its name is a pure function
 * of the path, so a crash mid-reify leaves it and every later upgrade fails ENOTEMPTY. Removes
 * only stale `.<basename>-*` siblings, best-effort per entry. */
export async function sweepStaleInstallStaging(packageRoot: string): Promise<string[]> {
  const resolved = path.resolve(packageRoot);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stagingPattern = new RegExp(`^\\.${escapedBase}-[a-zA-Z0-9]+$`);

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const entry of entries) {
    if (!stagingPattern.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      await fsp.rm(full, { recursive: true, force: true });
      swept.push(full);
    } catch {
      /* best-effort — one unremovable stager must not block the rest */
    }
  }
  return swept;
}

/** Install `spec` into an explicit global prefix; `--prefix` pins the destination and
 * `--ignore-scripts` skips lifecycle scripts (caller runs refreshAliasShims()). `signal` kills the
 * child on abort so a timed-out install cannot keep writing while a retry runs. */
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

/** Install `spec` with `bun add -g` into the running package root; bun skips untrusted lifecycle
 * scripts, so the caller runs refreshAliasShims(). bun's write is not atomic: gate on {@link
 * installLooksSettled}. `signal` as in {@link installPackageIntoPrefix}. */
/** How long an install's package.json must have been at rest before a foreign version bump is trusted. */
export const INSTALL_SETTLE_MS = 60_000;

/** True when the install at `packageRoot` looks complete: package.json unmodified for at least
 * `settleMs` and every declared `bin` entry exists. Guards trusting a version bump written by
 * another process, since bun's write is not atomic. Any read error means "not settled". */
export function installLooksSettled(packageRoot: string, settleMs: number = INSTALL_SETTLE_MS, now: number = Date.now()): boolean {
  try {
    const pkgJsonPath = path.join(packageRoot, 'package.json');
    const stat = fs.statSync(pkgJsonPath);
    if (now - stat.mtimeMs < settleMs) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as { bin?: string | Record<string, string> };
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
    return bins.every((rel) => fs.existsSync(path.join(packageRoot, rel)));
  } catch {
    return false;
  }
}

export async function installPackageWithBun(spec: string, signal?: AbortSignal): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  // On Windows `bun` resolves to bun.exe/bun.cmd; force shell for .cmd. `--ignore-scripts`:
  // lifecycle scripts must not run at install (shims are refreshed via refreshAliasShims()), same
  // fail-closed posture as npm.
  await execFileAsync('bun', ['add', '-g', spec, '--ignore-scripts'], { shell: needsWindowsShell('bun'), signal });
}

/** Verify a tarball's bytes against an SRI string (`sha512-<base64>`) in constant time. Fails
 * closed on a malformed SRI, an algorithm weaker than sha512, or a mismatch, so self-update
 * refuses a tampered tarball before install. */
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

/** Download the tarball at `tarballUrl` and prove its bytes match `integrity` before returning its
 * path. Fails closed on non-200, download error, or hash mismatch; no path is returned for an
 * unverified artifact. `signal` aborts the in-flight fetch alongside the own `timeoutMs` timer. */
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
export async function readInstalledVersion(packageRoot: string): Promise<string> {
  return JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8')).version;
}

/** Assert the install at `packageRoot` carries `expectedVersion`: npm exiting 0 only proves it
 * wrote somewhere, not here. */
export async function verifyInstalledVersion(packageRoot: string, expectedVersion: string): Promise<void> {
  const actual = await readInstalledVersion(packageRoot);
  if (actual !== expectedVersion) {
    const manager = detectPackageManager(packageRoot);
    const hint = manualInstallHint(manager, packageRoot, `${NPM_PACKAGE_NAME}@${expectedVersion}`);
    throw new Error(
      `the package manager reported success but ${packageRoot} is still ${actual} (expected ${expectedVersion}). ` +
        `Run manually: ${hint}`,
    );
  }
}

/** Re-run the new copy's postinstall in shims-only mode so bare-command aliases pick up the new
 * entrypoint. Best-effort: on failure the previous shims stay and still point at the upgraded
 * root. */
export async function refreshAliasShims(packageRoot: string, signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts', 'postinstall.js')], {
      env: { ...process.env, AGENTS_POSTINSTALL_SHIMS_ONLY: '1' },
      signal,
    });
  } catch {
    /* best-effort — a failure here leaves the previous shims in place, same as the prior spawnSync (which ignored its exit code/stdio too) */
  }
}

/** One global bin link the upgrade reconciled: what it is and what happened. */
export interface BinLinkRepair {
  /** The `package.json#bin` key (`agents`, `ag`, `browser`, `computer`). */
  name: string;
  /** `<prefix>/bin/<name>` — the PATH entry the box's shell resolves. */
  linkPath: string;
  /** Absolute path the link must resolve to (`<packageRoot>/<bin target>`). */
  target: string;
  /** `ok`: already resolved to the new target. `repaired`: was missing/dangling/elsewhere, now
   * relinked. `failed`: could not be made to resolve (see `error`). */
  action: 'ok' | 'repaired' | 'failed';
  /** Set only for `failed`: why the relink did not take. */
  error?: string;
}

/** Resolve `p` through symlinks, or null when it does not resolve (missing/dangling). */
async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** Reconcile one `<binDir>/<name>` link to `target`: a correct link is left alone; anything else is
 * replaced with a fresh relative symlink and re-verified. A repair that still does not resolve is
 * reported `failed` with the reason, not swallowed. */
async function reconcileBinLink(name: string, linkPath: string, target: string): Promise<BinLinkRepair> {
  const wanted = await realpathOrNull(target);
  if (wanted !== null && (await realpathOrNull(linkPath)) === wanted) {
    return { name, linkPath, target, action: 'ok' };
  }
  try {
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
    // Replace whatever is there (a dangling link, a stale link, or nothing).
    await fsp.rm(linkPath, { force: true });
    await fsp.symlink(path.relative(path.dirname(linkPath), target), linkPath);
    const resolved = await realpathOrNull(linkPath);
    if (resolved !== null && resolved === (await realpathOrNull(target))) {
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

/** The global bin links the upgrade owns: `<prefix>/bin/<name>` per `package.json#bin` entry. An
 * interrupted reify can leave them missing (zion, PHNX-2768). Each link is restored independently;
 * one that cannot resolve is `failed` so the caller fails loud. POSIX only; bun out of scope. */
export async function ensureGlobalBinLinks(packageRoot: string, prefix: string): Promise<BinLinkRepair[]> {
  let bin: Record<string, string>;
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8'));
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
    repairs.push(await reconcileBinLink(name, path.join(binDir, name), path.resolve(packageRoot, rel)));
  }
  return repairs;
}

/** The package root a resolved `agents` entrypoint belongs to, or null if it is not an agents-cli
 * entry. Shapes: `<root>/dist/index.js` (JS) and `<root>/dist/bin/agents` (compiled). */
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
  /** True when a bare `agents sync` deletes this copy (RUSH-2415: npx-cache, unsafe-legacy, or
   * pre-1.22.30 with a fixed peer). False for the running copy and duplicates needing the manual
   * command from manualUninstallCommand() (RUSH-2705/2713). */
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

/** Ensure the running copy takes part in classification (the "has a fixed peer" check) even if the
 * PATH scan missed it. The running root is never deleted. */
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

/** The shell command that removes the install at `packageRoot` by hand, for duplicates `agents
 * sync` will not purge (RUSH-2705). `--prefix` pins the target tree, mirroring
 * installPackageIntoPrefix. */
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
  // this runs on Windows (agents sync / tests pass forward literal `_npx`
  // paths from other boxes). `path.sep` alone missed `/home/…/_npx/…` on win32.
  const parts = packageRoot.split(/[\\/]/);
  return parts.includes('_npx');
}

/** A release at least TOUCH_ID_STORM_FIXED_SINCE, or a side-by-side dev build (`0.0.0-dev.*`,
 * tracks main). Non-semver junk never qualifies: better to keep a weird copy than delete the only
 * working install. */
export function isTouchIdStormFixedVersion(version: string): boolean {
  if (version.startsWith('0.0.0-dev.') || version === '0.0.0-dev') return true;
  // compareVersions is numeric-segment only; refuse anything that does not
  // look like a release before treating it as "older than fixed".
  if (!/^\d+(\.\d+)*/.test(version)) return false;
  return compareVersions(version, TOUCH_ID_STORM_FIXED_SINCE) >= 0;
}

/** Classify installs that agents sync / upgrade may delete. Never the running root. Auto-purge only
 * npx-cache, pre-atomic-installer, and pre-TOUCH_ID_STORM_FIXED_SINCE trees when a fixed copy
 * exists. A pre-fixed copy that is the only install stays. */
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

/** Delete classified package roots from disk. Re-reads package.json right before the unlink so a
 * path that is no longer @phnx-labs/agents-cli is never removed. Best-effort per entry. */
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

/** A detected duplicate that `agents sync` will not purge (RUSH-2705). */
export interface UnresolvedDuplicateInstall {
  packageRoot: string;
  version: string;
  /** Exact shell command that removes this copy by hand. */
  manualRemoveCommand: string;
}

export interface RemediateStaleInstallsResult extends PurgeRemovableInstallsResult {
  inventory: MultiInstallInventoryEntry[];
  candidates: RemovableAgentsCliInstall[];
  /** Duplicates detected but not auto-purged: a healthy >=1.22.30 global, or a vulnerable
   * pre-1.22.30 copy kept because no fixed peer exists. The caller must surface
   * manualRemoveCommand or the warning fires with no remedy (RUSH-2705/2713). */
  unresolved: UnresolvedDuplicateInstall[];
}

/** Scan, classify and purge in one call, shared by `agents sync` and `agents upgrade` so both
 * remediate the same latent copies. */
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

/** Resolve every `agents` entrypoint on PATH plus bounded global layouts (NVM, fnm, Volta, Bun,
 * npm, npx). Multiple package roots mean upgrades, shims and the typed command hit different
 * copies. Both `<root>/dist/index.js` and compiled `<root>/dist/bin/agents` count. POSIX-only. */
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
