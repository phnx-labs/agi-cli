/**
 * Install + lifecycle for the macOS menu-bar helper (`MenubarHelper.app`).
 *
 * Mirrors the stable-Application-Support-path-survives-npm-re-sign pattern and
 * a RunAtLoad + KeepAlive user service, the same shape the deleted embedded
 * secrets-agent used before it moved to the standalone secrets-cli (PHNX-3989).
 *
 * The helper is a no-Dock `.accessory` status-bar app. It reads live agent
 * state directly from disk and shells `agents` only for actions, so the plist
 * bakes in the node interpreter + entry point + bin path so the GUI process can
 * find the CLI without a login PATH.
 *
 * Opt-out is sticky: `agents menubar disable` drops a sentinel that the upgrade
 * migration (`installMenubarLaunchAgent` in migrate.ts) honors, so a disabled
 * menu bar never silently comes back on the next release.
 */

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

/**
 * The bundled executable's basename (RUSH-3101) — what launchd execs directly
 * inside `Contents/MacOS/`, bypassing LaunchServices name resolution. Before
 * this it was `MenubarHelper`, so that raw Mach-O basename is exactly what
 * macOS showed in System Settings > Privacy & Security > Accessibility and in
 * the "would like to control this computer" prompt. Renaming this constant
 * alone does NOT touch the bundle id, Team ID, or designated requirement
 * (`SERVICE_LABEL_BASE`, `MENUBAR_HELPER_BUNDLE_ID` in download-menubar.ts) —
 * those are what keep the existing Accessibility grant alive across upgrades.
 * Every basename-matching check reads this constant rather than re-deriving
 * the string; the Swift side (phnx-labs/agi-menu,
 * `Sources/MenubarHelper/HelperIdentity.swift`) has its own equal.
 */
export const MENUBAR_HELPER_EXECUTABLE_NAME = 'AGI Menu';

/**
 * launchd Label for this process's helper — the production identifier for a
 * real invocation, namespaced under a redirected HOME (RUSH-2639). launchd
 * routes bootout/bootstrap/kickstart by identifier alone, so without this a
 * hermetic test fork's own teardown boots out the operator's live helper.
 */
export function serviceLabel(): string {
  return namespacedServiceLabel(SERVICE_LABEL_BASE);
}

/**
 * Minimum seconds between launchd restarts of the helper (`ThrottleInterval`).
 *
 * The helper can crash at startup on a loaded machine: `NSApplication.shared`
 * segfaults inside `SLSNewConnection` when WindowServer is too starved to hand
 * out a connection. With `KeepAlive` and no throttle, launchd relaunches on its
 * 10s default, and each attempt spawns a fresh `agents doctor --json` before
 * dying — so a starved box gets hit harder the worse it gets. 30s bounds that
 * respawn rate while staying well inside "the menu bar came back on its own".
 *
 * This only paces the restarts. What actually stops the pile-up is the helper
 * bounding and group-killing its own children (agi-menu's
 * `Sources/MenubarHelper/ChildProcess.swift`); the two are complementary, not
 * alternatives.
 */
const MENUBAR_THROTTLE_SECONDS = 30;

function onDarwin(): boolean {
  return process.platform === 'darwin';
}

/** ~/Library/Application Support/agents-cli */
function installDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', INSTALL_DIR_NAME);
}

/** ~/Library/Application Support/agents-cli/MenubarHelper.app */
function installedAppPath(): string {
  return path.join(installDir(), APP_BUNDLE_NAME);
}

/**
 * Version stamp written next to the installed bundle. The upgrade self-heal
 * compares this against the running CLI's version to decide whether the App
 * Support copy + plist need to be rebuilt — without it, a `npm update` refreshes
 * dist/index.js but leaves the menu bar running the OLD helper binary and a
 * plist whose baked paths may have drifted.
 */
function installedVersionMarkerPath(): string {
  return path.join(installDir(), '.menubar-version');
}

/**
 * What the installed helper IS — deliberately not the CLI's version.
 *
 * `source` matters because the two install paths have different notions of
 * "changed": a release bundle is identified by its helper version, while a local
 * dev build has none (agi-menu's build.sh hardcodes CFBundleShortVersionString),
 * so it is identified by the source path + mtime it was copied from.
 */
/** Version label for a bundle that has none of its own (a local dev build). */
export const LOCAL_BUILD_LABEL = 'local';

export type MenubarStamp =
  | { source: 'release'; helperVersion: string }
  | { source: 'local'; sourceStamp: string }
  | { source: 'legacy'; raw: string };

/**
 * Read the stamp, tolerating the pre-JSON format.
 *
 * Older installs wrote a bare version string — and wrote the CLI's version into
 * it, which is the bug this replaces. Such a stamp cannot be compared on the
 * helper axis at all, so it reports `legacy` and is treated as stale exactly
 * once, which re-stamps it in the new format. That mirrors the existing
 * null-is-stale rule and is why the migration cannot loop.
 */
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
  } catch { /* fall through to legacy */ }
  return { source: 'legacy', raw };
}

/** Executable inside the installed bundle. */
function installedExecutablePath(): string {
  return path.join(installedAppPath(), 'Contents', 'MacOS', MENUBAR_HELPER_EXECUTABLE_NAME);
}

/**
 * Absolute path to the installed menu-bar helper executable if it exists on
 * disk, else null. The desktop notifier (notify-desktop.ts) routes daemon
 * notifications through this one-shot (`"AGI Menu" --notify ...`) so they
 * carry the agents-cli mark rather than the generic osascript icon. Null on
 * non-darwin or when the helper is not installed (menu bar disabled, a Linux
 * package, or a dev checkout without a built bundle).
 */
export function resolveInstalledMenubarExecutable(): string | null {
  if (!onDarwin()) return null;
  const exec = installedExecutablePath();
  return fs.existsSync(exec) ? exec : null;
}

