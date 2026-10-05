
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
import { compareVersions } from './agent-spec/primitives.js';
import { needsWindowsShell } from './platform/index.js';

export const NPM_PACKAGE_NAME = '@phnx-labs/agents-cli';

export const TOUCH_ID_STORM_FIXED_SINCE = '1.22.30';

export type PackageManager = 'npm' | 'bun';

export function bunGlobalDir(): string {
  const bunInstall = process.env.BUN_INSTALL || path.join(os.homedir(), '.bun');
  return path.join(bunInstall, 'install', 'global');
}

export function detectPackageManager(packageRoot: string): PackageManager {
  const resolved = path.resolve(packageRoot);
  const prefix = path.dirname(path.dirname(path.dirname(resolved)));
  if (prefix === path.resolve(bunGlobalDir())) return 'bun';
  const parts = prefix.split(path.sep);
  const n = parts.length;
  if (n >= 3 && parts[n - 1] === 'global' && parts[n - 2] === 'install' && parts[n - 3] === '.bun') {
    return 'bun';
  }
  return 'npm';
}

function manualInstallHint(manager: PackageManager, packageRoot: string, spec: string): string {
  if (manager === 'bun') return `bun add -g ${spec}`;
  return `npm install -g --prefix ${deriveGlobalPrefix(packageRoot)} ${spec}`;
}

export interface UpdateCheckCache {
  lastCheck: number;
  latestVersion: string;
  dismissed?: string;
}

export function readUpdateCache(file: string): UpdateCheckCache | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

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
  }
}

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
  }
}

export function shouldPromptUpgrade(cache: UpdateCheckCache | null, currentVersion: string): boolean {
  if (!cache?.latestVersion) return false;
  return (
    cache.latestVersion !== currentVersion &&
    compareVersions(cache.latestVersion, currentVersion) > 0 &&
    cache.latestVersion !== cache.dismissed
  );
}

export const MULTI_INSTALL_SCAN_TTL_MS = 5 * 60 * 1000;

export interface MultiInstallScanCache {
  scannedAt: number;
  pathEnv: string;
  runningRoot: string;
  runningVersion: string;
  inventory: MultiInstallInventoryEntry[];
}

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

export function writeMultiInstallScanCache(file: string, cache: MultiInstallScanCache): void {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch {
  }
}

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

function isBunVirtualPath(p: string): boolean {
  return /(^|[/\\])\$bunfs([/\\]|$)/.test(p);
}

function isPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return pkg.name === NPM_PACKAGE_NAME;
  } catch {
    return false;
  }
}

// Anchor to the physical running package; compiled Bun must use process.execPath rather than PATH or npm guesses.
export function resolveRunningPackageRoot(
  dirname: string,
  execPath: string = process.execPath,
): string {
  if (!isBunVirtualPath(dirname)) {
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

function findPackageRootAbove(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (isPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function deriveGlobalPrefix(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  const nodeModulesDir = path.dirname(path.dirname(resolved));
  if (path.basename(nodeModulesDir) !== 'node_modules') {
    throw new Error(
      `${resolved} is not an npm-managed install; reinstall with: npm install -g ${NPM_PACKAGE_NAME}`,
    );
  }
  const parent = path.dirname(nodeModulesDir);
  return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

// Sweep only npm's exact retired-sibling shape, never arbitrary neighboring directories.
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
    }
  }
  return swept;
}

// Package-manager installs never run lifecycle scripts; callers verify sha512, exact version, bins, and shims themselves.
export async function installPackageIntoPrefix(spec: string, prefix: string, signal?: AbortSignal): Promise<void> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('npm', ['install', '-g', '--prefix', prefix, spec, '--ignore-scripts'], {
    shell: needsWindowsShell('npm'),
    signal,
  });
}

export const INSTALL_SETTLE_MS = 60_000;

// Foreign Bun version bumps require a quiet package.json and complete declared bins before relaunch.
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
  await execFileAsync('bun', ['add', '-g', spec, '--ignore-scripts'], { shell: needsWindowsShell('bun'), signal });
}

