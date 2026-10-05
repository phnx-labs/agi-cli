/** Install + lifecycle for the macOS menu-bar helper: a stable Application Support path and a
 * RunAtLoad + KeepAlive service whose plist bakes in node, entry and bin paths (no login PATH).
 * Opt-out is sticky: `agents menubar disable` drops a sentinel. */

import { fileURLToPath } from 'url';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sleepSync } from '../fs-atomic.js';
import { getRuntimeStateDir, getHelpersDir } from '../state.js';
import { getCliVersion, resolveAgentsBin, resolveInstalledLayout } from '../version.js';
import { copyAppBundle, withInstallLock } from '../app-bundle-install.js';
import { compareVersions } from '../agent-spec/primitives.js';
import { namespacedServiceLabel, serviceManifestHomeEnv, serviceManagerRegistrationAllowed } from '../service-manifest.js';
import { downloadMenubarHelperApp, menubarHelperCacheDir } from './download-menubar.js';
import { helperFloor } from '../helper-versions.js';
import { cachedMenubarVersion, resolveMenubarVersion } from './resolve-version.js';

const APP_BUNDLE_NAME = 'MenubarHelper.app';
const INSTALL_DIR_NAME = 'agents-cli';
const SERVICE_LABEL_BASE = 'com.phnx-labs.agents-menubar';

/** The bundled executable's basename (RUSH-3101), exec'd by launchd; macOS shows it in
 * Accessibility prompts. Renaming does NOT touch bundle id, Team ID or DR, so grants survive.
 * Every check reads this; Swift side (agi-menu HelperIdentity.swift) has its own. */
export const MENUBAR_HELPER_EXECUTABLE_NAME = 'AGI Menu';

/** launchd Label for this process's helper: the production identifier, namespaced under a
 * redirected HOME (RUSH-2639). launchd routes bootout/bootstrap/kickstart by identifier alone, so
 * a hermetic test fork would boot out the live helper. */
export function serviceLabel(): string {
  return namespacedServiceLabel(SERVICE_LABEL_BASE);
}

/** Minimum seconds between launchd restarts (`ThrottleInterval`). A helper crashing at startup on a
 * starved machine relaunched every 10s, each spawning `agents doctor --json`. 30s paces it; the
 * helper reaping its children (ChildProcess.swift) is the real fix. */
const MENUBAR_THROTTLE_SECONDS = 30;

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

function installDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME);
}

function installedAppPath(): string {
  return path.join(installDir(), APP_BUNDLE_NAME);
}

/** Version stamp beside the installed bundle. The upgrade self-heal compares it to decide whether
 * to rebuild the App Support copy and plist; without it `npm update` leaves the menu bar on the
 * OLD helper binary and stale baked paths. */
function installedVersionMarkerPath(): string {
  return path.join(installDir(), '.menubar-version');
}

/** What the installed helper IS, deliberately not the CLI's version. A release bundle is identified
 * by its helper version; a local dev build has none (agi-menu build.sh hardcodes it), so it is
 * identified by source path + mtime. */
/** Version label for a bundle that has none of its own (a local dev build). */
export const LOCAL_BUILD_LABEL = 'local';

type MenubarStamp =
  | { source: 'release'; helperVersion: string }
  | { source: 'local'; sourceStamp: string }
  | { source: 'legacy'; raw: string };

/** Reads the stamp, tolerating the pre-JSON format. Older installs wrote the CLI's version as a
 * bare string, which can't be compared on the helper axis, so it reports `legacy` and is stale
 * exactly once (re-stamped; why the migration can't loop). */
function readInstalledMenubarStamp(): MenubarStamp | null {
  let raw: string;
  try {
    raw = fs.readFileSync(installedVersionMarkerPath(), 'utf-8').trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MenubarStamp;
    if (parsed && (parsed.source === 'release' || parsed.source === 'local')) return parsed;
  } catch {  }
  return { source: 'legacy', raw };
}

function installedExecutablePath(): string {
  return path.join(installedAppPath(), 'Contents', 'MacOS', MENUBAR_HELPER_EXECUTABLE_NAME);
}

/** Absolute path to the installed helper executable if it exists, else null. The desktop notifier
 * (notify-desktop.ts) runs `"AGI Menu" --notify ...` through it so notifications carry the
 * agents-cli mark. Null on non-darwin or when not installed. */
export function resolveInstalledMenubarExecutable(): string | null {
  if (!onDarwin()) return null;
  const exec = installedExecutablePath();
  return fs.existsSync(exec) ? exec : null;
}

function servicePlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceLabel()}.plist`);
}

function disabledSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar.disabled');
}

function menubarDisabledByUser(): boolean {
  // The opt-out sentinel is sticky across upgrades until the user explicitly enables it.
  return fs.existsSync(disabledSentinelPath());
}

function menubarServiceInstalled(): boolean {
  return onDarwin() && fs.existsSync(servicePlistPath());
}

/** Locates the source `.app`: 1) dist/lib/menubar/ (npm); 2) <repo>/bin/ (dev); 3) the on-disk
 * install's dist/ (Bun binary, virtual `/$bunfs/` URL); 4) the verified download cache for the
 * resolved release (tarball ships none, PHNX-4036), network-free. `shippedAppPath` is 1-3 only. */
function sourceAppPath(): string | null {
  // The independently versioned helper comes only from a shipped or verified cached bundle.
  const shipped = shippedAppPath();
  if (shipped) return shipped;
  const cached = cachedReleaseBundlePath();
  if (fs.existsSync(cached)) return cached;
  return null;
}

function shippedAppPath(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, APP_BUNDLE_NAME));
    candidates.push(path.resolve(here, '..', '..', '..', 'bin', APP_BUNDLE_NAME));
  } catch {
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Candidate 4, only reached when the sibling candidates miss (Bun single-file binary, virtual
  // `/$bunfs/` path). Resolve the launcher symlink lazily so the common Node path pays no extra
  // filesystem probe.
  const layout = resolveInstalledLayout();
  if (layout) {
    const p = path.join(layout.distDir, 'lib', 'menubar', APP_BUNDLE_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function cachedFloorBundlePath(): string {
  return path.join(menubarHelperCacheDir(helperFloor('menubar')), APP_BUNDLE_NAME);
}

/** Where the downloaded copy of the RESOLVED release sits (the floor's cache dir until a newer one
 * is resolved). The startup self-heal installs from here, network-free. */
export function cachedReleaseBundlePath(): string {
  return path.join(menubarHelperCacheDir(cachedMenubarVersion()), APP_BUNDLE_NAME);
}

/** The release version an explicit install should fetch: the newest published, but never below what
 * this Mac runs, so a deleted release can't roll the helper back through `setup`/`enable`. */
async function menubarVersionToInstall(opts: { force?: boolean } = {}): Promise<string> {
  const resolved = await resolveMenubarVersion({ force: opts.force });
  const installed = readInstalledMenubarStamp();
  // This independently versioned helper never rolls back to an older resolved floor.
  if (installed?.source === 'release' && compareVersions(installed.helperVersion, resolved) > 0) return installed.helperVersion;
  return resolved;
}

function resolveCliEntry(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const entry = path.resolve(here, '..', '..', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {
  }
  return null;
}

/** Registers the new bundle with LaunchServices (`lsregister -f`). It lives in Application Support
 * and starts via launchd, so LS may never see it, and `--notify` notifications would show a blank
 * left-hand app icon. Best-effort; never blocks install. */
function refreshBundleIconRegistration(appPath: string): void {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  const bin = fs.existsSync(lsregister) ? lsregister : 'lsregister';
  const r = spawnSync(bin, ['-f', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.error) {
  }
}

export function codesignVerifies(appPath: string): boolean {
  const r = spawnSync('codesign', ['--verify', '--strict', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/** True when Gatekeeper will let the bundle execute. A Developer-ID-signed but un-notarized app
 * fails `spctl --assess` ("damaged", can crash AppKit), separate from `codesign --verify`. Launch
 * guards use this to fail loud rather than bootstrap a rejected helper. */
export function gatekeeperAssesses(appPath: string): boolean {
  const r = spawnSync('spctl', ['--assess', '--type', 'exec', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

export function hasDeveloperIdSignature(appPath: string): boolean {
  const r = spawnSync('codesign', ['-dv', '--verbose=4', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const out = `${r.stderr || ''}${r.stdout || ''}`;
  const team = out.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
  return Boolean(team && team !== 'not set');
}

/** Copies the bundled `.app` to the stable user path (idempotent unless forced); returns the
 * executable path, or null if no source ships. Also heals an install ad-hoc re-signed over a
 * Developer ID source (which re-prompted Accessibility every upgrade). */
export function ensureMenubarAppInstalled(opts: { forceReinstall?: boolean; sourceAppPath?: string } = {}): string | null {
  if (!onDarwin()) return null;
  // An explicit `sourceAppPath` (pre-downloaded cache path) overrides local discovery. This
  // function does NO network; the async callers download first, so the sync startup self-heal
  // stays network-free and no-ops when nothing is found.
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return null;
  const dest = installedAppPath();
  const needsInstall = (): boolean => {
    if (opts.forceReinstall) return true;
    if (!fs.existsSync(dest)) return true;
    return hasDeveloperIdSignature(src) && !hasDeveloperIdSignature(dest);
  };
  if (!needsInstall()) return installedExecutablePath();
  // Serialize the atomic install so concurrent `agents` invocations (darwin startup path) don't
  // race the swap or re-copy; that stampede transiently corrupted MenubarHelper.app and tripped
  // the "damaged" dialog.
  withInstallLock(dest, (heartbeat) => {
    if (!needsInstall()) return;
    copyAppBundle(src, dest);
    heartbeat();
    refreshBundleIconRegistration(dest);
  });
  return installedExecutablePath();
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateServicePlist(execPath: string): string {
  const home = os.homedir();
  const logPath = path.join(getHelpersDir(), 'menubar', 'menubar.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  // Bake interpreter + entry + bin so the GUI helper reaches the CLI with no login PATH. HOME too
  // (RUSH-2639): launchd applies this dict over the LOGIN SESSION's env, so a test fork's helper
  // otherwise bootstrapped the runner's real `~/.agents`.
  const env: Record<string, string> = {
    PATH: `/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${path.dirname(process.execPath)}:${home}/.local/bin`,
    ...serviceManifestHomeEnv(),
  };
  const node = process.execPath;
  const entry = resolveCliEntry();
  const bin = resolveAgentsBin();
  if (node && entry) {
    env.AGENTS_NODE = node;
    env.AGENTS_ENTRY = entry;
  }
  if (bin) env.AGENTS_BIN = bin;

  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${serviceLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(execPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${MENUBAR_THROTTLE_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>`;
}

/** Restarts the launchd agent from clean state. Always `bootout` first: `bootstrap` fails on an
 * already-bootstrapped job and `load -w` is unreliable. After a WindowServer disconnect a plain
 * `kickstart -k` may not revive it; bootout + fresh bootstrap does. */