/** ~/Library/LaunchAgents/com.phnx-labs.agents-menubar.plist */
function servicePlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${serviceLabel()}.plist`);
}

/** Sticky opt-out marker written by `agents menubar disable`. */
function disabledSentinelPath(): string {
  return path.join(getRuntimeStateDir(), 'menubar.disabled');
}

/** True if the user explicitly disabled the menu bar (don't auto-enable on upgrade). */
export function menubarDisabledByUser(): boolean {
  return fs.existsSync(disabledSentinelPath());
}

/** True if the launchd plist for the menu-bar service is installed. */
export function menubarServiceInstalled(): boolean {
  return onDarwin() && fs.existsSync(servicePlistPath());
}

/**
 * Locate the source `.app` shipped alongside the compiled JS.
 *   1. dist/lib/menubar/MenubarHelper.app — npm install layout (sibling of this file)
 *   2. <repo>/bin/MenubarHelper.app       — raw working tree (tsx/dev): the
 *      published bundle staged by scripts/stage-menubar-helper.sh, or a build
 *      copied in from a phnx-labs/agi-menu checkout
 *   3. <on-disk install>/dist/lib/menubar/MenubarHelper.app — Bun single-file
 *      binary: `import.meta.url` is a virtual `/$bunfs/` path, so the sibling
 *      candidates above can't see the on-disk bundle; recover it via the
 *      `agents` launcher symlink.
 *   4. the verified download cache for the FLOOR release — the npm tarball ships
 *      no bundle (PHNX-4036), so on an `npm i -g` machine this is the only
 *      source there is. It is filled by `agents menubar setup` or by the
 *      detached background worker (`prefetchMenubarHelper`), never here: this
 *      resolver stays network-free so the startup self-heal stays cheap. Last
 *      so a bundle that ships with the build always wins; keyed by the floor
 *      version so an older cached release is never picked up.
 */
function sourceAppPath(): string | null {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.join(here, APP_BUNDLE_NAME));
    candidates.push(path.resolve(here, '..', '..', '..', 'bin', APP_BUNDLE_NAME));
  } catch {
    /* import.meta.url unavailable */
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Candidate 4 — only reached when the sibling candidates miss (the Bun
  // single-file binary, whose `import.meta.url` is a virtual `/$bunfs/` path).
  // Resolve the launcher symlink lazily so the common Node path pays no extra
  // filesystem probe.
  const layout = resolveInstalledLayout();
  if (layout) {
    const p = path.join(layout.distDir, 'lib', 'menubar', APP_BUNDLE_NAME);
    if (fs.existsSync(p)) return p;
  }
  const cached = cachedFloorBundlePath();
  if (fs.existsSync(cached)) return cached;
  return null;
}

/** Where a downloaded copy of the floor release sits once fetched and verified. */
export function cachedFloorBundlePath(): string {
  return path.join(menubarHelperCacheDir(helperFloor('menubar')), APP_BUNDLE_NAME);
}

/** Resolve the compiled CLI entry (dist/index.js) so the helper can exec node directly. */
function resolveCliEntry(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/lib/menubar/install-menubar.js -> dist/index.js
    const entry = path.resolve(here, '..', '..', 'index.js');
    if (fs.existsSync(entry)) return entry;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Register the freshly-installed bundle with LaunchServices.
 *
 * The helper is copied to ~/Library/Application Support (not /Applications) and
 * launched only via launchd, so LaunchServices may never discover it on its own.
 * A daemon notification posted by the one-shot `MenubarHelper --notify` process is
 * attributed to this bundle, and macOS resolves the notification's LEFT-hand app
 * icon from the bundle's LaunchServices record — so a bundle LS doesn't know about
 * shows a blank app icon there (the right-hand contentImage is unaffected;
 * appIconImage reads the `.icns` directly). `lsregister -f` registers the bundle at
 * its current path so the OS can resolve its AppIcon for that slot. Best-effort:
 * LaunchServices is advisory, and a failure here must never block install.
 */
function refreshBundleIconRegistration(appPath: string): void {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  const bin = fs.existsSync(lsregister) ? lsregister : 'lsregister';
  const r = spawnSync(bin, ['-f', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (r.error) {
    /* lsregister missing / moved — advisory only, ignore. */
  }
}

/** True when the bundle carries a signature the kernel will accept at launch. */
export function codesignVerifies(appPath: string): boolean {
  const r = spawnSync('codesign', ['--verify', '--strict', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/**
 * True when Gatekeeper will let the bundle execute on this machine.
 * A Developer-ID-signed but un-notarized app is rejected by `spctl --assess`,
 * which macOS surfaces as "the app is damaged" and can crash AppKit during
 * launch. This is separate from `codesign --verify`: a signature can be valid
 * while Gatekeeper still refuses to run it. The helper's own release
 * (phnx-labs/agi-menu scripts/release.sh) notarizes + staples it and this repo's
 * stage-menubar-helper.sh re-verifies it, so a shipped bundle passes this; the
 * launch guards use it to fail loud rather than bootstrap a helper macOS would
 * reject.
 */
export function gatekeeperAssesses(appPath: string): boolean {
  const r = spawnSync('spctl', ['--assess', '--type', 'exec', appPath], { stdio: ['ignore', 'ignore', 'ignore'] });
  return r.status === 0;
}

/** True when the bundle carries a Developer ID TeamIdentifier (not ad-hoc). */
export function hasDeveloperIdSignature(appPath: string): boolean {
  const r = spawnSync('codesign', ['-dv', '--verbose=4', appPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const out = `${r.stderr || ''}${r.stdout || ''}`;
  const team = out.match(/TeamIdentifier=([A-Z0-9]+)/)?.[1];
  return Boolean(team && team !== 'not set');
}

/**
 * Copy the bundled `.app` to the stable user path (idempotent unless forced).
 * Returns the installed executable path, or null if no source bundle ships
 * with this install (e.g. Linux package, or a build without the helper).
 *
 * Also heals an older install that was ad-hoc re-signed over a Developer ID
 * source: that unstable identity made Accessibility re-prompt on every upgrade.
 * When the shipped source is Developer ID and the installed copy is only
 * ad-hoc, replace it — even without forceReinstall.
 */
export function ensureMenubarAppInstalled(opts: { forceReinstall?: boolean; sourceAppPath?: string } = {}): string | null {
  if (!onDarwin()) return null;
  // An explicit `sourceAppPath` (a pre-downloaded cache path from the explicit
  // enable/setup path) overrides local discovery. This function itself does NO
  // network — the download happens in the async callers before they hand a path
  // here, so the sync startup self-heal that calls it with no override stays
  // network-free and simply no-ops when `sourceAppPath()` finds nothing.
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return null;
  const dest = installedAppPath();
  // Heal an older install that was ad-hoc re-signed over a Developer ID source:
  // that unstable identity made Accessibility re-prompt on every upgrade.
  const needsInstall = (): boolean => {
    if (opts.forceReinstall) return true;
    if (!fs.existsSync(dest)) return true;
    return hasDeveloperIdSignature(src) && !hasDeveloperIdSignature(dest);
  };
  // Fast path: nothing to do.
  if (!needsInstall()) return installedExecutablePath();
  // Serialize the atomic install so concurrent `agents` invocations (this runs
  // on the darwin startup path) don't race the swap or each re-copy — the
  // stampede that transiently corrupted MenubarHelper.app and tripped the
  // "damaged" dialog.
  withInstallLock(dest, (heartbeat) => {
    if (!needsInstall()) return;
    copyAppBundle(src, dest);
    heartbeat(); // cp -R done; keep the lock fresh across lsregister
    // A fresh copy is exactly when the bundle's icon can be new (first install) or
    // superseded (upgrade) — register it so LaunchServices knows the bundle and can
    // resolve its AppIcon for the left-hand slot of daemon notifications.
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

  // Bake interpreter + entry + bin so the GUI helper can reach the CLI with no
  // login PATH. AgentsCLI.swift prefers [AGENTS_NODE, AGENTS_ENTRY] when both
  // exist, else falls back to AGENTS_BIN, else probes well-known paths.
  //
  // HOME is baked for the same reason (RUSH-2639, see service-manifest.ts):
  // launchd applies this dict on top of the LOGIN SESSION's environment, not the
  // environment of whoever called `launchctl bootstrap`. Without the key the
  // helper resolves the account home and every `agents` call it makes bootstraps
  // that home's `~/.agents` — which is how a hermetic test fork's helper wrote
  // into the runner's real home.
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

/**
 * Restart the menu-bar launchd agent from a clean state.
 *
 * Always `bootout` first: on modern macOS `bootstrap` fails when the job is
 * already bootstrapped, and the deprecated `load -w` fallback is unreliable.
 * A prior WindowServer disconnect can leave the job throttled so that a plain
 * `kickstart -k` does not bring it back; booting it out and bootstrapping fresh
 * is the only sequence that reliably re-attaches the status item.
 */
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
  try { exec('launchctl', ['bootout', serviceTarget], opts); } catch { /* may not be loaded */ }
  try { exec('launchctl', ['bootstrap', `gui/${uid}`, plist], opts); } catch { /* best effort */ }
  try { exec('launchctl', ['kickstart', serviceTarget], opts); } catch { /* best effort */ }
}

/**
 * Force a running helper off the binary that was just swapped underneath it.
 *
 * `installMenubarLaunchAgentOnUpgrade()` calls this after a heal actually
 * replaces the on-disk bundle (a version bump or the ad-hoc -> Developer ID
 * transition — see `menubarHealReplacedBundle`). `restartMenubarLaunchAgent`
 * (run moments earlier via `installAndStartService`) already attempts
 * bootout+bootstrap+kickstart, but that targets the GUI launchd domain and
 * fails silently — `launchctl kickstart -k gui/<uid>/<label>` prints "Could not
 * find service ... in domain for user gui" — from a shell with no Aqua session,
 * which is the ordinary case for `agents` invoked from a terminal/tmux/ssh
 * session rather than literally the login item (verified live). When that
 * happens the plist and on-disk bundle are current but the LIVE process is
 * still the old binary, so it requests Accessibility under the OLD code
 * identity and the grant never sticks.
 *
 * `kickstart -k` (force-restart, unlike the bare kickstart already tried) is
 * attempted first since it is the clean launchd-native path when it works. If
 * launchd has no record of the service in this context either, fall back to
 * ending the specific pid(s) already confirmed to be running the installed
 * bundle (`ownProcesses`, resolved by the caller via `liveMenubarProcesses`) —
 * never a broad pkill. The launchd plist has `KeepAlive=true`, so the ended
 * process is relaunched from the swapped binary within seconds.
 */
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

/**
 * Sync install + start core: install the given (already-on-disk) source `.app`
 * and start the launchd service. NO network — the source `.app` must already be
 * local (a bundled/local copy for the sync startup self-heal, or a pre-downloaded
 * cache path for the explicit async enable/setup path). Returns false on
 * non-darwin, when no source resolves, or when the bundle fails the Gatekeeper
 * check. Shared by the sync self-heal (`installMenubarLaunchAgentOnUpgrade`) and
 * the async `enableMenubarService`.
 */
function startMenubarServiceFromSource(opts: { clearOptOut?: boolean; sourceAppPath?: string } = {}): boolean {
  if (!onDarwin()) return false;
  // Resolve the source HERE, once, and hand the SAME value to the installer and
  // the stamp. Passing `opts.sourceAppPath` to both let them disagree: the
  // installer falls back to `sourceAppPath()` internally, so on the self-heal
  // path (which passes nothing) it would install a LOCAL build while the stamp
  // recorded a release version. The next invocation then computed `local`, saw a
  // kind mismatch, and reinstalled — every time, forever. That is the #2109
  // storm this whole change exists to stop, so the two must read one variable.
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return false;
  const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
  if (!exec) return false;

  // Never bootstrap a helper macOS will reject at launch: an invalid signature
  // under launchd KeepAlive crash-loops forever, and an un-notarized bundle is
  // rejected by Gatekeeper as "damaged". A shipped helper is Developer-ID signed
  // AND notarized (release build + the verify-menubar-helper.sh prepack gate), so
  // this passes; if it ever doesn't, skip the service and point at the upgrade
  // rather than re-signing over it (an ad-hoc re-sign never satisfies Gatekeeper).
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

/**
 * Install + start the menu-bar helper as a launchd user service (idempotent).
 * Clears the sticky opt-out, installs the .app, writes the plist, and
 * bootstraps it into the GUI domain. Returns false on non-darwin or when no
 * helper bundle can be resolved for this install.
 *
 * ASYNC and download-capable: this is the EXPLICIT user-initiated path
 * (`agents menubar enable`). When no bundled/local `.app` ships (a fresh
 * `npm i -g` machine whose tarball lacks the bundle), it fetches the signed +
 * notarized release asset for the running CLI version — verified (sha256 +
 * codesign + Team + designated-requirement pin + notarization) before install
 * — and starts the service from that cached copy. The startup self-heal never
 * routes here: it calls `startMenubarServiceFromSource` and stays sync +
 * network-free, no-opping when no local source exists.
 */
export async function enableMenubarService(opts: { clearOptOut?: boolean } = { clearOptOut: true }): Promise<boolean> {
  if (!onDarwin()) return false;
  let src = sourceAppPath();
  if (!src) src = await downloadMenubarHelperApp(await resolveMenubarVersion());
  return startMenubarServiceFromSource({ ...opts, sourceAppPath: src });
}

/** Drop the sticky `agents menubar disable` sentinel. */
function clearMenubarOptOut(): void {
  try { fs.rmSync(disabledSentinelPath(), { force: true }); } catch { /* already gone */ }
}

/**
 * Write the launchd plist for `exec`, restart the job, and stamp the installed
 * version. Shared by `enableMenubarService` and `runMenubarSetup` so the two
 * cannot drift on what "installed and started" means — the version stamp in
 * particular is what the upgrade self-heal reads to decide staleness, and a
 * path that skipped it would make every later `agents` invocation reinstall.
 */
function installAndStartService(exec: string, stamp: MenubarStamp): void {
  const plist = servicePlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, generateServicePlist(exec));
  restartMenubarLaunchAgent(process.getuid?.() ?? 0, plist);
  try {
    fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stamp));
  } catch { /* best effort */ }
}

/**
 * Render a stamp as a comparable/displayable version string.
 *
 * A local build has no version of its own, so it reports `local`; the ownership
 * contest treats that as "not comparable" and falls through to its owner arm,
 * which is the correct outcome — a dev build must never win a version contest
 * against a release.
 */
export function stampVersionLabel(stamp: MenubarStamp | null): string | null {
  if (!stamp) return null;
  if (stamp.source === 'release') return stamp.helperVersion;
  if (stamp.source === 'legacy') return null;
  return LOCAL_BUILD_LABEL;
}

/** What this install would put on disk right now, as a stamp. */
function availableStamp(): MenubarStamp {
  const src = sourceAppPath();
  // No local bundle means the release path: what would be installed is the
  // newest published helper this machine has resolved (cached, day-old at
  // most), never below the floor — and the floor itself before the first
  // resolution or offline.
  return src ? stampFor(src) : { source: 'release', helperVersion: cachedMenubarVersion() };
}

/** The helper version this install would put on disk right now, for display. */
function availableHelperLabel(): string {
  return stampVersionLabel(availableStamp()) ?? LOCAL_BUILD_LABEL;
}

/**
 * Identify the bundle about to be installed, for the stamp.
 *
 * A bundle is a RELEASE iff it sits under the helper's own download cache —
 * asked of `menubarHelperCacheDir`, not pattern-matched out of the path. A regex
 * for `/v<x.y.z>/` gets this wrong in both directions: a checkout living under
 * any directory that happens to contain a version-shaped segment reads as a
 * release, and a release cache laid out differently reads as local. Either
 * misclassification flips `source` between invocations, and a kind change is
 * unconditionally stale — which is a reinstall loop.
 */
export function stampFor(resolvedSourceAppPath: string): MenubarStamp {
  const version = releaseVersionOfCachedBundle(resolvedSourceAppPath);
  if (version) return { source: 'release', helperVersion: version };
  let mtime = 0;
  try { mtime = fs.statSync(resolvedSourceAppPath).mtimeMs; } catch { /* best effort */ }
  return { source: 'local', sourceStamp: `${resolvedSourceAppPath}@${mtime}` };
}

/**
 * The helper version a path denotes, iff it is inside that version's cache dir.
 * Returns null for anything else — including a version-shaped path that is not
 * actually the cache.
 */
export function releaseVersionOfCachedBundle(
  appPath: string,
  cacheDirFor: (v: string) => string = menubarHelperCacheDir,
): string | null {
  // Try EVERY version-shaped segment, not just the leftmost. A cached bundle
  // under a home or mount path that itself contains an unrelated `vX.Y.Z`
  // (an nvm dir, a versioned volume) would otherwise match that first segment,
  // fail the prefix check, and be misclassified as a local build.
  const resolved = path.resolve(appPath);
  for (const m of appPath.matchAll(/v(\d+\.\d+\.\d+)/g)) {
    const expected = path.resolve(cacheDirFor(m[1]));
    if (resolved === expected || resolved.startsWith(expected + path.sep)) return m[1];
  }
  return null;
}

/**
 * Pure staleness decision (no I/O) so the truth table is unit-testable.
 *
 * This compares the HELPER axis, not the CLI's. It used to compare the installed
 * stamp against `getCliVersion()`, which was wrong in both directions once the
 * helpers gained their own version line: every CLI release made an unchanged
 * helper look stale and reinstalled it (the #2109 restart storm), while a
 * genuinely newer helper at the same CLI version never looked stale at all.
 *
 * Stale when: the executable is gone; nothing is stamped; the stamp predates the
 * JSON format (`legacy` — re-stamped once); the install KIND changed
 * (local <-> release), since a dev build and a release bundle are not
 * interchangeable; a release install whose available helper version is newer;
 * or a local install whose source path or mtime moved.
 */
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

/**
 * Pure decision (no I/O): should the detached background worker download the
 * floor release into the cache so the next startup self-heal has a source?
 *
 * The self-heal (`installMenubarLaunchAgentOnUpgrade`) is deliberately
 * network-free, and the npm tarball ships no bundle, so without this step an
 * `npm i -g` Mac keeps whatever helper it has — a crashing 1.1.2, a dead 0.1.0 —
 * until someone runs `agents menubar setup` by hand. The worker fetches only
 * when the fetch would change something: nothing else can act as a source, the
 * user has not opted out, and either no service exists yet (the auto-enable the
 * bootstrap promises) or the installed helper is older than the floor.
 */
export function menubarHelperPrefetchNeeded(opts: {
  darwin: boolean;
  disabledByUser: boolean;
  /** `sourceAppPath()` found a bundle (shipped or already cached). */
  hasSource: boolean;
  serviceInstalled: boolean;
  stale: boolean;
}): boolean {
  if (!opts.darwin || opts.disabledByUser || opts.hasSource) return false;
  return !opts.serviceInstalled || opts.stale;
}

/**
 * Background half of the release-path self-heal: download + verify the floor
 * release into the cache when `menubarHelperPrefetchNeeded` says so. Returns
 * the cached path, or null when nothing was fetched. Run from the detached
 * auto-pull worker; the foreground CLI never waits on it.
 */
export async function prefetchMenubarHelper(): Promise<string | null> {
  const needed = menubarHelperPrefetchNeeded({
    darwin: onDarwin(),
    disabledByUser: menubarDisabledByUser(),
    hasSource: Boolean(sourceAppPath()),
    serviceInstalled: menubarServiceInstalled(),
    stale: menubarSetupStale(),
  });
  if (!needed) return null;
  return downloadMenubarHelperApp(helperFloor('menubar'));
}

/**
 * Pure decision (no I/O): did THIS heal actually replace bundle content a live
 * process could be running stale, as opposed to a plist-only repoint?
 *
 * `stale` (version bump or missing exec) and `needsDevIdHeal` (ad-hoc ->
 * Developer ID) both mean the shipped `.app` differs from what is already
 * installed — the exact condition under which a running helper can be left on
 * an old code identity after `enableMenubarService` swaps the bundle. A
 * repoint-only heal (`menubarSetupNeedsRepoint()` alone, same version, same
 * signing identity) does NOT count: RUSH-3005 already owns the churn from
 * mixed-Node-interpreter repoints, and restarting the helper on every one of
 * those would double that churn rather than fix this bug.
 */
export function menubarHealReplacedBundle(opts: {
  stale: boolean;
  needsDevIdHeal: boolean;
}): boolean {
  return opts.stale || opts.needsDevIdHeal;
}

/**
 * Pure re-point decision (no I/O): the plist's baked interpreter/entry no longer
 * match the install that is now running `agents`. This catches DUAL-INSTALL skew
 * that a version bump can't — e.g. the plist was baked by an nvm copy but the
 * user's `agents` now resolves to a bun copy (same or different version), so the
 * helper keeps shelling the stale install for its menu data AND the quick-issue
 * dispatch. A null active entry (a dev/tsx run where the compiled entry can't be
 * resolved) never triggers a re-point, so it can't churn the plist onto a
 * transient path.
 */
export function menubarPlistNeedsRepoint(opts: {
  plistEntry: string | null;
  plistNode: string | null;
  plistNodeExists: boolean;
  activeEntry: string | null;
  activeNode: string | null;
}): boolean {
  if (!opts.activeEntry) return false; // can't resolve the running install — don't churn
  if (opts.plistEntry !== opts.activeEntry) return true;
  // The entry path owns the helper. The same installed CLI may be invoked through
  // several compatible Node interpreters (nvm, Homebrew, a parent process's
  // process.execPath). Re-pointing merely because those valid interpreter paths
  // differ makes every invocation replace and relaunch the shared helper. Keep the
  // recorded interpreter until it disappears; then repoint to the active one.
  if (opts.activeNode && (!opts.plistNode || !opts.plistNodeExists)) return true;
  return false;
}

/** Read one EnvironmentVariables value from the installed service plist. */
function readPlistEnvValue(key: string): string | null {
  try {
    const xml = fs.readFileSync(servicePlistPath(), 'utf-8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** True when the installed plist points at a different install than the active one. */
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

/**
 * Stop + remove the menu-bar service and write the sticky opt-out so the
 * upgrade migration won't re-enable it.
 */
export function disableMenubarService(): void {
  if (!onDarwin()) return;
  const plist = servicePlistPath();
  const reg = serviceManagerRegistrationAllowed();
  if (reg.allowed) {
    const uid = process.getuid?.() ?? 0;
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${serviceLabel()}`], { stdio: ['ignore', 'ignore', 'ignore'] }); }
    catch { try { execFileSync('launchctl', ['unload', '-w', plist], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* not loaded */ } }
  } else {
    process.stderr.write(`[agents] ${reg.reason}\n`);
  }
  try { fs.unlinkSync(plist); } catch { /* already gone */ }
  try {
    fs.mkdirSync(path.dirname(disabledSentinelPath()), { recursive: true });
    fs.writeFileSync(disabledSentinelPath(), `disabled ${new Date().toISOString()}\n`);
  } catch { /* best effort */ }
}