// Fail closed on anything except the registry's sha512 bytes before handing a tarball to a package manager.
export function verifyTarballIntegrity(tarball: Buffer, integrity: string): void {
  const dash = integrity.indexOf('-');
  if (dash <= 0) {
    throw new Error(`malformed integrity string: ${JSON.stringify(integrity)}`);
  }
  const algorithm = integrity.slice(0, dash);
  const expectedBase64 = integrity.slice(dash + 1);
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

export async function readInstalledVersion(packageRoot: string): Promise<string> {
  return JSON.parse(await fsp.readFile(path.join(packageRoot, 'package.json'), 'utf-8')).version;
}

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

export async function refreshAliasShims(packageRoot: string, signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync(process.execPath, [path.join(packageRoot, 'scripts', 'postinstall.js')], {
      env: { ...process.env, AGENTS_POSTINSTALL_SHIMS_ONLY: '1' },
      signal,
    });
  } catch {
  }
}

export interface BinLinkRepair {
  name: string;
  linkPath: string;
  target: string;
  action: 'ok' | 'repaired' | 'failed';
  error?: string;
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

async function reconcileBinLink(name: string, linkPath: string, target: string): Promise<BinLinkRepair> {
  const wanted = await realpathOrNull(target);
  if (wanted !== null && (await realpathOrNull(linkPath)) === wanted) {
    return { name, linkPath, target, action: 'ok' };
  }
  try {
    await fsp.mkdir(path.dirname(linkPath), { recursive: true });
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
  binPath?: string;
  packageRoot: string;
  version: string;
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
  running: boolean;
  autoPurgeable: boolean;
}

function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

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
    atomicHelperInstall: true,
  }];
}

export function manualUninstallCommand(packageRoot: string): string {
  const resolved = path.resolve(packageRoot);
  if (detectPackageManager(resolved) === 'bun') {
    return `bun remove -g ${NPM_PACKAGE_NAME}`;
  }
  try {
    return `npm uninstall -g --prefix '${deriveGlobalPrefix(resolved)}' ${NPM_PACKAGE_NAME}`;
  } catch {
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

export function isNpxCacheInstall(packageRoot: string): boolean {
  const parts = packageRoot.split(/[\\/]/);
  return parts.includes('_npx');
}

export function isTouchIdStormFixedVersion(version: string): boolean {
  if (version.startsWith('0.0.0-dev.') || version === '0.0.0-dev') return true;
  if (!/^\d+(\.\d+)*/.test(version)) return false;
  return compareVersions(version, TOUCH_ID_STORM_FIXED_SINCE) >= 0;
}

// Never select the running root; a pre-fix install is removable only when a fixed peer prevents stranding the box.
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
  }

  const hasFixedPeer = installs.some((install) => isTouchIdStormFixedVersion(install.version));

  const out: RemovableAgentsCliInstall[] = [];
  for (const install of installs) {
    let root = install.packageRoot;
    try {
      root = fs.realpathSync(install.packageRoot);
    } catch {
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
    }
    if (runningCanonical && root === runningCanonical) {
      result.skippedRunning += 1;
      continue;
    }
    // Re-read package identity immediately before unlink so a raced or foreign tree cannot be deleted.
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

export interface UnresolvedDuplicateInstall {
  packageRoot: string;
  version: string;
  manualRemoveCommand: string;
}

export interface RemediateStaleInstallsResult extends PurgeRemovableInstallsResult {
  inventory: MultiInstallInventoryEntry[];
  candidates: RemovableAgentsCliInstall[];
  unresolved: UnresolvedDuplicateInstall[];
}

export function remediateStaleAgentsCliInstalls(opts: {
  runningRoot: string;
  runningVersion?: string;
  pathEnv?: string;
  findOpts?: FindAgentsCliInstallsOptions;
  dryRun?: boolean;
}): RemediateStaleInstallsResult {
  const pathEnv = opts.pathEnv ?? (process.env.PATH || '');
  let installs = findAgentsCliInstalls(pathEnv, opts.findOpts);
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
      continue;
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
