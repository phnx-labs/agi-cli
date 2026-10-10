
import { fileURLToPath } from 'url';
import { execFileSync, spawnSync, spawn } from 'child_process';
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
import lockfile from 'proper-lockfile';
import { readUpdateState, saveUpdateState, updateStatePath, menubarAutoUpdateEnabled, menubarAutomaticUpdateDue, MENUBAR_AUTO_UPDATE_INTERVAL_MS, type MenubarUpdateState } from './update-state.js';
import { helperFloor } from '../helper-versions.js';
import { cachedMenubarVersion, resolveMenubarVersion } from './resolve-version.js';

const APP_BUNDLE_NAME = 'MenubarHelper.app';
const INSTALL_DIR_NAME = 'agents-cli';
const SERVICE_LABEL_BASE = 'com.phnx-labs.agents-menubar';

export const MENUBAR_HELPER_EXECUTABLE_NAME = 'AGI Menu';

export function serviceLabel(): string {
  return namespacedServiceLabel(SERVICE_LABEL_BASE);
}

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

function installedVersionMarkerPath(): string {
  return path.join(installDir(), '.menubar-version');
}

export const LOCAL_BUILD_LABEL = 'local';

type MenubarStamp =
  | { source: 'release'; helperVersion: string }
  | { source: 'local'; sourceStamp: string }
  | { source: 'legacy'; raw: string };

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

  return fs.existsSync(disabledSentinelPath());
}

function menubarServiceInstalled(): boolean {
  return onDarwin() && fs.existsSync(servicePlistPath());
}

function sourceAppPath(): string | null {

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

export function cachedReleaseBundlePath(): string {
  return path.join(menubarHelperCacheDir(cachedMenubarVersion()), APP_BUNDLE_NAME);
}

async function menubarVersionToInstall(opts: { force?: boolean } = {}): Promise<string> {
  const resolved = await resolveMenubarVersion({ force: opts.force });
  const installed = readInstalledMenubarStamp();

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

export function ensureMenubarAppInstalled(opts: { forceReinstall?: boolean; sourceAppPath?: string } = {}): string | null {
  if (!onDarwin()) return null;
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return null;
  const dest = installedAppPath();
  const needsInstall = (): boolean => {
    if (opts.forceReinstall) return true;
    if (!fs.existsSync(dest)) return true;
    return hasDeveloperIdSignature(src) && !hasDeveloperIdSignature(dest);
  };
  if (!needsInstall()) return installedExecutablePath();
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
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

export interface MenubarRestartResult {
  outcome: 'restarted' | 'failed';
  previousPids: number[];
  pids: number[];
  detail: string;
}

export const MENUBAR_RESTART_DEADLINE_MS = 15_000;

export interface MenubarRestartDeps {
  ownPids: () => number[];
  kickstart: (target: string) => Promise<{ code: number | null; stderr: string }>;
  sleep: (ms: number) => Promise<void>;
  deadlineMs: number;
}

// The kickstart runs in its own session: launchd ends the helper's whole process
// group, so a restart requested from AGI Menu itself must outlive its caller.
function kickstartDetached(target: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('launchctl', ['kickstart', '-k', target], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { stderr = `${stderr}timed out after 10 s`; child.kill('SIGKILL'); }, 10_000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.trim() }); });
  });
}

const defaultRestartDeps: MenubarRestartDeps = {
  ownPids: () => liveMenubarProcesses().own.map((p) => p.pid),
  kickstart: kickstartDetached,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  deadlineMs: MENUBAR_RESTART_DEADLINE_MS,
};

export async function restartMenubarHelper(deps: MenubarRestartDeps = defaultRestartDeps): Promise<MenubarRestartResult> {
  const failed = (detail: string, previousPids: number[] = [], pids: number[] = []): MenubarRestartResult =>
    ({ outcome: 'failed', previousPids, pids, detail });
  if (!onDarwin()) return failed('AGI Menu is macOS only');
  if (menubarDisabledByUser() || !menubarServiceInstalled()) {
    return failed('AGI Menu is turned off; `agents menubar setup` turns it on');
  }
  const registration = serviceManagerRegistrationAllowed();
  if (!registration.allowed) return failed(registration.reason);

  const previousPids = deps.ownPids();
  const target = `gui/${process.getuid?.() ?? 0}/${serviceLabel()}`;
  const kick = await deps.kickstart(target);
  if (kick.code !== 0) {
    return failed(`launchctl kickstart -k ${target} failed${kick.stderr ? `: ${kick.stderr}` : ''}`, previousPids, deps.ownPids());
  }
  const deadline = Date.now() + deps.deadlineMs;
  let pids = deps.ownPids();
  while (!(pids.length === 1 && !previousPids.includes(pids[0]))) {
    if (Date.now() >= deadline) {
      return failed(`AGI Menu did not come back as one new process within ${Math.round(deps.deadlineMs / 1000)} s; \`agents menubar setup\` repairs it`, previousPids, pids);
    }
    await deps.sleep(200);
    pids = deps.ownPids();
  }
  return { outcome: 'restarted', previousPids, pids, detail: `AGI Menu restarted (pid ${pids[0]})` };
}