/**
 * Which install is allowed to (re)install the shared helper.
 *
 * The helper lives at ONE path in Application Support, but any number of
 * agents-cli copies can be present on a box and every one of them runs the
 * startup self-heal. The version stamp and the plist's baked `AGENTS_ENTRY` each
 * record whichever copy acted last, so without an ownership rule every copy
 * reads the others' marks as drift and recopies the bundle over them. Recopying
 * replaces the executable under the live helper and kills it; launchd
 * `KeepAlive` restarts it; the next copy repeats it. Measured on one box: a new
 * pid every 5-15s, 578 launches in the helper's log, a status item that never
 * stayed visible, and `agents menubar status` still reporting `running: yes`
 * because a pid always existed (#2109).
 *
 * There is deliberately NO content comparison here. Comparing the shipped helper
 * against the installed one cannot distinguish "real upgrade" from "another
 * install's copy": the helper is rebuilt, re-signed and re-notarized on every
 * helper release (phnx-labs/agi-menu scripts/release.sh), so consecutive releases
 * ship byte-different bundles from identical Swift source — 1.22.20/21/22 all
 * have the same 2876288-byte executable and three different sha256s AND three
 * different CDHashes. Any digest gate therefore reports "changed" for exactly
 * the skew case it was meant to exempt.
 *
 * So the installed version decides release skew: a newer signed release takes
 * ownership immediately, an older release cannot downgrade it, and equal foreign
 * releases retain the recorded owner. The plist's `AGENTS_ENTRY` remains the
 * ownership signal for legacy state with no version marker, where the cooldown
 * bounds takeover churn. Pure so the truth table is unit-testable.
 */