export function restartMenubarLaunchAgent(
  uid: number,
  plist: string,
  exec: (cmd: string, args: readonly string[], opts: { stdio: ['ignore', 'ignore', 'ignore'] }) => Buffer = execFileSync,
): void {
  const reg = serviceManagerRegistrationAllowed();
  if (!reg.allowed) {
    process.stderr.write(`[agents] ${reg.reason}\n`);
    return;
  }

  const serviceTarget = `gui/${uid}/${serviceLabel()}`;
  const opts: { stdio: ['ignore', 'ignore', 'ignore'] } = { stdio: ['ignore', 'ignore', 'ignore'] };
  try { exec('launchctl', ['bootout', serviceTarget], opts); } catch {  }
  try { exec('launchctl', ['bootstrap', `gui/${uid}`, plist], opts); } catch {  }
  try { exec('launchctl', ['kickstart', serviceTarget], opts); } catch {  }
}

/** Forces a running helper off a just-swapped binary. `restartMenubarLaunchAgent` fails silently
 * from a shell with no Aqua session (tmux/ssh, verified live). Tries `kickstart -k`, then ends
 * only the confirmed-own pids (never pkill); KeepAlive relaunches from the new binary. */
export function restartMenubarHelperAfterSwap(
  uid: number,
  ownProcesses: readonly MenubarProcess[],
  exec: (cmd: string, args: readonly string[], opts: { stdio: ['ignore', 'ignore', 'ignore'] }) => Buffer = execFileSync,
  kill: (pid: number) => void = endProcess,
): void {
  const reg = serviceManagerRegistrationAllowed();
  if (!reg.allowed) return;
  const target = `gui/${uid}/${serviceLabel()}`;
  const opts: { stdio: ['ignore', 'ignore', 'ignore'] } = { stdio: ['ignore', 'ignore', 'ignore'] };
  try {
    exec('launchctl', ['kickstart', '-k', target], opts);
    return;
  } catch {
    for (const p of ownProcesses) kill(p.pid);
  }
}

/** Sync install + start for an already-on-disk source `.app`, NO network (bundled copy for the
 * self-heal, or a pre-downloaded cache for enable/setup). False on non-darwin, no source, or
 * failed Gatekeeper. Shared by the self-heal and `enableMenubarService`. */
function startMenubarServiceFromSource(opts: { clearOptOut?: boolean; sourceAppPath?: string } = {}): boolean {
  if (!onDarwin()) return false;
  // Resolve the source HERE, once, and pass the SAME value to installer and stamp. Passing
  // `opts.sourceAppPath` let them disagree (installer fell back to `sourceAppPath()`): a LOCAL
  // build stamped as a release, kind mismatch, reinstall forever (#2109).
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return false;
  const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
  if (!exec) return false;

  // Never bootstrap a helper macOS will reject: an invalid signature crash-loops under KeepAlive,
  // an un-notarized bundle is "damaged". A shipped helper is signed AND notarized, so skip the
  // service and point at the upgrade; never re-sign.
  if (!(codesignVerifies(installedAppPath()) && gatekeeperAssesses(installedAppPath()))) {
    process.stderr.write(
      'agents: AGI Menu is not notarized/valid on this machine; skipping launch. ' +
      'Upgrade to a notarized build (npm i -g @phnx-labs/agents-cli), then `agents menubar setup`.\n'
    );
    return false;
  }

  if (opts.clearOptOut) clearMenubarOptOut();
  installAndStartService(exec, stampFor(src));
  return true;
}

/** Installs + starts the helper as a launchd user service (idempotent). ASYNC, the EXPLICIT path
 * (`agents menubar enable`): with no local `.app` it downloads and verifies the release. The
 * startup self-heal never routes here. */
export async function enableMenubarService(opts: { clearOptOut?: boolean } = { clearOptOut: true }): Promise<boolean> {
  if (!onDarwin()) return false;
  let src = shippedAppPath();
  if (!src) src = await downloadMenubarHelperApp(await menubarVersionToInstall());
  return startMenubarServiceFromSource({ ...opts, sourceAppPath: src });
}

function clearMenubarOptOut(): void {
  try { fs.rmSync(disabledSentinelPath(), { force: true }); } catch {  }
}

/** Writes the plist for `exec`, restarts the job, stamps the installed version. Shared by
 * `enableMenubarService` and `runMenubarSetup` so they can't drift; the stamp drives the upgrade
 * self-heal, and skipping it would reinstall on every run. */
function installAndStartService(exec: string, stamp: MenubarStamp): void {
  const plist = servicePlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, generateServicePlist(exec));
  restartMenubarLaunchAgent(process.getuid?.() ?? 0, plist);
  try {
    fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stamp));
  } catch {  }
}

/** Renders a stamp as a comparable version string. A local build reports `local`, which the
 * ownership contest treats as not comparable and falls to its owner arm: a dev build must never
 * win a version contest against a release. */
export function stampVersionLabel(stamp: MenubarStamp | null): string | null {
  if (!stamp) return null;
  if (stamp.source === 'release') return stamp.helperVersion;
  if (stamp.source === 'legacy') return null;
  return LOCAL_BUILD_LABEL;
}

function availableStamp(): MenubarStamp {
  const src = sourceAppPath();
  // No local bundle means the release path: the newest published helper this machine has resolved
  // (cached, day-old at most), never below the floor; the floor itself before the first resolution
  // or offline.
  return src ? stampFor(src) : { source: 'release', helperVersion: cachedMenubarVersion() };
}

function availableHelperLabel(): string {
  return stampVersionLabel(availableStamp()) ?? LOCAL_BUILD_LABEL;
}

/** Identifies the bundle about to be installed. A RELEASE iff it sits under the helper's download
 * cache (via `menubarHelperCacheDir`), not a `/v<x.y.z>/` regex, which misreads both ways;
 * flipping `source` between runs is a kind change, stale unconditionally, i.e. a reinstall loop. */
