import * as path from 'path';
import * as fs from 'fs';
import {
  getBrowserRuntimeDir as getBrowserRuntimeDirRoot,
  getBrowserDurableDir,
  readMeta,
  updateMeta,
} from '../state.js';
import { getConfigValue } from '../device-config.js';
import type { BrowserProfileConfig } from '../types.js';
import type { BrowserProfile, ProfileName } from './types.js';
import { machineId } from '../machine-id.js';
import {
  declaringDevices,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';
import { findBrowserPath, isPortInUse } from './chrome.js';
import { arcSpaceProfiles, discoverArcProfiles } from './arc-discovery.js';
import { discoverChromiumProfiles, discoverableChromiumBrowsers } from './chromium-discovery.js';

export type { BrowserProfile } from './types.js';
export {
  declaringDevices,
  profileKind,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';

/**
 * Name of the profile the setup wizards pin as this machine's default browser
 * (`agents setup`, `agents setup browser`). Older builds also auto-created it
 * silently on the first `agents browser start`; PHNX-3296 removed that — see
 * {@link ensureDefaultBrowserProfile}.
 *
 * It is `auto-chrome`, NOT `default`, since RUSH-2709: `default` used to be
 * both this concrete profile AND the alias meaning "whatever profile the user
 * configured", so `--profile default` landed on a literal Chrome on one command
 * and on the user's configured Comet on another. The alias now lives alone in
 * {@link DEFAULT_PROFILE_ALIAS} and resolves in exactly one place
 * ({@link resolveProfileRef}).
 */
export const DEFAULT_BROWSER_PROFILE_NAME = 'auto-chrome';

/**
 * What older builds named the auto-detected profile. Still honored everywhere:
 * a user whose machine already carries a `default` profile keeps using it (and
 * its running browser + runtime dirs) rather than having a second one created
 * beside it.
 */
export const LEGACY_DEFAULT_BROWSER_PROFILE_NAME = 'default';

/**
 * The reserved ALIAS. `--profile default` (and a `browser.profile` config value
 * of `default`) means "the configured default profile", not a profile called
 * `default` — unless a profile literally named `default` exists, which still
 * wins, so no existing config breaks.
 */
export const DEFAULT_PROFILE_ALIAS = 'default';

export type BrowserProfileWithDeclarations = BrowserProfile & { devices: string[] };

/**
 * The device-local configured default profile name (set via
 * `agents browser use`), or undefined when unset. When set, it
 * is the profile `agents browser start` resolves to for BOTH the no-`--profile`
 * path and an explicit `--profile default`. Stored as this machine's
 * `browser.profile` device-config key (the per-device doc's `config:` block —
 * see lib/device-config.ts).
 */
export function getConfiguredDefaultProfileName(): string | undefined {
  return (getConfigValue('browser.profile').value as string | undefined) || undefined;
}

export function getBrowserRuntimeDir(): string {
  return getBrowserRuntimeDirRoot();
}

export function getProfileRuntimeDir(name: string): string {
  return path.join(getBrowserRuntimeDir(), name);
}

/**
 * True when a profile attaches to a browser the user already launched and MUST
 * NOT spawn its own (PHNX-3967). Arc is inherently attach-only — it is
 * single-instance and relaunching it just produces a stray window, never a
 * second debuggable process (issue #2779) — regardless of an explicit policy.
 * Any other browser is attach-only only when the profile says so.
 */
export function isAttachOnlyProfile(profile: Pick<BrowserProfile, 'browser' | 'launchPolicy'>): boolean {
  return profile.browser === 'arc' || profile.launchPolicy === 'attach-only';
}

/**
 * The DURABLE `--user-data-dir` for a profile (PHNX-3967). An explicit
 * `profile.userDataDir` wins; otherwise a per-profile dir under
 * `~/.agents/.history/browser-profiles/<name>/chrome-data`, which is outside
 * `~/.agents/.cache` so a one-time sign-in survives quit+relaunch and the
 * `profiles remove` cache sweep. This is the dir the canonical Comet is launched
 * with and the value the ownership guard compares a running instance against.
 *
 * Note this is distinct from {@link getProfileRuntimeDir}'s cache `chrome-data`,
 * which `launchBrowser` uses for a `launch`-policy profile it spawns itself.
 */
export function resolveProfileDataDir(profile: Pick<BrowserProfile, 'name' | 'userDataDir'>): string {
  if (profile.userDataDir) return profile.userDataDir;
  return path.join(getBrowserDurableDir(), profile.name, 'chrome-data');
}

/**
 * Normalize a `--user-data-dir` path for the attach-only ownership comparison
 * (PHNX-3967): the real path when it resolves on this box, else the literal with
 * trailing slashes stripped. The single source both the runtime guard
 * (`drivers/local.ts` `verifyEndpointOwnership`) and `browser profiles doctor`
 * use, so they can never disagree about whether a running instance is foreign.
 */
export function normalizeDataDir(dir: string): string {
  let out = dir;
  try {
    out = fs.realpathSync(dir);
  } catch {
    /* dir may not exist on this box; compare the literal */
  }
  return out.replace(/\/+$/, '');
}

/**
 * Default destination for browser downloads for a profile. Set browser-global at
 * connect time (see BrowserService), so downloads land here even when the agent
 * never calls `browser download --path`. Keyed by the same composite name as the
 * runtime dir, so every profile is one self-contained tree.
 */
export function getProfileDownloadsDir(name: string): string {
  return path.join(getProfileRuntimeDir(name), 'downloads');
}

/**
 * Per-profile directory for a task's captured artifacts (screenshots, PDFs,
 * recordings). Replaces the legacy global `browser/sessions/<task>/` root — the
 * one-shot migration in migrate.ts folds old captures into here.
 */
export function getProfileSessionsDir(name: string, task: string): string {
  return path.join(getProfileRuntimeDir(name), 'sessions', task);
}

function configToProfile(
  name: string,
  config: BrowserProfileConfig,
  devices: string[] = [],
): BrowserProfileWithDeclarations {
  validateRemoteBrowserBinaries(config);
  return {
    name,
    description: config.description,
    browser: config.browser,
    binary: config.binary,
    electron: config.electron,
    targetFilter: config.targetFilter,
    endpoints: config.endpoints,
    defaultEndpoint: config.defaultEndpoint,
    launchPolicy: config.launchPolicy,
    userDataDir: config.userDataDir,
    profileDirectory: config.profileDirectory,
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
    logDir: config.logDir,
    logHost: config.logHost,
    arc: config.arc,
    devices,
  };
}

function profileToConfig(profile: BrowserProfile): BrowserProfileConfig {
  validateRemoteBrowserBinaries(profile);
  const config: BrowserProfileConfig = {
    browser: profile.browser,
    endpoints: profile.endpoints,
  };
  if (profile.description) config.description = profile.description;
  if (profile.binary) config.binary = profile.binary;
  if (profile.electron) config.electron = profile.electron;
  if (profile.targetFilter) config.targetFilter = profile.targetFilter;
  if (profile.defaultEndpoint) config.defaultEndpoint = profile.defaultEndpoint;
  if (profile.launchPolicy) config.launchPolicy = profile.launchPolicy;
  if (profile.userDataDir) config.userDataDir = profile.userDataDir;
  if (profile.profileDirectory) config.profileDirectory = profile.profileDirectory;
  if (profile.chrome) config.chrome = profile.chrome;
  if (profile.secrets) config.secrets = profile.secrets;
  if (profile.viewport) config.viewport = profile.viewport;
  if (profile.logDir) config.logDir = profile.logDir;
  if (profile.logHost) config.logHost = profile.logHost;
  if (profile.arc) config.arc = profile.arc;
  return config;
}

/**
 * Every browser profile this Mac already has, as agents-cli profiles:
 *
 * - each Arc Space (PHNX-2399): a Space carries its Arc profile's cookies and
 *   logins, so it IS the browser profile agents pick with `--profile`;
 * - each Comet profile from Comet's own `Local State` (PHNX-4042): pinned to
 *   Comet's user-data dir and profile directory, so the window agents open is
 *   the owner's window and a sign-in done once serves both.
 *
 * No second concept: agents see one `--profile` list. Discovery reads files
 * the browsers rewrite on every change, so a torn read is an ordinary event,
 * not corruption. It is reported as `errors` rather than thrown: the profile
 * store serves every browser on this machine, and a momentary Arc read must
 * never take the Comet or Chrome rows down with it. An error surfaces where a
 * profile of that browser is actually asked for by name.
 */
export interface DiscoveredProfiles {
  profiles: BrowserProfileWithDeclarations[];
  /** Per-browser discovery failures, keyed by the profile-name prefix (`arc`, `comet`). */
  errors: Record<string, string>;
}

export function discoverNativeProfiles(): DiscoveredProfiles {
  const profiles: BrowserProfileWithDeclarations[] = [];
  const errors: Record<string, string> = {};
  const arc = discoverArcProfiles();
  if (arc.ok) {
    for (const space of arcSpaceProfiles(arc)) {
      profiles.push({
        name: space.name,
        description: `Arc Space "${space.spaceTitle}" (${space.profileName})`,
        browser: 'arc',
        endpoints: { native: { target: 'arc-native://local' } },
        defaultEndpoint: 'native',
        launchPolicy: 'attach-only',
        arc: {
          profileId: space.profileId,
          profileName: space.profileName,
          spaceId: space.spaceId,
          spaceTitle: space.spaceTitle,
        },
        devices: [machineId()],
      });
    }
  } else if (arc.kind === 'invalid') {
    errors.arc = `Cannot discover Arc Spaces: ${arc.reason}`;
  }
  // Ports handed out earlier in this pass: two unpublished profiles must never
  // derive the same port before either is declared.
  const reserved = new Set<number>();
  for (const browser of discoverableChromiumBrowsers()) {
    const found = discoverChromiumProfiles(browser);
    if (!found.ok) {
      if (found.kind === 'invalid') errors[browser] = `Cannot discover ${browser} profiles: ${found.reason}`;
      continue;
    }
    for (const native of found.profiles) {
      const port = nativeChromiumPort(native.name, reserved);
      reserved.add(port);
      profiles.push({
        name: native.name,
        description: `${browser} profile "${native.displayName}" (${native.profileDirectory})`,
        browser,
        endpoints: [`cdp://127.0.0.1:${port}`],
        userDataDir: native.userDataDir,
        profileDirectory: native.profileDirectory,
        devices: [machineId()],
      });
    }
  }
  return { profiles, errors };
}

/**
 * The CDP port a discovered Chromium profile attaches on. Once the profile is
 * declared its port lives in the declaration; before that, the port is the
 * first free one from the canonical Comet port (9333, PHNX-3967), stepping
 * past ports other local declarations hold and past `reserved`, the ports
 * already given to sibling profiles in the same discovery pass.
 */
function nativeChromiumPort(name: string, reserved: ReadonlySet<number>): number {
  const declared = localDeclaration(name)?.config;
  const declaredPort = declared ? parseEndpointPort(declared) : undefined;
  if (declaredPort) return declaredPort;
  const taken = new Set<number>(reserved);
  for (const [other, declarations] of profileRegistry()) {
    if (other === name) continue;
    for (const declaration of declarations) {
      if (declaration.device !== machineId()) continue;
      const port = parseEndpointPort(declaration.config);
      if (port) taken.add(port);
    }
  }
  let port = 9333;
  while (taken.has(port)) port += 1;
  return port;
}

function parseEndpointPort(config: BrowserProfileConfig): number | undefined {
  const endpoints = config.endpoints;
  const first = Array.isArray(endpoints)
    ? endpoints[0]
    : endpoints && typeof endpoints === 'object'
      ? Object.values(endpoints)[0]?.target
      : undefined;
  if (typeof first !== 'string') return undefined;
  const match = /^cdp:\/\/[^:/?]+(?::(\d+)|\?port=(\d+))/.exec(first);
  const raw = match?.[1] ?? match?.[2];
  return raw ? Number(raw) : undefined;
}

/**
 * Publish every discovered native profile that this device has not declared
 * yet into its device declaration (`~/.agents/devices/<device>/agents.yaml`),
 * which the fleet shared-store sync carries to every other box (PHNX-4042).
 * That is what lets `agents browser profiles list` on a worker show this
 * Mac's `arc-*` and `comet-*` rows with WHERE=<this device>, and a start from
 * there route here. Idempotent; a discovery error skips that browser.
 */
export async function publishDiscoveredProfiles(): Promise<{ published: string[]; errors: Record<string, string> }> {
  const discovered = discoverNativeProfiles();
  const published: string[] = [];
  for (const profile of discovered.profiles) {
    if (localDeclaration(profile.name)) continue;
    await createProfile(profile);
    published.push(profile.name);
  }
  return { published, errors: discovered.errors };
}

/**
 * Bring a persisted discovered profile up to date with its live source (an Arc
 * Space title rename, a Comet profile rename). A source that is no longer
 * discoverable leaves the declaration as stored: listing still works, and using
 * the profile fails loud where the browser is actually reached.
 */
function refreshDiscoveredProfile(
  profile: BrowserProfileWithDeclarations,
  live: BrowserProfileWithDeclarations[],
): BrowserProfileWithDeclarations {
  if (!profile.devices.includes(machineId())) return profile;
  if (profile.arc) {
    const current = live.find((candidate) => candidate.arc?.spaceId === profile.arc?.spaceId);
    if (!current) return profile;
    return { ...profile, arc: current.arc, description: profile.description ?? current.description };
  }
  if (profile.userDataDir && profile.profileDirectory) {
    const current = live.find(
      (candidate) => candidate.userDataDir === profile.userDataDir && candidate.profileDirectory === profile.profileDirectory,
    );
    if (!current) return profile;
    return { ...profile, description: profile.description ?? current.description };
  }
  return profile;
}

function selectedDeclaration(declarations: ProfileDeclaration[]): ProfileDeclaration {
  return declarations.find((declaration) => declaration.device === machineId()) ?? declarations[0];
}

function localDeclaration(name: string): ProfileDeclaration | undefined {
  return profileRegistry().get(name)?.find((declaration) => declaration.device === machineId());
}

/** Whether this name has persisted agents-cli metadata on the current device. */
export function isProfileDeclaredHere(name: string): boolean {
  return localDeclaration(name) !== undefined;
}

export async function listProfiles(): Promise<BrowserProfileWithDeclarations[]> {
  const native = discoverNativeProfiles();
  const configured = [...profileRegistry()].map(([name, declarations]) => {
    const selected = selectedDeclaration(declarations);
    return refreshDiscoveredProfile(
      configToProfile(name, selected.config, declarations.map((declaration) => declaration.device)),
      native.profiles,
    );
  });
  const names = new Set(configured.map((profile) => profile.name));
  return [...configured, ...native.profiles.filter((profile) => !names.has(profile.name))];
}

export async function getProfile(name: string): Promise<BrowserProfileWithDeclarations | null> {
  const native = discoverNativeProfiles();
  const declarations = profileRegistry().get(name);
  if (declarations?.length) {
    const selected = selectedDeclaration(declarations);
    return refreshDiscoveredProfile(
      configToProfile(name, selected.config, declarations.map((declaration) => declaration.device)),
      native.profiles,
    );
  }
  const discovered = native.profiles.find((profile) => profile.name === name) ?? null;
  // Only a profile of that browser asked for by name pays for its failed read.
  const prefix = name.split('-')[0];
  if (!discovered && native.errors[prefix]) throw new Error(native.errors[prefix]);
  return discovered;
}

/** Persist only the agents-cli alias for an auto-discovered native profile; never the browser's own data. */
export async function persistDiscoveredProfile(name: string): Promise<void> {
  if (localDeclaration(name)) return;
  const profile = discoverNativeProfiles().profiles.find((candidate) => candidate.name === name);
  if (!profile) return;
  await createProfile(profile);
}

/**
 * True when `profile` can actually launch or attach on THIS machine.
 *
 * A remote (`ssh://`) profile runs its browser on the far host, so a local
 * binary check doesn't apply — assume launchable. A local profile must have its
 * configured browser/binary present on disk here; a `default` profile
 * auto-created on a different OS (e.g. a macOS Chrome path reused on Linux — the
 * "Custom binary not found" failure) fails this check so the caller re-detects
 * for the current machine.
 */
export function isProfileLaunchableHere(profile: BrowserProfile): boolean {
  const nativeArc = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (nativeArc) {
    return !!profile.arc && discoverNativeProfiles().profiles.some(
      (candidate) => candidate.arc?.spaceId === profile.arc?.spaceId,
    );
  }
  const remote = Object.values(getEndpointPresets(profile)).some((preset) =>
    preset.target.startsWith('ssh://')
  );
  if (remote) return true;
  try {
    findBrowserPath(profile.browser, profile.binary);
    return true;
  } catch {
    return false;
  }
}

/**
 * The auto-detected profile this machine already carries, under either name —
 * the current `auto-chrome` or the `default` an older build wrote. Callers that
 * ask "is a default profile set up here?" MUST use this rather than probing one
 * name, or a machine that predates the RUSH-2709 rename grows a second one.
 */
export async function getAutoDetectedProfile(): Promise<BrowserProfile | null> {
  const current = machineId();
  const registry = profileRegistry();
  for (const name of [DEFAULT_BROWSER_PROFILE_NAME, LEGACY_DEFAULT_BROWSER_PROFILE_NAME]) {
    const declaration = registry.get(name)?.find((entry) => entry.device === current);
    if (declaration) return configToProfile(name, declaration.config, [current]);
  }
  return null;
}

/**
 * Resolve what a caller typed after `--profile` to a real, BARE profile name.
 * Every command — stop, status, navigate, tab, use, and (through
 * {@link resolveProfileRefForStart}) start — routes through this one function,
 * which is the whole point: before RUSH-2709 only `start` honored the reserved
 * `default` alias, so `--profile default` meant three different profiles across
 * three commands.
 *
 * Order:
 *   1. A profile that literally bears the given name always wins — including
 *      one a user genuinely named `default`, which resolves to itself.
 *   2. `default` (the alias) or no argument at all → the configured
 *      `browser.profile` for this machine, if it names a profile that exists.
 *   3. → the auto-detected profile ({@link DEFAULT_BROWSER_PROFILE_NAME}), or
 *      its legacy `default`-named predecessor when that is what is on disk.
 *   4. Otherwise the input is returned unchanged (so the caller reports its own
 *      `Profile "x" not found`), or `undefined` when nothing was passed.
 *
 * It never creates a profile, never warns, and never checks whether the profile
 * can launch HERE. That is deliberate: for most callers `--profile` is a FILTER
 * (`status`, `tasks`, `navigate --task`), where an absent flag means "no filter"
 * and rewriting or warning about the user's config would be wrong. Note the
 * corollary at those call sites — pass a ref only when the user gave one; do not
 * resolve `undefined` into a concrete profile, or an unscoped listing silently
 * becomes a scoped one.
 */
export async function resolveProfileRef(ref?: string): Promise<string | undefined> {
  if (ref && ref !== DEFAULT_PROFILE_ALIAS) {
    return ref;
  }
  if (ref === DEFAULT_PROFILE_ALIAS && (await getProfile(ref))) {
    // A profile the user literally named `default` outranks the alias.
    return ref;
  }

  const configured = getConfiguredDefaultProfileName();
  if (configured && configured !== DEFAULT_PROFILE_ALIAS && (await getProfile(configured))) {
    return configured;
  }
  if (await getProfile(DEFAULT_BROWSER_PROFILE_NAME)) return DEFAULT_BROWSER_PROFILE_NAME;
  if (await getProfile(LEGACY_DEFAULT_BROWSER_PROFILE_NAME)) {
    return LEGACY_DEFAULT_BROWSER_PROFILE_NAME;
  }
  return ref;
}

/**
 * `start`'s resolver. Same order as {@link resolveProfileRef} for an explicit
 * name, but the IMPLICIT path (no `--profile`, or the bare `default` alias with
 * no profile of that name) goes through {@link ensureDefaultBrowserProfile} —
 * which additionally verifies the resolved default can launch on THIS machine.
 * An undeclared configured default is an error. A declared default whose
 * browser isn't installed here warns and falls through to an existing profile,
 * else the actionable throw below.
 *
 * `start` is the only command that launches a browser, so it is the only one
 * that may do those things; routing a filter-only command through this would
 * warn about config the user never asked it to touch.
 *
 * Throws ({@link noDefaultBrowserError}) when the configured default is
 * undeclared, or when no profile exists that can launch here.
 */
export async function resolveProfileRefForStart(ref?: string): Promise<string> {
  if (ref && ref !== DEFAULT_PROFILE_ALIAS) return ref;
  // A profile the user literally named `default` still outranks the alias.
  if (ref === DEFAULT_PROFILE_ALIAS && (await getProfile(ref))) return ref;
  return (await ensureDefaultBrowserProfile()).name;
}

/**
 * The error a bare `agents browser start` raises when this machine has no
 * launchable default browser. Its own function so the wording — the one thing
 * the user reads when a browser won't start — stays in one place and is
 * testable without spawning anything.
 *
 * Since PHNX-3296 this is a hard stop, NOT a silent auto-create. The old
 * behavior probed the installed Chromium-family browsers and minted a
 * logged-out `auto-chrome` profile on the spot; agents then drove a signed-out
 * Chrome that popped up on the user's Mac unbidden. Which browser agents drive
 * is a choice the user makes once, in `agents setup` — never one this code
 * makes for them.
 */
export function noDefaultBrowserError(): Error {
  return new Error(
    'No default browser is configured on this machine. ' +
      'Run `agents setup` (or `agents browser use <name>`) to pick the browser agents should drive. ' +
      'If this is a headless worker, use the fleet hub instead: `agents config set browser.device <host>`.',
  );
}

/**
 * Resolve the profile a bare `agents browser start` uses.
 *
 * Order: (1) the device-local configured default (`agents browser use <name>`)
 * when it names a profile that exists and can launch here; (2) an existing
 * auto-detected profile (`auto-chrome`, or a legacy `default`) that can launch
 * here. When neither resolves, THROW ({@link noDefaultBrowserError}) rather than
 * detect-and-create — see that function for why (PHNX-3296).
 *
 * Two failure modes at the configured-default step are not the same:
 *   - No device declares the name (including a leftover central `browser:`
 *     entry that was never claimed) → throw. Falling back to a minted profile
 *     would hand the agent a logged-out browser while `browser.profile` still
 *     names the credentialed one.
 *   - The name is declared, but its browser/binary is not installed HERE →
 *     warn and fall through to an existing profile, else the actionable throw.
 *     That is a missing binary on this box, not a missing identity.
 *
 * This RECOGNIZES a pre-existing `auto-chrome`/legacy `default` so installs that
 * already carry one keep resolving it (and its running browser + runtime dirs),
 * but it never CREATES one.
 */
export async function ensureDefaultBrowserProfile(): Promise<BrowserProfile> {
  const configured = getConfiguredDefaultProfileName();
  if (configured && configured !== DEFAULT_PROFILE_ALIAS) {
    const chosen = await getProfile(configured);
    if (chosen && (!chosen.devices.includes(machineId()) || isProfileLaunchableHere(chosen))) return chosen;
    if (!chosen) {
      const central = (readMeta() as { browser?: Record<string, BrowserProfileConfig> }).browser ?? {};
      if (central[configured]) {
        throw new Error(
          `configured default browser profile "${configured}" is not declared by any device. ` +
            `It still lives in the central agents.yaml browser: map. ` +
            `Claim it on the machine that hosts that browser with: agents browser profiles claim ${configured}`,
        );
      }
      throw new Error(
        `configured default browser profile "${configured}" is not declared by any device. ` +
          `Create it with: agents browser profiles create ${configured} --browser <chrome|comet|chromium|brave|edge|arc|custom> ` +
          `(or, if it is a leftover central profile, claim it with: agents browser profiles claim ${configured}). ` +
          `Or unset the default with: agents browser use --unset`,
      );
    }
    console.warn(
      `warning: configured default browser profile "${configured}" can't launch on this ` +
        `machine (its browser/binary isn't installed here). ` +
        `Fix with: agents browser use <name>  (or --unset)`,
    );
  }

  // Prefer whichever auto-detected profile this machine already carries: the
  // current `auto-chrome`, else the `default` an older build wrote. Reusing the
  // legacy one is what keeps a currently-running browser (and its runtime dirs,
  // keyed `default@endpoint-0`) attached after the rename.
  const existing = await getAutoDetectedProfile();
  if (existing && isProfileLaunchableHere(existing)) return existing;

  // No configured default resolves and no existing profile launches here. We
  // used to auto-detect the first installed browser and silently mint (or
  // regenerate) an `auto-chrome` profile at this point — that is exactly the
  // logged-out-Chrome-on-your-Mac bug PHNX-3296 removed. Stop and tell the user
  // how to choose a browser instead.
  throw noDefaultBrowserError();
}

/**
 * Compute the LOCAL port a profile will occupy at runtime:
 *   - `cdp://127.0.0.1:N` → N (we listen on N directly)
 *   - `ssh://host?port=N` → N (the SSH tunnel binds local N → remote N now)
 *   - `ws[s]://`, `http[s]://` → undefined (we don't claim a local port)
 *
 * This is what callers should compare to detect collisions; the (host,
 * port) tuple is no longer enough because SSH profiles do compete with
 * cdp:// profiles for local ports under the new tunnel scheme.
 */
export function effectiveLocalPort(profile: BrowserProfile): number | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  const target = presets[firstName].target;
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (url.protocol !== 'cdp:' && url.protocol !== 'ssh:') return undefined;
  return parseEndpointUrl(target)?.port;
}

/**
 * Find a port in 9222–9399 that is not already claimed by ANY existing
 * profile (cdp:// or ssh://) and is not in use by any OS process. The
 * SSH change to bind locally on `?port=N` means we no longer get to
 * skip remote profiles in this scan.
 */
export async function findFreeProfilePort(): Promise<number> {
  const profiles = await listProfiles();
  const usedByProfile = new Set<number>();
  for (const p of profiles) {
    const port = effectiveLocalPort(p);
    if (port !== undefined) usedByProfile.add(port);
  }

  for (let port = 9222; port <= 9399; port++) {
    if (usedByProfile.has(port)) continue;
    // Platform-aware bound-port probe (lsof on POSIX, netstat on Windows).
    // The old inline lsof call threw ENOENT on Windows — where lsof doesn't
    // exist — so EVERY port scanned as "free", including one an already-
    // running browser was listening on (typically 9222), and the new profile
    // would silently attach to that browser instead of launching its own.
    if (!isPortInUse(port)) return port;
  }

  throw new Error('No available ports in range 9222-9399');
}

function validateRemoteBrowserBinaries(
  profile: Pick<BrowserProfileConfig, 'binary' | 'endpoints'>
): void {
  if (!hasSshEndpoint(profile.endpoints)) return;
  validateRemoteBrowserBinary(profile.binary);
  if (!Array.isArray(profile.endpoints)) {
    for (const preset of Object.values(profile.endpoints)) {
      validateRemoteBrowserBinary(preset.binary);
    }
  }
}

function validateRemoteBrowserBinary(binary: string | undefined): void {
  if (!binary) return;
  if (/[\0\r\n;&|`$<>]/.test(binary)) {
    throw new Error(
      `Remote browser binary contains shell metacharacters: ${binary}`
    );
  }
}

export function hasSshEndpoint(endpoints: BrowserProfileConfig['endpoints']): boolean {
  const targets = Array.isArray(endpoints)
    ? endpoints
    : Object.values(endpoints).map((preset) => preset.target);
  return targets.some((target) => {
    try {
      return new URL(target).protocol === 'ssh:';
    } catch {
      return false;
    }
  });
}

/**
 * Whether the automatic central-tombstone drain (PHNX-3315) may claim `config`
 * into THIS device's doc during `agents sync`.
 *
 * Only REMOTE (`ssh://`) profiles qualify. An `ssh://` endpoint names a specific
 * host, so the profile is fungible by design — any box resolves it to the same
 * browser, and a concurrent double-claim across machines is harmless. A
 * local/`cdp://` profile has NO per-machine ownership signal: "that browser is
 * installed here" is not "I hold this profile's credentialed session", so two
 * boxes with the same common browser installed would each auto-claim the same
 * tombstone on their first post-merge sync and flip it identity->fungible
 * fleet-wide (the exact logged-out-browser failure this module exists to prevent
 * — PHNX-3315 review). Local/cdp tombstones stay central for the explicit
 * `agents browser profiles claim`.
 */
export function shouldAutoClaimCentralProfile(config: BrowserProfileConfig): boolean {
  if (!hasSshEndpoint(config.endpoints)) return false;
  return isProfileLaunchableHere({
    name: '_',
    browser: config.browser,
    binary: config.binary,
    endpoints: config.endpoints,
  });
}

/**
 * Refuse a profile whose LOCAL port another profile already owns.
 *
 * Every CDP/SSH profile ends up listening on (or tunneling to) the same LOCAL
 * port number as the one configured in the endpoint URL — SSH profiles reuse
 * `?port=N` locally, so we no longer scope by host. Two profiles that would
 * need the same local port can't both run at the same time.
 *
 * `opts.ignore` is the profile's own name on an edit. Without it every edit
 * collides with itself, since the stored copy still owns the port being kept.
 */
export function assertLocalPortFree(profile: BrowserProfile, opts: { ignore?: string } = {}): void {
  const wanted = effectiveLocalPort(profile);
  if (wanted === undefined) return;
  for (const [existingName, declarations] of profileRegistry()) {
    if (existingName === opts.ignore) continue;
    const declaration = declarations.find((entry) => entry.device === machineId());
    if (!declaration) continue;
    const existingProfile = configToProfile(existingName, declaration.config, [machineId()]);
    if (effectiveLocalPort(existingProfile) === wanted) {
      throw new Error(
        `Local port ${wanted} is already used by profile "${existingName}". ` +
          `Each profile must own a unique local port (SSH tunnels now bind ` +
          `to their configured port locally too). Pick a different port.`
      );
    }
  }
}

/** Declare a profile on this device. The same name may be declared by peers. */
export async function createProfile(profile: BrowserProfile): Promise<void> {
  if (localDeclaration(profile.name)) {
    throw new Error(`Profile "${profile.name}" already exists on ${machineId()}`);
  }

  assertLocalPortFree(profile);

  // Resolve the browser binary at create time. Fails fast with an actionable
  // error ("Comet not installed at /Applications/Comet.app") rather than
  // deferring the failure to the first task. `findBrowserPath` short-circuits
  // for browser=custom without a binary by throwing — same outcome.
  //
  // Skip for SSH profiles: the browser binary lives on the remote host, so a
  // local lookup would validate the wrong machine. The remote launcher resolves
  // it at connect time.
  const nativeArc = Object.values(getEndpointPresets(profile)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (nativeArc && (!profile.arc || profile.browser !== 'arc')) {
    throw new Error('An arc-native profile requires stable Arc Space metadata. Pick a discovered one from `agents browser profiles list`.');
  }
  // A discovered profile is pinned to a browser store on this disk
  // (`userDataDir` + `profileDirectory`) and is published unattended by the
  // daemon tick. Its binary is resolved where it is launched (`launchBrowser`),
  // so an app that was removed after its store fails loud at `start` instead of
  // blocking every other discovered row from publishing.
  const storePinned = !!profile.userDataDir && !!profile.profileDirectory;
  if (!hasSshEndpoint(profile.endpoints) && !nativeArc && !storePinned) {
    findBrowserPath(profile.browser, profile.binary);
  }

  const config = profileToConfig(profile);
  updateMeta((meta) => ({
    ...meta,
    deviceBrowser: { ...meta.deviceBrowser, [profile.name]: config },
  }));
}

export async function updateProfile(profile: BrowserProfile): Promise<void> {
  const local = localDeclaration(profile.name);
  if (!local) {
    const devices = declaringDevices(profile.name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${profile.name}" is not declared on ${machineId()}${where}`);
  }

  const config = profileToConfig(profile);
  updateMeta((meta) => ({
    ...meta,
    deviceBrowser: { ...meta.deviceBrowser, [profile.name]: config },
  }));
}

/** Fields an existing profile may be edited in place.
 *
 * Deliberately a SUBSET of {@link BrowserProfile}. `name` and `browser` are
 * identity, not settings: both key the on-disk runtime dir
 * ({@link getProfileRuntimeDir}) and any live `<name>@<endpoint>` connection, so
 * changing either orphans the cached browser data. Delete and recreate instead.
 */
export type EditableProfileFields = Partial<
  Pick<
    BrowserProfile,
    | 'description'
    | 'binary'
    | 'electron'
    | 'targetFilter'
    | 'endpoints'
    | 'launchPolicy'
    | 'userDataDir'
    | 'chrome'
    | 'secrets'
    | 'viewport'
    | 'arc'
  >
>;

export interface EditProfileResult {
  profile: BrowserProfile;
  devices: string[];
  /** Field names that actually changed. Empty means the edit was a no-op. */
  changed: string[];
}

/**
 * Merge `patch` onto the stored profile and persist it in the store it already
 * lives in (see {@link updateProfile} for the scope rules).
 *
 * Runs {@link createProfile}'s validations against the MERGED record, not just
 * the patched fields — a binary edit re-resolves the browser path, a
 * targetFilter edit re-checks the electron gate, and the local-port scan runs
 * with this profile excluded so an unchanged port is not a self-collision.
 */
export async function editProfile(
  name: string,
  patch: EditableProfileFields
): Promise<EditProfileResult> {
  const local = localDeclaration(name);
  if (!local) {
    const devices = declaringDevices(name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${name}" is not declared on ${machineId()}${where}`);
  }

  const devices = declaringDevices(name);
  const current = configToProfile(name, local.config, devices);
  const merged: BrowserProfile = { ...current, ...patch, name };

  const changed = (Object.keys(patch) as Array<keyof EditableProfileFields>).filter(
    (k) => JSON.stringify(current[k]) !== JSON.stringify(merged[k])
  );

  // A target filter only means anything for a profile that reuses an existing
  // page target rather than creating one — an Electron app or Arc (which crashes
  // on tab creation, so it drives an open tab / Space, PHNX-2399). The gate must
  // read the MERGED record: `--target-filter x` on a profile that is already
  // electron/arc is valid, and `--no-electron` on a Chromium profile that still
  // carries a filter is not. Checking the patch alone would accept both.
  if (merged.targetFilter && !merged.electron && merged.browser !== 'arc') {
    throw new Error(
      `--target-filter only applies to an Electron or Arc profile. ` +
        `Pass --electron, use --browser arc, or clear the filter with --target-filter ''.`
    );
  }

  assertLocalPortFree(merged, { ignore: name });

  // Same rule as create: the binary lives on the remote for an SSH profile, so a
  // local lookup would validate the wrong machine.
  const nativeArc = Object.values(getEndpointPresets(merged)).some(
    (preset) => preset.target.startsWith('arc-native:'),
  );
  if (!hasSshEndpoint(merged.endpoints) && !nativeArc) {
    findBrowserPath(merged.browser, merged.binary);
  }

  await updateProfile(merged);

  return {
    profile: merged,
    devices,
    changed,
  };
}

/** Profile names an agent has to be able to type and an fs path can hold. */
const PROFILE_NAME_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Throw if `name` cannot be used for a NEW profile.
 *
 * Shared by `profiles create` and {@link renameProfile} so the two cannot drift
 * — the shape rule used to live inline in the command, which is how `rename`
 * would have accepted a name `create` rejects.
 *
 * `default` is refused because it is the reserved ALIAS meaning "whatever
 * profile this machine is configured to use" (RUSH-2709). A literal profile by
 * that name makes `--profile default` mean two different things.
 */
export function assertRegistrableProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name ${JSON.stringify(name)}. Use lowercase letters, digits and hyphens, ` +
        `starting with a letter — e.g. 'agents'.`,
    );
  }
  if (name === DEFAULT_PROFILE_ALIAS) {
    throw new Error(
      `"${DEFAULT_PROFILE_ALIAS}" is the reserved alias for this machine's configured profile, ` +
        `not a profile name. Pick another name.`,
    );
  }
  // `browser.viewer: os` means "use the OS default handler". A profile by that
  // name turns the opt-out into a pointer at a profile — silently, since both
  // are just strings in the same key.
  if (name === 'os') {
    throw new Error(
      `"os" is the reserved browser.viewer value meaning the OS default handler, ` +
        `not a profile name. Pick another name.`,
    );
  }
}

/**
 * Rename a profile, taking its on-disk state with it.
 *
 * `editProfile` deliberately refuses a name change, and this is why: the name
 * keys the runtime dir ({@link getProfileRuntimeDir}), every fork/endpoint dir
 * derived from it, and the `browser.profile` pointer. Delete-and-recreate — the
 * only route before this — silently abandons the browser's `--user-data-dir`,
 * which is where a profile's logins live. On a real agent browser that is
 * gigabytes of session state and every account it has ever signed into.
 *
 * Refuses when the profile is in use: moving a `--user-data-dir` out from under
 * a running browser corrupts it.
 */
export async function renameProfile(
  from: ProfileName,
  to: ProfileName,
): Promise<{
  devices: string[];
  movedDirs: string[];
  repointedDefault: boolean;
  repointedViewer: boolean;
  /** Peers still pinning the OLD name, and which key each used. */
  stalePins: Array<{ device: string; key: 'browser.profile' | 'browser.viewer' }>;
}> {
  if (from === to) throw new Error(`"${from}" is already its own name.`);

  const local = localDeclaration(from);
  if (!local) {
    const devices = declaringDevices(from);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${from}" is not declared on ${machineId()}${where}`);
  }
  if (profileRegistry().has(to)) throw new Error(`Profile "${to}" already exists`);

  assertRegistrableProfileName(to);

  const { isProfileInUse, listProfileCacheDirs } = await import('./runtime-state.js');
  if (isProfileInUse(from)) {
    throw new Error(
      `"${from}" is in use (live browser, tunnel, or open task). Renaming would move its ` +
        `user-data-dir out from under the running browser. Stop it first: agents browser stop --profile ${from}`,
    );
  }

  const config = local.config;
  const devices = declaringDevices(from);

  // Move the on-disk state BEFORE the config, so a crash between the two leaves
  // a profile whose dirs are already where the new name expects them rather than
  // a config pointing at dirs that no longer exist.
  // PRE-FLIGHT every destination before moving ANY of them. With the check
  // inside the loop, dir N was validated only after dirs 0..N-1 had already
  // moved: a collision on the second endpoint left the first one's logins
  // stranded under a name with no config entry, and the error named only the
  // squatter. Nothing repaired that, and the user was never told.
  const plan: Array<{ dir: string; dest: string }> = [];
  for (const dir of listProfileCacheDirs(from)) {
    const base = path.basename(dir);
    const suffix = base.slice(from.length);
    const dest = path.join(path.dirname(dir), `${to}${suffix}`);
    if (fs.existsSync(dest)) {
      throw new Error(
        `Cannot rename: ${dest} already exists. Nothing was moved. Remove or rename it first.`,
      );
    }
    plan.push({ dir, dest });
  }

  const movedDirs: string[] = [];
  for (const { dir, dest } of plan) {
    fs.renameSync(dir, dest);
    movedDirs.push(dest);
  }

  updateMeta((meta) => {
    const next = { ...meta.deviceBrowser };
    delete next[from];
    return { ...meta, deviceBrowser: { ...next, [to]: config } };
  });

  // Both pointers are separate keys. Leaving `browser.profile` behind falls back
  // to auto-detect on the next `browser start`; leaving `browser.viewer` behind
  // sends every artifact back to the OS default handler — which is the exact bug
  // the viewer seam was built to fix, reintroduced by a rename.
  const { setConfigValue, getConfigValue } = await import('../device-config.js');

  let repointedDefault = false;
  if (getConfiguredDefaultProfileName() === from) {
    setConfigValue('browser.profile', to);
    repointedDefault = true;
  }

  let repointedViewer = false;
  if (getConfigValue('browser.viewer').value === from) {
    setConfigValue('browser.viewer', to);
    repointedViewer = true;
  }

  // A rename changes only this device's declaration. If it was the only
  // declaration, peer pins become stale and are reported rather than rewritten.
  const { devicesPinningBrowserProfile } = await import('../device-config.js');
  const stalePins =
    devices.length === 1
      ? devicesPinningBrowserProfile(from).filter((p) => p.device !== machineId())
      : [];

  return { devices, movedDirs, repointedDefault, repointedViewer, stalePins };
}

export async function deleteProfile(name: string): Promise<void> {
  if (!localDeclaration(name)) {
    const devices = declaringDevices(name);
    const where = devices.length > 0 ? `; declared on ${devices.join(', ')}` : '';
    throw new Error(`Profile "${name}" is not declared on ${machineId()}${where}`);
  }

  updateMeta((meta) => {
    const next = { ...meta.deviceBrowser };
    delete next[name];
    return { ...meta, deviceBrowser: Object.keys(next).length > 0 ? next : undefined };
  });
}

/** Widest NAME column we will grow to before truncating instead. */
const MAX_NAME_COLUMN = 28;

/**
 * Pad `text` to exactly `width` visible characters, truncating with an ellipsis
 * when it does not fit. `padEnd` alone does NOT bound a long value — it returns
 * the string unchanged when it already exceeds the width, which is what pushed
 * every later column out of alignment on a name longer than 20 characters
 * (RUSH-2710). Every column here goes through this, never a bare `padEnd`.
 */
export function padColumn(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text.padEnd(width);
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

/**
 * Render the `agents browser profiles list` table.
 *
 * Pure (no fs, no config reads) so the alignment and the default-marking rules
 * are unit-testable without a configured machine.
 *
 * Two things used to be called "default" in this listing with no way to tell
 * them apart (RUSH-2710): the profile literally NAMED `default` (the
 * auto-detected one), and whichever profile this machine resolves a bare
 * `agents browser start` to (`agents browser use <name>`). They
 * are frequently different profiles. Now only the second is a marker — a `*` in
 * a leading column, explained by a legend line — so the name column carries just
 * the name and `default` in it always means the profile of that name.
 *
 * WHERE lists the devices whose own files declare the name.
 */
export function formatProfilesTable(
  rows: BrowserProfileWithDeclarations[],
  configuredDefault?: string
): string[] {
  const cells = rows.map((profile) => {
    const presets = getEndpointPresets(profile);
    const endpoints = Object.entries(presets)
      .map(([name, ep]) => (name.startsWith('endpoint-') ? ep.target : `${name}=${ep.target}`))
      .join(', ');
    return {
      marker: profile.name === configuredDefault ? '*' : ' ',
      name: profile.name,
      browser: profile.browser || '-',
      where: profile.devices.join(', '),
      description: profile.description ?? '',
      endpoints,
    };
  });

  const nameWidth = Math.min(
    MAX_NAME_COLUMN,
    Math.max('NAME'.length, ...cells.map((c) => c.name.length))
  );
  const browserWidth = Math.max('BROWSER'.length, ...cells.map((c) => c.browser.length));
  const whereWidth = Math.min(36, Math.max('WHERE'.length, ...cells.map((c) => c.where.length)));
  const hasDescriptions = cells.some((c) => c.description);
  const descWidth = hasDescriptions
    ? Math.min(36, Math.max('DESCRIPTION'.length, ...cells.map((c) => c.description.length)))
    : 0;

  const row = (
    marker: string,
    name: string,
    browser: string,
    where: string,
    desc: string,
    endpoints: string
  ): string =>
    `${marker} ` +
    padColumn(name, nameWidth) + '  ' +
    padColumn(browser, browserWidth) + '  ' +
    padColumn(where, whereWidth) + '  ' +
    (hasDescriptions ? padColumn(desc, descWidth) + '  ' : '') +
    endpoints;

  const header = row(' ', 'NAME', 'BROWSER', 'WHERE', 'DESCRIPTION', 'ENDPOINTS');
  const lines = [header, '-'.repeat(header.length)];
  for (const c of cells) {
    lines.push(row(c.marker, c.name, c.browser, c.where, c.description, c.endpoints));
  }
  if (configuredDefault) {
    lines.push('');
    lines.push(
      `* = this machine's default profile (${configuredDefault}) — what a bare \`agents browser start\` uses.`
    );
  }
  return lines;
}

/**
 * Resolve a profile's endpoint presets into a normalized map regardless of
 * whether the YAML uses the legacy `string[]` shape or the new map shape.
 * The legacy entries get auto-named `endpoint-0`, `endpoint-1`, ... .
 */
export function getEndpointPresets(
  profile: BrowserProfile
): Record<string, import('./types.js').EndpointPreset> {
  if (Array.isArray(profile.endpoints)) {
    const out: Record<string, import('./types.js').EndpointPreset> = {};
    profile.endpoints.forEach((target, i) => {
      out[`endpoint-${i}`] = { target };
    });
    return out;
  }
  return profile.endpoints;
}

/**
 * Pick the endpoint preset to use. Order:
 *   1. Explicit name passed in (errors if unknown)
 *   2. `profile.defaultEndpoint` if set
 *   3. First entry (preserves legacy string[] behavior)
 *
 * Returns the resolved name + the preset (with per-endpoint overrides
 * already applied to binary / targetFilter), so callers don't have to
 * remember the precedence rules.
 */
export function resolveEndpoint(
  profile: BrowserProfile,
  endpointName?: string
): { name: string; target: string; binary?: string; targetFilter?: string } {
  const presets = getEndpointPresets(profile);
  const names = Object.keys(presets);
  if (names.length === 0) {
    throw new Error(`Profile "${profile.name}" has no endpoints configured`);
  }

  let chosenName: string;
  if (endpointName) {
    if (!presets[endpointName]) {
      throw new Error(
        `Endpoint "${endpointName}" not found on profile "${profile.name}". ` +
          `Available: ${names.join(', ')}`
      );
    }
    chosenName = endpointName;
  } else if (profile.defaultEndpoint && presets[profile.defaultEndpoint]) {
    chosenName = profile.defaultEndpoint;
  } else {
    chosenName = names[0];
  }

  const preset = presets[chosenName];
  return {
    name: chosenName,
    target: preset.target,
    binary: preset.binary ?? profile.binary,
    targetFilter: preset.targetFilter ?? profile.targetFilter,
  };
}

/**
 * Extract the (host, port) pair intended by the profile's default endpoint.
 * Returns undefined for endpoint shapes that don't carry a port (e.g. ws:// without one).
 *
 * Ports are scoped by host: a `cdp://127.0.0.1:9222` profile (local Chrome on
 * this machine) and an `ssh://remote-host:9222` profile (Comet on a remote
 * host) point at different physical ports — the host disambiguates them.
 *
 * Accepts both `scheme://host:port` and `scheme://host?port=N` shapes (the
 * latter is the documented form in `types.ts` for `ssh://`). Without this,
 * `ssh://remote-host?port=18805` would silently fall back to 9222 and every
 * `?port=`-style SSH profile would collide on creation.
 */
export function extractConfiguredEndpoint(
  profile: BrowserProfile
): { host: string; port: number } | undefined {
  const presets = getEndpointPresets(profile);
  const firstName = profile.defaultEndpoint && presets[profile.defaultEndpoint]
    ? profile.defaultEndpoint
    : Object.keys(presets)[0];
  if (!firstName) return undefined;
  return parseEndpointUrl(presets[firstName].target);
}

/**
 * Shared endpoint parser used by both the collision-detection code path and
 * the connection drivers. Returning a single normalized `(host, port)` here
 * keeps `extractConfiguredEndpoint` and the SSH driver from drifting on URL
 * conventions (which is how `?port=N` ended up being silently ignored).
 */
export function parseEndpointUrl(
  endpoint: string
): { host: string; port: number } | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  const host = normalizeHost(url.hostname, url.protocol);
  if (!host) return undefined;
  const port = extractPortFromUrl(url);
  if (port !== undefined) return { host, port };
  // SSH endpoints tunnel to a remote port AND bind that same port locally,
  // so they do "own" a local port — the host-scoped collision check used
  // to disagree, but we want the local-port-scoped semantics now.
  if (url.protocol === 'cdp:' || url.protocol === 'ssh:') return { host, port: 9222 };
  return undefined;
}

function extractPortFromUrl(url: URL): number | undefined {
  if (url.port) {
    const n = parseInt(url.port, 10);
    if (Number.isFinite(n)) return n;
  }
  // `scheme://host?port=N` — the form documented for SSH endpoints in
  // `types.ts`. WHATWG URL parsing surfaces it via searchParams only.
  const qp = url.searchParams.get('port');
  if (qp) {
    const n = parseInt(qp, 10);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Extract the port intended by the profile's default endpoint.
 * Returns undefined for endpoint shapes that don't carry a port (e.g. ws:// without one).
 *
 * Note: this loses the host dimension — for collision detection use
 * `extractConfiguredEndpoint` instead, which returns the (host, port) pair.
 */
export function extractConfiguredPort(profile: BrowserProfile): number | undefined {
  return extractConfiguredEndpoint(profile)?.port;
}

function normalizeHost(hostname: string, protocol: string): string | undefined {
  if (!hostname) {
    // cdp:// and ssh:// without an explicit host imply localhost.
    if (protocol === 'cdp:' || protocol === 'ssh:') return '127.0.0.1';
    return undefined;
  }
  if (hostname === 'localhost') return '127.0.0.1';
  return hostname;
}

export function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