export function mayInstallMenubarHelper(opts: {
  /** `AGENTS_ENTRY` baked into the installed plist — the recorded owner. */
  plistEntry: string | null;
  /** `resolveCliEntry()` for the install now running `agents`. */
  activeEntry: string | null;
  /** Whether `plistEntry` still exists on disk. */
  ownerEntryExists: boolean;
  /** The App Support helper executable is absent — a repair, not a contest. */
  helperExecMissing: boolean;
  /** Installed copy is ad-hoc while the shipped source is Developer ID. */
  needsDevIdHeal: boolean;
  /** Version stamped beside the installed helper, or null for legacy state. */
  installedVersion: string | null;
  /** Version of the agents-cli install now attempting the heal. */
  currentVersion: string | null;
  /** ms since the last self-heal reinstall, or null if none is recorded. */
  msSinceLastHeal: number | null;
  /** How long a non-owner waits before it may take over. */
  cooldownMs: number;
  /** This install's OWN shipped bundle is Developer-ID signed (not ad-hoc/dev). */
  sourceIsDeveloperId: boolean;
}): boolean {
  // Repairs are never gated: a missing binary or a broken signing identity leaves
  // the menu bar dead or re-prompting for Accessibility, and no other install can
  // be "fighting" for a bundle that isn't there. Blocking these behind ownership
  // is what turned the first version of this gate into a silent stuck state.
  if (opts.helperExecMissing || opts.needsDevIdHeal) return true;
  // Can't resolve which install we are (a dev/tsx run) — never churn the plist.
  if (!opts.activeEntry) return false;
  // No owner recorded yet (fresh or pre-`AGENTS_ENTRY` plist) — adopt it.
  if (!opts.plistEntry) return true;
  // The recorded owner's entry path is gone from disk, so this install may adopt
  // the helper — but a non-Developer-ID (ad-hoc/dev) source may NOT seize a
  // healthy install this way. Recopying an ad-hoc bundle over the Developer-ID
  // one poisons the shared Accessibility grant (an ad-hoc signature fails the
  // grant's stored code requirement, so macOS revokes it and re-prompts on the
  // next paste) and Gatekeeper then rejects the result as "damaged" (RUSH-2134).
  // This does not strand a genuinely broken helper: escape (1) above
  // (helperExecMissing / needsDevIdHeal) already lets ANY source repair a
  // missing-or-ad-hoc install, so refusing here only declines to re-point the
  // plist of a helper that is already present and working — the menu bar keeps
  // running, nothing deadlocks.
  if (!opts.ownerEntryExists) return opts.sourceIsDeveloperId;
  // `local` is a KIND marker, not a version — a dev build has none. Comparing it
  // with compareVersions would order it against real semver arbitrarily and let a
  // dev build win (or lose) a contest it should not enter. When either side is a
  // local build the version arm is skipped entirely and the owner arm decides,
  // which is the correct outcome: ownership, not version, distinguishes them.
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
  // A foreign install while the owner still exists. Refusing outright bounds the
  // loop but strands the user when the recorded owner is a stale copy that simply
  // still sits on disk (an old nvm node dir) while their daily driver upgrades:
  // that install would never heal again. So it may take over, but only once per
  // cooldown — which turns an every-invocation storm into at most one restart per
  // cooldown while keeping every install able to make progress.
  //
  // Except an ad-hoc/dev-signed copy, which never seizes a healthy helper on a
  // timer. `scripts/install.sh` deliberately puts a dev build beside the npm
  // global, and its bundle cannot be notarized; letting it win the timed takeover
  // would recopy an ad-hoc bundle over a good Developer-ID one, and Gatekeeper
  // then rejects the result as "damaged" and AppKit crashes at launch (RUSH-2134)
  // — trading a cosmetic loop for a broken menu bar. It can still take over when
  // the owner is genuinely gone (above), which is the case that must not deadlock.
  if (!opts.sourceIsDeveloperId) return false;
  return opts.msSinceLastHeal === null || opts.msSinceLastHeal >= opts.cooldownMs;
}