function startMenubarServiceFromSource(opts: { clearOptOut?: boolean; sourceAppPath?: string } = {}): boolean {
  if (!onDarwin()) return false;
  const src = opts.sourceAppPath ?? sourceAppPath();
  if (!src) return false;
  const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
  if (!exec) return false;

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

export async function enableMenubarService(opts: { clearOptOut?: boolean } = { clearOptOut: true }): Promise<boolean> {
  if (!onDarwin()) return false;
  let src = shippedAppPath();
  if (!src) src = await downloadMenubarHelperApp(await menubarVersionToInstall());
  return startMenubarServiceFromSource({ ...opts, sourceAppPath: src });
}

function clearMenubarOptOut(): void {
  try { fs.rmSync(disabledSentinelPath(), { force: true }); } catch {  }
}

function installAndStartService(exec: string, stamp: MenubarStamp): void {
  const plist = servicePlistPath();
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, generateServicePlist(exec));
  restartMenubarLaunchAgent(process.getuid?.() ?? 0, plist);
  try {
    fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stamp));
  } catch {  }
}

export function stampVersionLabel(stamp: MenubarStamp | null): string | null {
  if (!stamp) return null;
  if (stamp.source === 'release') return stamp.helperVersion;
  if (stamp.source === 'legacy') return null;
  return LOCAL_BUILD_LABEL;
}

function availableStamp(): MenubarStamp {
  const src = sourceAppPath();
  return src ? stampFor(src) : { source: 'release', helperVersion: cachedMenubarVersion() };
}

function availableHelperLabel(): string {
  return stampVersionLabel(availableStamp()) ?? LOCAL_BUILD_LABEL;
}

export function stampFor(resolvedSourceAppPath: string): MenubarStamp {
  const version = releaseVersionOfCachedBundle(resolvedSourceAppPath);
  if (version) return { source: 'release', helperVersion: version };
  let mtime = 0;
  try { mtime = fs.statSync(resolvedSourceAppPath).mtimeMs; } catch {  }
  return { source: 'local', sourceStamp: `${resolvedSourceAppPath}@${mtime}` };
}

export function releaseVersionOfCachedBundle(
  appPath: string,
  cacheDirFor: (v: string) => string = menubarHelperCacheDir,
): string | null {
  const resolved = path.resolve(appPath);
  for (const m of appPath.matchAll(/v(\d+\.\d+\.\d+)/g)) {
    const expected = path.resolve(cacheDirFor(m[1]));
    if (resolved === expected || resolved.startsWith(expected + path.sep)) return m[1];
  }
  return null;
}

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

export async function prefetchMenubarHelper(): Promise<string | null> {
  if (!menubarAutoUpdateEnabled()) return null;
  if (menubarServiceInstalled()) { await updateMenubarHelperIfNewer(); return null; }
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

export function menubarHealReplacedBundle(opts: {
  stale: boolean;
  needsDevIdHeal: boolean;
}): boolean {
  return opts.stale || opts.needsDevIdHeal;
}

export function menubarPlistNeedsRepoint(opts: {
  plistEntry: string | null;
  plistNode: string | null;
  plistNodeExists: boolean;
  activeEntry: string | null;
  activeNode: string | null;
  plistRelaunchesCleanExit: boolean;
}): boolean {
  if (!opts.activeEntry) return false;
  if (opts.plistEntry !== opts.activeEntry) return true;
  if (opts.plistRelaunchesCleanExit) return true;
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
    plistRelaunchesCleanExit: plistRelaunchesCleanExit(),
  });
}

// A plist written before PHNX-4325 has KeepAlive=true, which relaunches the menu
// after Quit; the current one relaunches only after a crash.
function plistRelaunchesCleanExit(): boolean {
  try {
    return /<key>KeepAlive<\/key>\s*<true\/>/.test(fs.readFileSync(servicePlistPath(), 'utf-8'));
  } catch {
    return false;
  }
}

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
  if (opts.helperExecMissing || opts.needsDevIdHeal) return true;
  if (!opts.activeEntry) return false;
  if (!opts.plistEntry) return true;
  if (!opts.ownerEntryExists) return opts.sourceIsDeveloperId;
  const comparableVersions =
    opts.installedVersion && opts.currentVersion &&
    opts.installedVersion !== LOCAL_BUILD_LABEL && opts.currentVersion !== LOCAL_BUILD_LABEL;
  if (comparableVersions) {
    const versionOrder = compareVersions(opts.currentVersion!, opts.installedVersion!);
    if (versionOrder > 0) return opts.sourceIsDeveloperId;
    if (versionOrder < 0) return false;
    return opts.plistEntry === opts.activeEntry;
  }
  if (opts.plistEntry === opts.activeEntry) return true;
  if (!opts.sourceIsDeveloperId) return false;
  return opts.msSinceLastHeal === null || opts.msSinceLastHeal >= opts.cooldownMs;
}

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