export function stampFor(resolvedSourceAppPath: string): MenubarStamp {
  const version = releaseVersionOfCachedBundle(resolvedSourceAppPath);
  if (version) return { source: 'release', helperVersion: version };
  let mtime = 0;
  try { mtime = fs.statSync(resolvedSourceAppPath).mtimeMs; } catch {  }
  return { source: 'local', sourceStamp: `${resolvedSourceAppPath}@${mtime}` };
}

/** The helper version a path denotes, iff it is inside that version's cache dir; null for anything
 * else, including a version-shaped path that isn't the cache. */
export function releaseVersionOfCachedBundle(
  appPath: string,
  cacheDirFor: (v: string) => string = menubarHelperCacheDir,
): string | null {
  // Try EVERY version-shaped segment, not just the leftmost: a cached bundle under a path with an
  // unrelated `vX.Y.Z` (nvm dir, versioned volume) would match the first, fail the prefix check
  // and be misclassified as local.
  const resolved = path.resolve(appPath);
  for (const m of appPath.matchAll(/v(\d+\.\d+\.\d+)/g)) {
    const expected = path.resolve(cacheDirFor(m[1]));
    if (resolved === expected || resolved.startsWith(expected + path.sep)) return m[1];
  }
  return null;
}

/** Pure staleness decision on the HELPER axis, not the CLI's (that reinstalled unchanged helpers
 * every release, #2109). Stale when: exec gone; no stamp; `legacy` stamp; install KIND changed
 * (local <-> release); a newer release helper; or a local source path/mtime moved. */
export function isMenubarStale(opts: {
  installed: MenubarStamp | null;
  available: MenubarStamp;
  execExists: boolean;
}): boolean {
  if (!opts.execExists) return true;
  const { installed, available } = opts;
  if (!installed) return true;
  if (installed.source === 'legacy') return true;
  if (installed.source !== available.source) return true;
  if (installed.source === 'release' && available.source === 'release') {
    return compareVersions(available.helperVersion, installed.helperVersion) > 0;
  }
  if (installed.source === 'local' && available.source === 'local') {
    return installed.sourceStamp !== available.sourceStamp;
  }
  return true;
}

function menubarSetupStale(): boolean {
  return isMenubarStale({
    installed: readInstalledMenubarStamp(),
    available: availableStamp(),
    execExists: fs.existsSync(installedExecutablePath()),
  });
}

/** Pure: should the detached worker download the floor release into the cache? The self-heal is
 * network-free and the tarball ships no bundle. Fetch when nothing else is a source, not opted
 * out, and no service exists or the helper is older than the floor. */
export function menubarHelperPrefetchNeeded(opts: {
  darwin: boolean;
  disabledByUser: boolean;
  hasSource: boolean;
  serviceInstalled: boolean;
  stale: boolean;
}): boolean {
  if (!opts.darwin || opts.disabledByUser || opts.hasSource) return false;
  return !opts.serviceInstalled || opts.stale;
}

/** Background half of the release-path self-heal: downloads + verifies the floor release into the
 * cache when `menubarHelperPrefetchNeeded` says so; returns the path or null. Run from the
 * detached auto-pull worker, never awaited. */
export async function prefetchMenubarHelper(): Promise<string | null> {
  const needed = menubarHelperPrefetchNeeded({
    darwin: onDarwin(),
    disabledByUser: menubarDisabledByUser(),
    hasSource: Boolean(sourceAppPath()),
    serviceInstalled: menubarServiceInstalled(),
    stale: menubarSetupStale(),
  });
  if (!needed) return null;
  return downloadMenubarHelperApp(await menubarVersionToInstall());
}

/** Pure decision: did THIS heal replace bundle content a live process could be stale against,
 * versus a plist-only repoint? `stale` and `needsDevIdHeal` count; a repoint-only heal doesn't
 * (RUSH-3005 owns that churn, and restarting on each would double it). */
export function menubarHealReplacedBundle(opts: {
  stale: boolean;
  needsDevIdHeal: boolean;
}): boolean {
  return opts.stale || opts.needsDevIdHeal;
}

/** Pure re-point decision: the plist's baked interpreter/entry no longer match the install now
 * running `agents` (DUAL-INSTALL skew a version bump can't catch). A null active entry (dev/tsx
 * run) never triggers a re-point. */
export function menubarPlistNeedsRepoint(opts: {
  plistEntry: string | null;
  plistNode: string | null;
  plistNodeExists: boolean;
  activeEntry: string | null;
  activeNode: string | null;
}): boolean {
  if (!opts.activeEntry) return false;
  if (opts.plistEntry !== opts.activeEntry) return true;
  // The entry path owns the helper. The same CLI may run through several valid Node interpreters;
  // repointing on those differences would replace and relaunch the shared helper on every
  // invocation. Keep the recorded interpreter until it disappears, then repoint to the active one.
  if (opts.activeNode && (!opts.plistNode || !opts.plistNodeExists)) return true;
  return false;
}