/**
 * How long a non-owner install waits before it may take an unversioned legacy
 * helper over. Long
 * enough that a multi-install box restarts the helper at most once an hour
 * instead of every few seconds; short enough that a user who switched installs
 * gets their upgrade without hunting for `agents menubar setup`.
 */
const MENUBAR_TAKEOVER_COOLDOWN_MS = 60 * 60 * 1000;

/** Timestamp of the last self-heal reinstall, next to the version stamp. */
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
  } catch { /* best effort */ }
}

/** Whether this install may (re)install the helper (see `mayInstallMenubarHelper`). */
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

/**
 * Startup self-heal, run on every darwin CLI invocation (see src/index.ts).
 * No-ops cheaply (a couple of existsSync + a tiny file read) unless work is
 * needed:
 *   - fresh install (no service yet)      -> enable
 *   - upgrade (version stamp changed) or  -> re-enable: recopy the new helper
 *     the App Support helper went missing     binary + rewrite the plist + kick
 *
 * Without the staleness re-enable, `npm update` refreshed the CLI but left the
 * menu bar running the previous release's helper binary on a possibly-stale
 * plist. Everything past the ownership gate is unchanged; the gate is what stops
 * coexisting installs reinstalling over each other forever (#2109). No-ops if:
 * not darwin, the user opted out, or no helper bundle ships. Best-effort — never
 * throws into startup.
 */