export function menubarGateVersion(source: string | null, cached: () => string = availableHelperLabel): string {
  return source ? stampVersionLabel(stampFor(source)) ?? LOCAL_BUILD_LABEL : cached();
}

function mayHealMenubar(needsDevIdHeal: boolean, source: string | null = sourceAppPath()): boolean {
  const plistEntry = readPlistEnvValue('AGENTS_ENTRY');
  const src = source;
  return mayInstallMenubarHelper({
    plistEntry,
    activeEntry: resolveCliEntry(),
    ownerEntryExists: Boolean(plistEntry) && fs.existsSync(plistEntry as string),
    helperExecMissing: !fs.existsSync(installedExecutablePath()),
    needsDevIdHeal,
    installedVersion: stampVersionLabel(readInstalledMenubarStamp()),
    currentVersion: menubarGateVersion(src),
    msSinceLastHeal: msSinceLastMenubarHeal(),
    cooldownMs: MENUBAR_TAKEOVER_COOLDOWN_MS,
    sourceIsDeveloperId: Boolean(src) && hasDeveloperIdSignature(src as string),
  });
}

export function installMenubarLaunchAgentOnUpgrade(): void {
  try {
    if (!onDarwin()) return;
    if (menubarDisabledByUser()) return;
    if (menubarServiceInstalled() && fs.existsSync(installedExecutablePath()) && hasDeveloperIdSignature(installedAppPath())) {
      if (menubarSetupNeedsRepoint() && mayHealMenubar(false, installedAppPath())) {
        const stamp = readInstalledMenubarStamp();
        if (stamp) installAndStartService(installedExecutablePath(), stamp);
      }
      return;
    }
    if (!menubarAutoUpdateEnabled()) return;
    if (!sourceAppPath()) return;
    if (!menubarServiceInstalled()) {
      startMenubarServiceFromSource({ clearOptOut: false });
      return;
    }
    const needsDevIdHeal = installedNeedsDevIdHeal();
    const stale = menubarSetupStale();
    if (!(stale || menubarSetupNeedsRepoint() || needsDevIdHeal)) return;
    if (!mayHealMenubar(needsDevIdHeal)) return;
    if (startMenubarServiceFromSource({ clearOptOut: false })) {
      stampMenubarHeal();
      if (shouldMigrateMenubarTcc({ needsDevIdHeal, alreadyMigrated: menubarTccAlreadyMigrated() })) {
        resetMenubarAccessibilityTcc();
      }
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

export function shouldMigrateMenubarTcc(opts: {
  needsDevIdHeal: boolean;
  alreadyMigrated: boolean;
}): boolean {
  return opts.needsDevIdHeal && !opts.alreadyMigrated;
}

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

export function processesToEnd(status: Pick<MenubarStatus, 'instances' | 'foreignInstances'>): MenubarProcess[] {
  return [...status.instances, ...status.foreignInstances];
}

function endProcess(pid: number): void {
  try { process.kill(pid, 'SIGTERM'); } catch {  }
}

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
  const bundleStamp = readInstalledMenubarStamp();
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

export type MenubarUpdateResult = MenubarUpdateState;

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

export function getMenubarUpdateStatus(): MenubarUpdateResult {
  const saved = readUpdateState();
  const autoUpdate = menubarAutoUpdateEnabled();
  return {
    outcome: saved.outcome ?? 'unknown', installed: stampVersionLabel(readInstalledMenubarStamp()),
    available: saved.available ?? null, checkedAt: saved.checkedAt ?? null,
    nextCheckAt: autoUpdate && saved.checkedAt ? new Date(Date.parse(saved.checkedAt) + MENUBAR_AUTO_UPDATE_INTERVAL_MS).toISOString() : null,
    autoUpdate, detail: saved.detail ?? 'Not checked yet',
  };
}

function handoffMenubarRestart(checkedAt: string | null): void {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    import * as fs from 'node:fs';
    const stateFile = ${JSON.stringify(updateStatePath())};
    const fail = (detail) => {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (state.checkedAt !== ${JSON.stringify(checkedAt)}) process.exit(1);
      state.outcome = 'failed'; state.detail = detail;
      const tmp = stateFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, stateFile);
      process.exit(1);
    };
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      try { process.kill(${process.pid}, 0); if (Date.now() < deadline) return; fail('AGI Menu installed, but its updater did not exit before the restart deadline'); }
      catch {
        clearInterval(timer);
        try { execFileSync('launchctl', ['kickstart', '-k', ${JSON.stringify(`gui/${process.getuid?.() ?? 0}/${serviceLabel()}`)}], { timeout: 10000, stdio: 'ignore' }); }
        catch (error) { fail('AGI Menu installed, but restart failed: ' + error.message); }
      }
    }, 100);
  `], { detached: true, stdio: 'ignore' });
  child.on('error', (error) => {
    saveUpdateState({ ...getMenubarUpdateStatus(), outcome: 'failed', detail: `AGI Menu installed, but restart could not start: ${error.message}` });
  });
  child.unref();
}

export async function updateMenubarHelperIfNewer(opts: {
  dryRun?: boolean; manual?: boolean; deferRestart?: boolean;
} = {}): Promise<MenubarUpdateResult> {
  const previous = getMenubarUpdateStatus();
  const result = (outcome: MenubarUpdateResult['outcome'], detail: string,
    available = previous.available): MenubarUpdateResult => ({ ...previous, outcome, detail, available });
  const registration = serviceManagerRegistrationAllowed();
  if (!opts.dryRun && !registration.allowed) return result('skipped', registration.reason);
  const reason = menubarUpdateSkipReason({
    darwin: onDarwin(), disabledByUser: menubarDisabledByUser(), serviceInstalled: menubarServiceInstalled(),
    shipped: Boolean(shippedAppPath()), installed: readInstalledMenubarStamp(),
  });
  if (reason) return result('skipped', reason);
  if (!opts.manual && (!previous.autoUpdate || !menubarAutomaticUpdateDue(previous.checkedAt))) {
    return result('skipped', previous.autoUpdate ? 'Next automatic check is not due' : 'Automatic updates are off');
  }
  fs.mkdirSync(path.dirname(updateStatePath()), { recursive: true });
  let releaseLock: () => Promise<void>;
  try { releaseLock = await lockfile.lock(updateStatePath(), { realpath: false, stale: 600000, retries: 0 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return result('skipped', 'An update check is already running');
    throw error;
  }
  try {
    const current = getMenubarUpdateStatus();
    if (!opts.manual && (!current.autoUpdate || !menubarAutomaticUpdateDue(current.checkedAt))) return result('skipped', 'Automatic update check is not due');
    previous.checkedAt = new Date().toISOString();
    previous.nextCheckAt = previous.autoUpdate ? new Date(Date.now() + MENUBAR_AUTO_UPDATE_INTERVAL_MS).toISOString() : null;
    saveUpdateState(result('unknown', 'Checking for AGI Menu updates'));
    let available = previous.available;
    try {
      available = await resolveMenubarVersion({ force: true, strict: true });
      if (menubarUpdateOutcome(previous.installed!, available) === 'current') {
        const running = buildMenubarDoctorReport();
        const needsRestart = !running.running || running.staleRunningProcess.some((p) => p.stale);
        if (needsRestart && opts.dryRun) return saveUpdateState(result('available', `AGI Menu ${previous.installed} is installed; restart needed to run it`, available));
        if (needsRestart && opts.manual) {
          const pending = saveUpdateState(result('updated', `AGI Menu ${previous.installed} is installed; restarting the older running app`, available));
          handoffMenubarRestart(previous.checkedAt);
          return pending;
        }
        return saveUpdateState(result('current', `AGI Menu ${previous.installed} is up to date`, available));
      }
      if (opts.dryRun) return saveUpdateState(result('available', `AGI Menu ${available} is available`, available));
      const src = await downloadMenubarHelperApp(available);
      if (!opts.manual && !menubarAutoUpdateEnabled()) return saveUpdateState({ ...result('available', 'Automatic updates were turned off', available), autoUpdate: false, nextCheckAt: null });
      if (!mayHealMenubar(false, src)) return saveUpdateState(result('skipped', 'Another install owns the helper', available));
      const exec = ensureMenubarAppInstalled({ forceReinstall: true, sourceAppPath: src });
      if (!exec) return saveUpdateState(result('failed', 'The verified bundle could not be installed', available));
      fs.writeFileSync(installedVersionMarkerPath(), JSON.stringify(stampFor(src)));
      stampMenubarHeal();
      const updated = saveUpdateState({ ...result('updated', `AGI Menu updated to ${available}`, available), installed: available });
      if (opts.deferRestart) handoffMenubarRestart(previous.checkedAt);
      else execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 0}/${serviceLabel()}`], { timeout: 10000, stdio: 'ignore' });
      return updated;
    } catch (error) { return saveUpdateState({ ...result('failed', (error as Error).message, available), installed: stampVersionLabel(readInstalledMenubarStamp()) }); }
  } finally { await releaseLock(); }
}