function readPlistEnvValue(key: string): string | null {
  try {
    const xml = fs.readFileSync(servicePlistPath(), 'utf-8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function menubarSetupNeedsRepoint(): boolean {
  const plistNode = readPlistEnvValue('AGENTS_NODE');
  return menubarPlistNeedsRepoint({
    plistEntry: readPlistEnvValue('AGENTS_ENTRY'),
    plistNode,
    plistNodeExists: Boolean(plistNode) && fs.existsSync(plistNode as string),
    activeEntry: resolveCliEntry(),
    activeNode: process.execPath,
  });
}

/** Stops and removes the menu-bar service and writes the sticky opt-out so the upgrade migration
 * won't re-enable it. */
export function disableMenubarService(): void {
  if (!onDarwin()) return;
  const plist = servicePlistPath();
  const reg = serviceManagerRegistrationAllowed();
  if (reg.allowed) {
    const uid = process.getuid?.() ?? 0;
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${serviceLabel()}`], { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {  } }
  } else {
    process.stderr.write(`[agents] ${reg.reason}\n`);
  }
  try { fs.unlinkSync(plist); } catch {  }
  try {
    fs.mkdirSync(path.dirname(disabledSentinelPath()), { recursive: true });
    fs.writeFileSync(disabledSentinelPath(), `disabled ${new Date().toISOString()}\n`);
  } catch {  }
}

/** Which install may (re)install the shared helper (#2109). Every agents-cli copy reads the others'
 * stamp as drift and recopies, killing the live helper in a loop. No content comparison (each
 * release is re-notarized): installed version decides; cooldown bounds legacy takeover. */
export function mayInstallMenubarHelper(opts: {
  plistEntry: string | null;
  activeEntry: string | null;
  ownerEntryExists: boolean;
  helperExecMissing: boolean;
  needsDevIdHeal: boolean;
  installedVersion: string | null;
  currentVersion: string | null;
  msSinceLastHeal: number | null;
  cooldownMs: number;
  sourceIsDeveloperId: boolean;
}): boolean {
  // Repairs are never gated: a missing binary or broken signing identity leaves the menu bar dead
  // or re-prompting, and no other install can be fighting over a bundle that isn't there. Gating
  // them made the first version a silent stuck state.
  if (opts.helperExecMissing || opts.needsDevIdHeal) return true;
  if (!opts.activeEntry) return false;
  if (!opts.plistEntry) return true;
  // Owner entry gone: this install may adopt the helper, but a non-Developer-ID source may NOT
  // seize a healthy one (ad-hoc fails the Accessibility grant's code requirement and Gatekeeper,
  // RUSH-2134). No deadlock: escape (1) lets any source repair a missing or ad-hoc install.
  if (!opts.ownerEntryExists) return opts.sourceIsDeveloperId;
  // `local` is a KIND marker, not a version; compareVersions would order it against semver
  // arbitrarily. When either side is local the version arm is skipped and the owner arm decides.
  const comparableVersions =
    opts.installedVersion && opts.currentVersion &&
    opts.installedVersion !== LOCAL_BUILD_LABEL && opts.currentVersion !== LOCAL_BUILD_LABEL;
  if (comparableVersions) {
    const versionOrder = compareVersions(opts.currentVersion!, opts.installedVersion!);
    if (versionOrder > 0) return opts.sourceIsDeveloperId;
    if (versionOrder < 0) return false;
    return opts.plistEntry === opts.activeEntry;
  }
  if (opts.plistEntry === opts.activeEntry) return true; // we are the owner
  // Foreign install while the owner exists: refusing outright strands users whose recorded owner
  // is a stale copy, so takeover is allowed once per cooldown. Ad-hoc/dev copies never take over
  // this way (Gatekeeper "damaged", RUSH-2134), only when the owner is gone.
  if (!opts.sourceIsDeveloperId) return false;
  return opts.msSinceLastHeal === null || opts.msSinceLastHeal >= opts.cooldownMs;
}

/** How long a non-owner install waits before taking over an unversioned legacy helper: long enough
 * for at most one restart an hour on a multi-install box, short enough that a user who switched
 * installs gets their upgrade. */
const MENUBAR_TAKEOVER_COOLDOWN_MS = 60 * 60 * 1000;

function lastHealMarkerPath(): string {
  return path.join(installDir(), '.menubar-last-heal');
}

function msSinceLastMenubarHeal(): number | null {
  try {
    const t = Number(fs.readFileSync(lastHealMarkerPath(), 'utf-8').trim());
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Date.now() - t);
  } catch {
    return null;
  }
}

function stampMenubarHeal(): void {
  try {
    fs.mkdirSync(installDir(), { recursive: true });
    fs.writeFileSync(lastHealMarkerPath(), String(Date.now()));
  } catch {  }
}

function mayHealMenubar(needsDevIdHeal: boolean): boolean {
  const plistEntry = readPlistEnvValue('AGENTS_ENTRY');
  const src = sourceAppPath();
  return mayInstallMenubarHelper({
    plistEntry,
    activeEntry: resolveCliEntry(),
    ownerEntryExists: Boolean(plistEntry) && fs.existsSync(plistEntry as string),
    helperExecMissing: !fs.existsSync(installedExecutablePath()),
    needsDevIdHeal,
    installedVersion: stampVersionLabel(readInstalledMenubarStamp()),
    currentVersion: availableHelperLabel(),
    msSinceLastHeal: msSinceLastMenubarHeal(),
    cooldownMs: MENUBAR_TAKEOVER_COOLDOWN_MS,
    sourceIsDeveloperId: Boolean(src) && hasDeveloperIdSignature(src as string),
  });
}

/** Startup self-heal on every darwin CLI invocation (src/index.ts); a cheap no-op unless there is
 * no service (enable) or the stamp changed / helper missing (re-enable). The ownership check stops
 * installs looping (#2109). Never throws into startup. */
export function installMenubarLaunchAgentOnUpgrade(): void {
  try {
    if (!onDarwin()) return;
    if (menubarDisabledByUser()) return;
    if (!sourceAppPath()) return;
    if (!menubarServiceInstalled()) {
      startMenubarServiceFromSource({ clearOptOut: false });
      return;
    }
    // Re-enable (recopy helper + rewrite plist) when the version drifted, OR the plist's baked
    // interpreter/entry no longer point at the running install, OR the installed copy is still
    // ad-hoc while the shipped source is Developer ID (Accessibility re-prompts).
    const needsDevIdHeal = installedNeedsDevIdHeal();
    const stale = menubarSetupStale();
    if (!(stale || menubarSetupNeedsRepoint() || needsDevIdHeal)) return;
    if (!mayHealMenubar(needsDevIdHeal)) return;
    // Stamp only a heal that actually happened: `enableMenubarService` returns false on a
    // Gatekeeper failure, and stamping first would spend the shared cooldown on a no-op, locking
    // non-owners out for another hour with nothing fixed.
    if (startMenubarServiceFromSource({ clearOptOut: false })) {
      stampMenubarHeal();
      if (shouldMigrateMenubarTcc({ needsDevIdHeal, alreadyMigrated: menubarTccAlreadyMigrated() })) {
        resetMenubarAccessibilityTcc();
      }
      // Only a REAL content swap (version bump or Dev-ID transition) can leave a process on stale
      // code; a plist-only repoint is RUSH-3005's churn to own, not this heal's to restart on top
      // of.
      if (menubarHealReplacedBundle({ stale, needsDevIdHeal })) {
        restartMenubarHelperAfterSwap(process.getuid?.() ?? 0, liveMenubarProcesses().own);
      }
    }
  } catch {
  }
}

function installedNeedsDevIdHeal(): boolean {
  const src = sourceAppPath();
  if (!src || !fs.existsSync(installedAppPath())) return false;
  if (hasDeveloperIdSignature(installedAppPath())) return false;
  return hasDeveloperIdSignature(src);
}

function tccMigrationMarkerPath(): string {
  return path.join(installDir(), '.menubar-tcc-migrated');
}

function menubarTccAlreadyMigrated(): boolean {
  return fs.existsSync(tccMigrationMarkerPath());
}

/** Pure decision: run the one-time `tccutil reset Accessibility` only on a real ad-hoc -> Developer
 * ID transition, and only once. An always-Developer-ID machine has no dead row (a reset would
 * force a needless re-prompt); a migrated one must not reset again. */
export function shouldMigrateMenubarTcc(opts: {
  needsDevIdHeal: boolean;
  alreadyMigrated: boolean;
}): boolean {
  return opts.needsDevIdHeal && !opts.alreadyMigrated;
}

/** Resets the stale Accessibility grant recorded against the old ad-hoc identity, then stamps a
 * marker so it runs once per machine. Targets `SERVICE_LABEL_BASE` (the real bundle id TCC keys
 * on), not `serviceLabel()` (RUSH-2639). Best-effort: a failing `tccutil` must not block the heal. */
export function resetMenubarAccessibilityTcc(
  exec: (cmd: string, args: readonly string[], opts: { stdio: ['ignore', 'ignore', 'ignore'] }) => Buffer = execFileSync,
): void {
  try {
    exec('tccutil', ['reset', 'Accessibility', SERVICE_LABEL_BASE], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {  }
  try {
    fs.mkdirSync(installDir(), { recursive: true });
    fs.writeFileSync(tccMigrationMarkerPath(), new Date().toISOString());
  } catch {  }
}

export interface SetupStep {
  name: string;
  outcome: 'ok' | 'changed' | 'failed';
  detail: string;
}

export interface SetupResult {
  steps: SetupStep[];
  configured: boolean;
  status: MenubarStatus;
}

/** Decides which live helper processes to end so one status item survives. EVERY process is ended,
 * including the wanted one: the caller re-kickstarts the service, so the survivor is launchd's.
 * Keeping one from `ps` could keep the unmanaged copy. */
export function processesToEnd(status: Pick<MenubarStatus, 'instances' | 'foreignInstances'>): MenubarProcess[] {
  return [...status.instances, ...status.foreignInstances];
}

function endProcess(pid: number): void {
  try { process.kill(pid, 'SIGTERM'); } catch {  }
}

/** `agents menubar setup`: configures the menu bar end-to-end and idempotently: one status item
 * owned by a launchd service. Reported steps: bundle, signature (macOS 26+ SIGKILLs an invalid
 * one), duplicates, login item (RunAtLoad + KeepAlive), single instance. */
export async function runMenubarSetup(): Promise<SetupResult> {
  const steps: SetupStep[] = [];
  const step = (name: string, outcome: SetupStep['outcome'], detail: string) => {
    steps.push({ name, outcome, detail });
  };

  if (!onDarwin()) {
    step('platform', 'failed', `AGI Menu is macOS only (this is ${process.platform})`);
    return { steps, configured: false, status: getMenubarStatus() };
  }

  const before = getMenubarStatus();

  // Explicit user-initiated path: with no bundled/local `.app` (fresh `npm i -g`), fetch the
  // signed, notarized release asset for this CLI version, verified (sha256, codesign, Team, DR
  // pin, notarization); the cached copy is the source for `ensureMenubarAppInstalled`.
  let src = shippedAppPath();
  if (!src) {
    try {
      src = await downloadMenubarHelperApp(await menubarVersionToInstall({ force: true }));
    } catch (e) {
      step('bundle', 'failed', `no AGI Menu bundle ships with this install, and the release-asset download failed: ${(e as Error).message}`);
      return { steps, configured: false, status: before };
    }
  }

  const doomed = processesToEnd(before);
  for (const p of doomed) endProcess(p.pid);
  if (doomed.length > 1) {
    step('duplicates', 'changed',
      `ended ${doomed.length} running helpers (${doomed.map((p) => p.pid).join(', ')}) — launchd restarts exactly one`);
  } else if (doomed.length === 1) {
    step('duplicates', 'ok', 'one helper was running; restarting it under launchd');
  } else {
    step('duplicates', 'ok', 'no helper was running');
  }

  const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
  if (!exec) {
    step('bundle', 'failed', 'could not install the helper bundle');
    return { steps, configured: false, status: getMenubarStatus() };
  }
  // Compare the STAMPS, not their labels: `stampVersionLabel` collapses every local build to
  // 'local', so a real dev rebuild would print "ok". The same collapse is excluded in
  // `versionMatches` and `mayInstallMenubarHelper`; this was the third site.
  const bundleStamp = readInstalledMenubarStamp();
  // Reuse the canonical comparator rather than a `JSON.stringify` compare, which relied on an
  // implicit key-order dependency when isMenubarStale already answers this question.
  const bundleUnchanged =
    bundleStamp !== null &&
    !isMenubarStale({ installed: bundleStamp, available: availableStamp(), execExists: true });
  step('bundle', bundleUnchanged ? 'ok' : 'changed',
    `${installedAppPath()} (${stampVersionLabel(bundleStamp) ?? 'unknown'})`);

  if (!(codesignVerifies(installedAppPath()) && gatekeeperAssesses(installedAppPath()))) {
    step('signature', 'failed',
      'not notarized/valid on this machine — refusing to start it (Gatekeeper rejects an ' +
      'un-notarized helper as "damaged"). Upgrade to a notarized build of agents-cli.');
    return { steps, configured: false, status: getMenubarStatus() };
  }
  step('signature', 'ok', 'valid + notarized');

  clearMenubarOptOut();

  installAndStartService(exec, stampFor(src ?? undefined));
  step('login item', before.serviceInstalled ? 'ok' : 'changed',
    `${serviceLabel()} — starts at login, restarts if it dies`);

  const after = waitForSingleInstance();
  if (after.instances.length === 1 && after.foreignInstances.length === 0) {
    step('single instance', 'ok', `pid ${after.instances[0].pid}`);
  } else if (after.instances.length === 0) {
    step('single instance', 'failed', 'the helper did not come back up — see `agents menubar status`');
  } else {
    const extra = [...after.instances.slice(1), ...after.foreignInstances];
    step('single instance', 'failed',
      `${after.instances.length + after.foreignInstances.length} helpers running (${extra.map((p) => p.pid).join(', ')} are extra)`);
  }

  return {
    steps,
    configured: steps.every((s) => s.outcome !== 'failed'),
    status: after,
  };
}

/** Polls (up to ~3s) for launchd to bring the single helper back; returns the last status read
 * either way, and the caller decides what a miss means. */
function waitForSingleInstance(): MenubarStatus {
  let status = getMenubarStatus();
  for (let i = 0; i < 15 && status.instances.length !== 1; i++) {
    sleepSync(200);
    status = getMenubarStatus();
  }
  return status;
}

export interface MenubarProcess {
  pid: number;
  executable: string;
}

function parsePsLines(psOutput: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** Splits live MenubarHelper processes into the installed bundle's own (`own`) and every other copy
 * (`foreign`); `pgrep -f` conflated them, so a dev build could hold Cmd-Shift-V while status said
 * healthy. `own` is a LIST. Identity comes from `comm`, not the command line. */
export function classifyMenubarProcesses(
  commOutput: string,
  commandOutput: string,
  installedExec: string,
): { own: MenubarProcess[]; foreign: MenubarProcess[] } {
  const commands = parsePsLines(commandOutput);
  const own: MenubarProcess[] = [];
  const foreign: MenubarProcess[] = [];
  for (const [pid, executable] of parsePsLines(commOutput)) {
    if (path.basename(executable) !== MENUBAR_HELPER_EXECUTABLE_NAME) continue;
    if ((commands.get(pid) || '').includes('--notify')) continue;
    if (executable === installedExec) own.push({ pid, executable });
    else foreign.push({ pid, executable });
  }
  return { own, foreign };
}

export interface MenubarStatus {
  platform: string;
  source: string | null;
  installedApp: string | null;
  installedVersion: string | null;
  currentVersion: string;
  cliVersion: string;
  stale: boolean;
  serviceInstalled: boolean;
  running: boolean;
  instances: MenubarProcess[];
  foreignInstances: MenubarProcess[];
  disabledByUser: boolean;
}

function liveMenubarProcesses(): { own: MenubarProcess[]; foreign: MenubarProcess[] } {
  if (!onDarwin()) return { own: [], foreign: [] };
  const ps = (format: string) =>
    spawnSync('ps', ['-axo', format], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' });
  const comm = ps('pid=,comm=');
  const command = ps('pid=,command=');
  if (comm.status !== 0 || command.status !== 0) return { own: [], foreign: [] };
  return classifyMenubarProcesses(comm.stdout || '', command.stdout || '', installedExecutablePath());
}

export function getMenubarStatus(): MenubarStatus {
  const dest = installedAppPath();
  const { own, foreign } = liveMenubarProcesses();
  const serviceInstalled = menubarServiceInstalled();
  return {
    platform: process.platform,
    source: sourceAppPath(),
    installedApp: fs.existsSync(dest) ? dest : null,
    installedVersion: stampVersionLabel(readInstalledMenubarStamp()),
    currentVersion: availableHelperLabel(),
    cliVersion: getCliVersion(),
    stale: onDarwin() && serviceInstalled && menubarSetupStale(),
    serviceInstalled,
    running: own.length > 0,
    instances: own,
    foreignInstances: foreign,
    disabledByUser: menubarDisabledByUser(),
  };
}

export interface MenubarDoctorReport {
  platform: string;
  installPath: string | null;
  installedVersion: string | null;
  currentVersion: string;
  cliVersion: string;
  versionMatches: boolean;
  signingIdentity: 'developer-id' | 'ad-hoc' | 'unknown';
  running: boolean;
  staleRunningProcess: PidStaleness[];
  accessibilityHintNeeded: boolean;
}

export interface PidStaleness {
  pid: number;
  stale: boolean;
}

/** Pure comparison: a helper pid started before the bundle was last written still runs the OLD
 * binary. `ps -o lstart` has whole seconds but mtime sub-second, so a raw `<` called
 * just-restarted helpers stale on every upgrade (zion, 1.22.46); truncate mtime first. */
export function isMenubarProcessStaleAgainstBundle(pidStartedAtMs: number, bundleMtimeMs: number): boolean {
  return pidStartedAtMs < Math.floor(bundleMtimeMs / 1000) * 1000;
}

function pidStartTimeMs(pid: number): number | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) return null;
  const raw = (r.stdout || '').trim();
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? null : t;
}

/** `agents menubar doctor`: tells "why did Accessibility ask again" from "the helper is broken":
 * install path, version skew, signing-identity stability, and whether a live process predates its
 * bundle. Read-only; `agents menubar setup` fixes. */
export function buildMenubarDoctorReport(): MenubarDoctorReport {
  if (!onDarwin()) {
    return {
      platform: process.platform,
      installPath: null,
      installedVersion: null,
      currentVersion: getCliVersion(),
      cliVersion: getCliVersion(),
      versionMatches: false,
      signingIdentity: 'unknown',
      running: false,
      staleRunningProcess: [],
      accessibilityHintNeeded: false,
    };
  }
  const status = getMenubarStatus();
  const appPath = status.installedApp;
  const signingIdentity: MenubarDoctorReport['signingIdentity'] = appPath
    ? (hasDeveloperIdSignature(appPath) ? 'developer-id' : 'ad-hoc')
    : 'unknown';

  let staleRunningProcess: PidStaleness[] = [];
  if (appPath && status.instances.length > 0) {
    try {
      const bundleMtimeMs = fs.statSync(installedExecutablePath()).mtimeMs;
      staleRunningProcess = status.instances
        .map((p) => {
          const startedAt = pidStartTimeMs(p.pid);
          return startedAt === null
            ? null
            : { pid: p.pid, stale: isMenubarProcessStaleAgainstBundle(startedAt, bundleMtimeMs) };
        })
        .filter((p): p is PidStaleness => p !== null);
    } catch {  }
  }

  return {
    platform: process.platform,
    installPath: appPath,
    installedVersion: status.installedVersion,
    currentVersion: status.currentVersion,
    cliVersion: status.cliVersion,
    versionMatches:
      status.installedVersion === LOCAL_BUILD_LABEL && status.currentVersion === LOCAL_BUILD_LABEL
        ? true
        : status.installedVersion === status.currentVersion,
    signingIdentity,
    running: status.running,
    staleRunningProcess,
    accessibilityHintNeeded: signingIdentity === 'ad-hoc' || staleRunningProcess.some((p) => p.stale),
  };
}

interface MenubarUpdateResult {
  outcome: 'updated' | 'current' | 'skipped' | 'failed';
  installed: string | null;
  available: string;
  detail: string;
}

/** Brings an installed release helper up to the newest published build without `agents menubar
 * setup`; runs from the daemon self-heal tick and after `agents upgrade`. Moves only RELEASE
 * installs forward. Verified download, atomic swap, restart. Never throws. */
/** Pure: whether an auto-update pass should proceed, and why not. `shipped` is a bundle shipping
 * WITH this install (CLI upgrades own it, not the download cache). Null means proceed. */
export function menubarUpdateSkipReason(opts: {
  darwin: boolean;
  disabledByUser: boolean;
  serviceInstalled: boolean;
  shipped: boolean;
  installed: MenubarStamp | null;
}): string | null {
  if (!opts.darwin) return 'macOS only';
  if (opts.disabledByUser) return 'the menu bar is disabled (agents menubar disable)';
  if (!opts.serviceInstalled) return 'the menu bar is not installed on this Mac';
  if (opts.shipped) return 'this install ships its own helper bundle; the startup self-heal owns it';
  if (!opts.installed || opts.installed.source !== 'release') {
    return `installed helper is ${stampVersionLabel(opts.installed) ?? 'unstamped'}, not a release`;
  }
  return null;
}

export function menubarUpdateOutcome(installed: string, available: string): 'current' | 'updated' {
  return compareVersions(available, installed) > 0 ? 'updated' : 'current';
}

export async function updateMenubarHelperIfNewer(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<MenubarUpdateResult> {
  const installedStamp = readInstalledMenubarStamp();
  const installed = stampVersionLabel(installedStamp);
  const skip = (detail: string, available = cachedMenubarVersion()): MenubarUpdateResult =>
    ({ outcome: 'skipped', installed, available, detail });
  const reason = menubarUpdateSkipReason({
    darwin: onDarwin(),
    disabledByUser: menubarDisabledByUser(),
    serviceInstalled: menubarServiceInstalled(),
    shipped: Boolean(shippedAppPath()),
    installed: installedStamp,
  });
  if (reason) return skip(reason);
  const release = installedStamp as { source: 'release'; helperVersion: string };

  const available = await resolveMenubarVersion({ force: opts.force });
  if (menubarUpdateOutcome(release.helperVersion, available) === 'current') {
    return { outcome: 'current', installed, available, detail: `AGI Menu ${installed} is the newest published build` };
  }
  if (!mayHealMenubar(false)) return skip(`another install owns the helper; it will update on its own cooldown`, available);
  if (opts.dryRun) return { outcome: 'updated', installed, available, detail: `would update AGI Menu ${installed} → ${available}` };

  try {
    const src = await downloadMenubarHelperApp(available);
    const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
    if (!exec) return { outcome: 'failed', installed, available, detail: 'the verified bundle could not be installed' };
    try { fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stampFor(src))); } catch {  }
    stampMenubarHeal();
    restartMenubarHelperAfterSwap(process.getuid?.() ?? 0, liveMenubarProcesses().own);
    return { outcome: 'updated', installed, available, detail: `AGI Menu ${installed} → ${available}` };
  } catch (e) {
    return { outcome: 'failed', installed, available, detail: (e as Error).message };
  }
}