export function installMenubarLaunchAgentOnUpgrade(): void {
  try {
    if (!onDarwin()) return;
    if (menubarDisabledByUser()) return;
    if (!sourceAppPath()) return;
    if (!menubarServiceInstalled()) {
      startMenubarServiceFromSource({ clearOptOut: false });
      return;
    }
    // Re-enable (recopy helper + rewrite plist) when the version drifted OR the
    // plist's baked interpreter/entry no longer point at the install now running
    // `agents` — e.g. the owner moved between node interpreters — OR the
    // installed copy is still ad-hoc while the shipped source is Developer ID
    // (older heal path; Accessibility re-prompts until the identity is restored).
    const needsDevIdHeal = installedNeedsDevIdHeal();
    const stale = menubarSetupStale();
    if (!(stale || menubarSetupNeedsRepoint() || needsDevIdHeal)) return;
    // ...but a copy that does not own the helper only gets to act on that drift
    // once per cooldown. Without the gate every coexisting install recopies the
    // bundle on every invocation, killing the live helper on a loop (#2109).
    if (!mayHealMenubar(needsDevIdHeal)) return;
    // Stamp only a heal that actually happened. `enableMenubarService` returns
    // false without installing when the bundle fails the Gatekeeper check, and
    // stamping first would spend the shared cooldown on a no-op — locking every
    // non-owner out for another hour while nothing had been fixed.
    if (startMenubarServiceFromSource({ clearOptOut: false })) {
      stampMenubarHeal();
      // One-time: the ad-hoc -> Developer ID transition leaves a dead TCC row
      // under the old identity (tccutil on zion reset it 11 times across
      // machines that made this jump) — clear it so the fresh grant sticks.
      if (shouldMigrateMenubarTcc({ needsDevIdHeal, alreadyMigrated: menubarTccAlreadyMigrated() })) {
        resetMenubarAccessibilityTcc();
      }
      // Only a REAL content swap (version bump or the Dev-ID transition) can
      // leave a running process on stale code — a plist-only repoint (handled
      // above by menubarSetupNeedsRepoint alone) is RUSH-3005's churn to own,
      // not this heal's to restart on top of.
      if (menubarHealReplacedBundle({ stale, needsDevIdHeal })) {
        restartMenubarHelperAfterSwap(process.getuid?.() ?? 0, liveMenubarProcesses().own);
      }
    }
  } catch {
    /* never block startup on the menu bar */
  }
}

/** True when App Support still has an ad-hoc copy but the npm bundle is Developer ID. */
function installedNeedsDevIdHeal(): boolean {
  const src = sourceAppPath();
  if (!src || !fs.existsSync(installedAppPath())) return false;
  if (hasDeveloperIdSignature(installedAppPath())) return false;
  return hasDeveloperIdSignature(src);
}

/** Marker written once the one-time ad-hoc -> Developer ID TCC migration has
 *  run on this machine, next to the version/heal stamps. */
function tccMigrationMarkerPath(): string {
  return path.join(installDir(), '.menubar-tcc-migrated');
}

function menubarTccAlreadyMigrated(): boolean {
  return fs.existsSync(tccMigrationMarkerPath());
}

/**
 * Pure decision (no I/O): run the one-time `tccutil reset Accessibility` only
 * on a real ad-hoc -> Developer ID transition, and only once ever. A machine
 * that was always Developer ID never accumulated a dead TCC row under an
 * ad-hoc identity, so resetting there would just force a needless re-prompt;
 * a machine that already migrated must not be reset again on every heal.
 */
export function shouldMigrateMenubarTcc(opts: {
  needsDevIdHeal: boolean;
  alreadyMigrated: boolean;
}): boolean {
  return opts.needsDevIdHeal && !opts.alreadyMigrated;
}

/**
 * Reset the stale Accessibility grant TCC recorded against the pre-migration
 * ad-hoc identity, then stamp the marker so this never runs again on this
 * machine. Targets `SERVICE_LABEL_BASE` — the bundle's actual
 * `CFBundleIdentifier`/codesign `--identifier` (set by agi-menu's build.sh) that
 * TCC keys grants to — not the namespaced `serviceLabel()`, which exists only
 * to keep launchd job labels apart under a redirected HOME (RUSH-2639) and is
 * never the app's real identity. Best-effort: a missing/failing `tccutil`
 * (older macOS, a sandboxed test HOME) must never block the heal that just
 * fixed the signing identity itself.
 */
export function resetMenubarAccessibilityTcc(
  exec: (cmd: string, args: readonly string[], opts: { stdio: ['ignore', 'ignore', 'ignore'] }) => Buffer = execFileSync,
): void {
  try {
    exec('tccutil', ['reset', 'Accessibility', SERVICE_LABEL_BASE], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch { /* best effort — a missing/failing tccutil must not block the heal */ }
  try {
    fs.mkdirSync(installDir(), { recursive: true });
    fs.writeFileSync(tccMigrationMarkerPath(), new Date().toISOString());
  } catch { /* best effort */ }
}

/** One step of `agents menubar setup`, and how it came out. */
export interface SetupStep {
  /** What was configured. */
  name: string;
  /** `ok` — already correct or now correct; `changed` — this run fixed it;
   *  `failed` — could not be configured (setup reports and exits nonzero). */
  outcome: 'ok' | 'changed' | 'failed';
  detail: string;
}

export interface SetupResult {
  steps: SetupStep[];
  /** Every step landed on `ok`/`changed` and exactly one helper is running. */
  configured: boolean;
  status: MenubarStatus;
}

/**
 * Decide which live helper processes must be ended so exactly one status item
 * survives. Pure so the choice is unit-testable without a live menu bar.
 *
 * EVERY current process is ended, including the wanted one: the caller
 * re-kickstarts the launchd service straight after, so the survivor is the one
 * launchd owns (RunAtLoad + KeepAlive), not whichever copy happened to win a
 * race. Picking a survivor from a `ps` listing cannot do this — the list says
 * nothing about which pid launchd will keep alive, so leaving one alive risks
 * keeping the un-managed copy and re-creating the duplicate on next login.
 */
export function processesToEnd(status: Pick<MenubarStatus, 'instances' | 'foreignInstances'>): MenubarProcess[] {
  return [...status.instances, ...status.foreignInstances];
}

function endProcess(pid: number): void {
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/**
 * `agents menubar setup` — configure the menu bar end-to-end, idempotently.
 *
 * The one command that gets a machine to the intended state: exactly one status
 * item, owned by a launchd service that starts it at login and restarts it if it
 * dies. Each concern is a reported step, so a partial failure names itself
 * instead of hiding behind "enabled".
 *
 *   1. bundle      — install/refresh the .app at the stable App Support path
 *   2. signature   — a valid code identity (macOS 26+ SIGKILLs an invalid one)
 *   3. duplicates  — end every live helper, so the only survivor is launchd's
 *   4. login item  — write the plist (RunAtLoad + KeepAlive) and bootstrap it
 *   5. single      — verify exactly one helper came back up
 */
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

  // Explicit user-initiated path: when no bundled/local `.app` ships (a fresh
  // `npm i -g` machine whose tarball lacks the bundle), fetch the signed +
  // notarized release asset for this CLI version. Verified (sha256 + codesign +
  // Team + designated-requirement pin + notarization) before install; the
  // cached copy is the source for `ensureMenubarAppInstalled` below.
  let src = sourceAppPath();
  if (!src) {
    try {
      src = await downloadMenubarHelperApp(await resolveMenubarVersion());
    } catch (e) {
      step('bundle', 'failed', `no AGI Menu bundle ships with this install, and the release-asset download failed: ${(e as Error).message}`);
      return { steps, configured: false, status: before };
    }
  }

  // 3 before 1: end the running copies BEFORE swapping the bundle underneath
  // them, so no helper keeps a status item alive on a binary that no longer
  // exists on disk.
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
  // The helper axis here too: this label read "ok" only when the installed
  // helper's stamp happened to equal the CLI's version, which after this change
  // is never true on a release install.
  //
  // Compare the STAMPS, not their labels. `stampVersionLabel` collapses every
  // local build to the literal 'local', discarding the mtime — so a real dev
  // rebuild (which the surrounding logic does correctly reinstall) would print
  // "ok" and hide that anything changed. That is the same collapse already
  // excluded in `versionMatches` and `mayInstallMenubarHelper`; this was the
  // third site and the only one still reading through the lossy label.
  const bundleStamp = readInstalledMenubarStamp();
  // Reuse the file's canonical comparator rather than a second, serialization
  // -based one: `JSON.stringify` was sound only because both stamps come from
  // `stampFor`, which is an implicit key-order dependency with no reason to
  // exist when isMenubarStale already answers exactly this question.
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

  // Clear the sticky opt-out: running `setup` is an explicit request for the
  // menu bar, so a stale `menubar disable` must not silently win.
  clearMenubarOptOut();

  installAndStartService(exec, stampFor(src ?? undefined));
  step('login item', before.serviceInstalled ? 'ok' : 'changed',
    `${serviceLabel()} — starts at login, restarts if it dies`);

  // launchd's bootstrap+kickstart is asynchronous; give the status item a beat
  // to claim the lock before counting instances, or `setup` reports zero on a
  // machine that is in fact coming up correctly.
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

/**
 * Poll (up to ~3s) for launchd to bring the single helper back. Returns the
 * last status read either way — the caller decides what a miss means.
 */
function waitForSingleInstance(): MenubarStatus {
  let status = getMenubarStatus();
  for (let i = 0; i < 15 && status.instances.length !== 1; i++) {
    sleepSync(200);
    status = getMenubarStatus();
  }
  return status;
}

/** A live MenubarHelper process: its pid and the executable it is running. */
export interface MenubarProcess {
  pid: number;
  executable: string;
}

/** Parse `ps -axo pid=,<field>=` into pid -> field. The field is the rest of the
 *  line, so a path containing spaces (App Support does) survives intact. */
function parsePsLines(psOutput: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/**
 * Split the live MenubarHelper processes into the installed bundle's own
 * (`own`) and every other copy (`foreign`).
 *
 * `pgrep -f MenubarHelper` conflated the two, so a stray dev build could hold
 * the global Cmd-Shift-V chord (RegisterEventHotKey is first-come) while status
 * still reported a healthy `running: yes` — the paste was dead and nothing said
 * so. A foreign copy is the thing to look for, so name it.
 *
 * `own` is a LIST, not a boolean: two copies of the INSTALLED bundle can run at
 * once (launchd's KeepAlive service plus a LaunchServices/`open` launch of the
 * same .app), which is the duplicate the user actually sees — two agents marks
 * in the menu bar. Collapsing them to `running: true` reported that state as
 * healthy. The helper now refuses to be the second (SingleInstance.swift), and
 * `agents menubar setup` ends any duplicate a pre-fix helper left behind.
 *
 * Identity comes from `comm` (the resolved executable), never from a substring
 * of the command line: matching the latter flags any shell that merely mentions
 * the helper's name. `command` is consulted only to drop `--notify` one-shots.
 */
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
    // `--notify` is a one-shot that posts a notification and exits; it runs the
    // installed binary but never claims the status item or the chords.
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
  /** The installed HELPER's version — not the CLI's. `local` for a dev build. */
  installedVersion: string | null;
  /** The helper version this install would put on disk right now. */
  currentVersion: string;
  /** The CLI's own version, reported separately so the two are never conflated. */
  cliVersion: string;
  stale: boolean;
  serviceInstalled: boolean;
  running: boolean;
  /** Live processes of the INSTALLED bundle. More than one is the duplicate. */
  instances: MenubarProcess[];
  /** Live MenubarHelper processes that are NOT the installed bundle. */
  foreignInstances: MenubarProcess[];
  disabledByUser: boolean;
}

/** Live MenubarHelper processes, split by whether they are the installed bundle. */
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

/** Read-only diagnostic for `agents menubar doctor` — probes, never mutates. */
export interface MenubarDoctorReport {
  platform: string;
  installPath: string | null;
  /** The installed HELPER's version — not the CLI's. `local` for a dev build. */
  installedVersion: string | null;
  /** The helper version this install would put on disk right now. */
  currentVersion: string;
  /** The CLI's own version, reported separately so the two are never conflated. */
  cliVersion: string;
  /** installed helper vs available helper. Never compares the CLI's version. */
  versionMatches: boolean;
  /** `unknown` on non-darwin or when nothing is installed to inspect. */
  signingIdentity: 'developer-id' | 'ad-hoc' | 'unknown';
  running: boolean;
  /** A live helper pid started before the installed bundle's on-disk mtime —
   *  it is running the binary that has since been swapped underneath it. */
  staleRunningProcess: PidStaleness[];
  /** Grant likely needs to be re-made: an ad-hoc identity breaks on every
   *  update, or a live process is confirmed to predate the current bundle. */
  accessibilityHintNeeded: boolean;
}

/** One live pid checked against the bundle's on-disk mtime. */
export interface PidStaleness {
  pid: number;
  stale: boolean;
}

/**
 * Pure comparison (no I/O) behind the stale-process check: a helper pid that
 * started before the bundle on disk was last written is still running the
 * PREVIOUS binary — the exact condition `restartMenubarHelperAfterSwap` exists
 * to fix. Millisecond epoch timestamps in, so the truth table is unit-testable
 * without a live process or filesystem.
 *
 * The two timestamps do not have the same resolution. `pidStartTimeMs` parses
 * `ps -o lstart`, which prints whole SECONDS, while the bundle mtime carries
 * sub-second precision — and the restart this check exists to detect happens
 * within a second of the swap that triggered it. A raw `<` therefore called a
 * healthy just-restarted helper stale on essentially every upgrade: measured on
 * zion at 1.22.46, pid start 1787441353000 vs bundle mtime 1787441353700, 700ms
 * apart inside one second, reported as "running the OLD binary" and surfaced as
 * `accessibilityHintNeeded` — telling the user to re-grant Accessibility after
 * an upgrade that had already restarted the helper correctly. So the bundle
 * mtime is truncated to the same whole second `ps` reports before comparing: a
 * pid that started in the swap's own second is fresh, and a genuinely stale pid
 * (a full second or more older) is still caught.
 */
export function isMenubarProcessStaleAgainstBundle(pidStartedAtMs: number, bundleMtimeMs: number): boolean {
  return pidStartedAtMs < Math.floor(bundleMtimeMs / 1000) * 1000;
}

/** Wall-clock start time of a live pid via `ps`, or null if it can't be read. */
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

/**
 * `agents menubar doctor` — everything a human needs to tell "why did
 * Accessibility ask again" apart from "the helper is genuinely broken":
 * install path, version skew, whether the signing identity is update-stable,
 * and whether a live process predates the bundle it's supposed to be running.
 * Read-only: no install, no restart, no TCC reset — `agents menubar setup`
 * remains the command that fixes what this reports.
 */
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
    } catch { /* exec vanished mid-check — report no staleness rather than throw */ }
  }

  return {
    platform: process.platform,
    installPath: appPath,
    installedVersion: status.installedVersion,
    currentVersion: status.currentVersion,
    cliVersion: status.cliVersion,
    // Two local builds are not a version "mismatch" — neither carries a version.
    // Reporting one told the user to run `setup` for a difference that does not
    // exist, which is what made the old hint fire forever.
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

/** Outcome of one auto-update pass (`updateMenubarHelperIfNewer`). */
export interface MenubarUpdateResult {
  outcome: 'updated' | 'current' | 'skipped' | 'failed';
  installed: string | null;
  available: string;
  detail: string;
}

/**
 * Bring an installed release helper up to the newest published build, without
 * a human running `agents menubar setup`.
 *
 * Runs from the daemon's self-heal tick and right after `agents upgrade`. It
 * only ever moves a RELEASE install forward: a machine whose helper came from a
 * local build (a dev checkout) keeps it, a machine that never enabled the menu
 * bar or opted out is left alone, and the ownership contest that bounds
 * multi-install churn (`mayInstallMenubarHelper`) still applies. The bundle is
 * downloaded and verified by the same path every install uses (sha256,
 * codesign, Team, designated-requirement pin, notarization), swapped
 * atomically under the install lock at the same path and identity — which is
 * what keeps the Accessibility grant — and the running helper is restarted
 * from the new binary (`restartMenubarHelperAfterSwap`; launchd's KeepAlive
 * relaunches it within seconds). `dryRun` reports what would happen. Never
 * throws.
 */
export async function updateMenubarHelperIfNewer(opts: { dryRun?: boolean; force?: boolean } = {}): Promise<MenubarUpdateResult> {
  const installedStamp = readInstalledMenubarStamp();
  const installed = stampVersionLabel(installedStamp);
  const skip = (detail: string, available = cachedMenubarVersion()): MenubarUpdateResult =>
    ({ outcome: 'skipped', installed, available, detail });
  if (!onDarwin()) return skip('macOS only');
  if (menubarDisabledByUser()) return skip('the menu bar is disabled (agents menubar disable)');
  if (!menubarServiceInstalled()) return skip('the menu bar is not installed on this Mac');
  if (sourceAppPath()) return skip('this install ships its own helper bundle; the startup self-heal owns it');
  if (!installedStamp || installedStamp.source !== 'release') return skip(`installed helper is ${installed ?? 'unstamped'}, not a release`);

  const available = await resolveMenubarVersion({ force: opts.force });
  if (compareVersions(available, installedStamp.helperVersion) <= 0) {
    return { outcome: 'current', installed, available, detail: `AGI Menu ${installed} is the newest published build` };
  }
  if (!mayHealMenubar(false)) return skip(`another install owns the helper; it will update on its own cooldown`, available);
  if (opts.dryRun) return { outcome: 'updated', installed, available, detail: `would update AGI Menu ${installed} → ${available}` };

  try {
    const src = await downloadMenubarHelperApp(available);
    const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
    if (!exec) return { outcome: 'failed', installed, available, detail: 'the verified bundle could not be installed' };
    try { fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stampFor(src))); } catch { /* best effort */ }
    stampMenubarHeal();
    restartMenubarHelperAfterSwap(process.getuid?.() ?? 0, liveMenubarProcesses().own);
    return { outcome: 'updated', installed, available, detail: `AGI Menu ${installed} → ${available}` };
  } catch (e) {
    return { outcome: 'failed', installed, available, detail: (e as Error).message };
  }
}
