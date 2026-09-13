import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as yaml from 'yaml';
import { commitCentralConfigAfterWrite, getUserAgentsDir, readMeta, updateMeta, withMetaLock, writeMetaUnlocked } from '../state.js';
import type { BrowserProfileConfig, Meta } from '../types.js';

export interface ProfileDeclaration {
  device: string;
  config: BrowserProfileConfig;
}

type LegacyBrowserMeta = Meta & { browser?: Record<string, BrowserProfileConfig> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The leftover central `browser:` tombstone from before per-device declarations.
 * Empty when none remain — and `agents sync` now drains it automatically via
 * {@link autoEvictCentralBrowserProfiles}, so on a synced box this is empty and
 * {@link profileRegistry} is the single source of truth. It survives only to
 * fold in migration and to explain an as-yet-unclaimed profile in a resolve
 * error (a profile hostable on a peer that has not synced yet), never as a
 * parallel store callers read for resolution.
 */
export function centralBrowserProfiles(): Record<string, BrowserProfileConfig> {
  const central = (readMeta() as LegacyBrowserMeta).browser;
  if (!central || Object.keys(central).length === 0) return {};
  return { ...central };
}

interface CentralClaimResult {
  claimed: string[];
  skipped: string[];
}

/**
 * Pick the central `browser:` entries this machine may fold into its device doc.
 *
 * A profile is claimable only when `canHostHere` accepts it — the endpoint or
 * binary resolves to THIS machine — so a `cdp://localhost:*` profile owned by a
 * peer is never claimed here (the logged-out-headless-browser bug this module
 * exists to prevent). A name already declared locally with an IDENTICAL config
 * is folded too, which just drops the redundant central copy. A name declared
 * locally with a DIFFERENT config is a genuine conflict: `onConflict: 'throw'`
 * (the explicit `claim` command) surfaces it; `onConflict: 'skip'` (automatic
 * eviction on sync) leaves it central so a stray duplicate can never wedge a
 * sync — an operator resolves it with an explicit claim.
 */
function selectClaimableCentral(
  central: Record<string, BrowserProfileConfig>,
  local: Record<string, BrowserProfileConfig>,
  canHostHere: (config: BrowserProfileConfig) => boolean,
  opts: { name?: string; onConflict: 'throw' | 'skip' },
): { toClaim: Record<string, BrowserProfileConfig>; skipped: string[] } {
  const toClaim: Record<string, BrowserProfileConfig> = {};
  const skipped: string[] = [];
  for (const [profileName, config] of Object.entries(central)) {
    if (opts.name && profileName !== opts.name) continue;
    if (!canHostHere(config)) {
      skipped.push(profileName);
      continue;
    }
    const existing = local[profileName];
    if (existing && !isDeepStrictEqual(existing, config)) {
      if (opts.onConflict === 'throw') {
        throw new Error(
          `Cannot migrate browser profile "${profileName}": central agents.yaml and this device's ` +
            `agents.yaml declare different configurations. Resolve the duplicate before retrying.`,
        );
      }
      skipped.push(profileName);
      continue;
    }
    toClaim[profileName] = config;
  }
  return { toClaim, skipped };
}

/**
 * Return `current` with `toClaim` moved out of the central `browser:` map and
 * into this device's `deviceBrowser` doc. The central key is dropped entirely
 * once drained, so the tombstone disappears rather than lingering as an empty
 * map. Pure — the caller applies it under the meta lock.
 */
function buildEvictedMeta(current: Meta, toClaim: Record<string, BrowserProfileConfig>): Meta {
  const legacy = current as LegacyBrowserMeta;
  const remaining: Record<string, BrowserProfileConfig> = {};
  for (const [profileName, config] of Object.entries(legacy.browser ?? {})) {
    if (!(profileName in toClaim)) remaining[profileName] = config;
  }
  const { browser: _removed, ...withoutCentralBrowser } = legacy;
  return {
    ...withoutCentralBrowser,
    ...(Object.keys(remaining).length > 0 ? { browser: remaining } : {}),
    deviceBrowser: { ...current.deviceBrowser, ...toClaim },
  } as Meta;
}

/**
 * Commit a claim computed by the EXPLICIT path (`migrateCentralBrowserProfiles`).
 * `toClaim` was selected from an unlocked snapshot — acceptable for that manual,
 * deliberate command; the automatic path instead selects INSIDE the lock (see
 * {@link autoEvictCentralBrowserProfiles}) so an unrelated concurrent write can
 * never be clobbered by a stale selection.
 */
function commitCentralClaim(toClaim: Record<string, BrowserProfileConfig>): void {
  updateMeta((current) => buildEvictedMeta(current, toClaim));
}

/**
 * Fold leftover central `browser:` entries into THIS device's declaration file.
 *
 * The EXPLICIT operator action (`agents browser profiles claim`), run on the
 * machine that actually owns the browser. It is never called implicitly from a
 * read, and that is the point: every device can read the central map, so an
 * implicit claim races — whichever box reads first claims the name, {@link
 * profileKind} then reports it `identity`, and the daemon tunnels to that box,
 * which for a fleet-wide `cdp://localhost:*` profile is a logged-out headless
 * browser wearing a credentialed browser's name. {@link autoEvictCentralBrowserProfiles}
 * closes that race for the automatic path (host-gated + non-throwing on sync);
 * this one is the manual, throw-on-conflict counterpart.
 *
 * `canHostHere` is supplied by the command layer so this module stays a leaf —
 * it must not import `isProfileLaunchableHere` (that would cycle through
 * chrome.ts → profiles.ts). Only profiles this machine can host are claimed; the
 * rest stay central, undeclared, and fail loudly on resolve.
 */
export function migrateCentralBrowserProfiles(
  canHostHere: (config: BrowserProfileConfig) => boolean,
  name?: string,
): CentralClaimResult {
  const meta = readMeta() as LegacyBrowserMeta;
  const central = meta.browser;
  if (!central || Object.keys(central).length === 0) {
    if (name) {
      throw new Error(`No leftover central browser profile named "${name}".`);
    }
    return { claimed: [], skipped: [] };
  }

  const local = meta.deviceBrowser ?? {};
  if (name) {
    const config = central[name];
    if (!config) {
      throw new Error(
        local[name]
          ? `Browser profile "${name}" is already declared on this device.`
          : `No leftover central browser profile named "${name}".`,
      );
    }
    if (!canHostHere(config)) {
      throw new Error(
        `Cannot claim browser profile "${name}": this machine cannot host it ` +
          `(its browser/binary isn't installed here). Run this command on the machine that has that browser.`,
      );
    }
  }

  const { toClaim, skipped } = selectClaimableCentral(central, local, canHostHere, {
    name,
    onConflict: 'throw',
  });

  const claimed = Object.keys(toClaim).sort();
  skipped.sort();
  if (claimed.length === 0) return { claimed, skipped };

  commitCentralClaim(toClaim);
  return { claimed, skipped };
}

/**
 * Automatic, self-draining counterpart to {@link migrateCentralBrowserProfiles}:
 * fold every lingering central `browser:` profile THIS machine can host into its
 * device doc and clear it from central, so the tombstone drains itself on
 * `agents sync` with no manual `agents browser profiles claim`.
 *
 * Safe to call implicitly, unlike a claim at registry-read time (which races —
 * see the `profileRegistry does not claim central declarations` guard), but the
 * CALLER owns one ordering invariant: invoke it AFTER the sync's repo pull. Two
 * boxes can both host the same profile (`canHostHere` is launchability, not
 * ownership), so a box acting on a PRE-pull view of central could re-claim a
 * profile a peer already drained and pushed — both writes land in different
 * device files with no git conflict, and the profile flips identity->fungible.
 * Running post-pull means central already reflects peers' drains, so the tombstone
 * is gone locally before this box looks. The selection is also computed INSIDE
 * the meta lock, and the path never throws — an unhostable profile or one that
 * conflicts with an existing local declaration is left central for an explicit
 * claim rather than wedging the sync. After it runs, {@link profileRegistry} is
 * the single source of truth: a claimed profile lives in the device doc alone,
 * never double-counted across the two stores.
 */
export function autoEvictCentralBrowserProfiles(
  canHostHere: (config: BrowserProfileConfig) => boolean,
): CentralClaimResult {
  // Read fresh, select, and commit inside ONE meta-lock acquisition. Reading
  // central before the lock and committing after (the manual path's shape) leaves
  // a window where a concurrent write on THIS machine changes central/deviceBrowser
  // between snapshot and commit, so the stale selection would be merged over the
  // fresher value. Selecting from the state the lock just handed us closes that
  // window. We write ONLY when something is claimed, so a no-op sync never touches
  // any doc (writeMetaUnlocked would otherwise re-serialize the device doc every
  // run). This mirrors updateMeta's own body, minus the unconditional write.
  let centralChanged = false;
  const result = withMetaLock(() => {
    const meta = readMeta() as LegacyBrowserMeta;
    const central = meta.browser;
    if (!central || Object.keys(central).length === 0) return { claimed: [], skipped: [] };
    const local = meta.deviceBrowser ?? {};
    const { toClaim, skipped } = selectClaimableCentral(central, local, canHostHere, {
      onConflict: 'skip',
    });
    const claimed = Object.keys(toClaim).sort();
    skipped.sort();
    if (claimed.length === 0) return { claimed, skipped };
    centralChanged = writeMetaUnlocked(buildEvictedMeta(meta, toClaim));
    return { claimed, skipped };
  });
  // Commit the central eviction AFTER the meta lock releases (the invariant:
  // every non-daemon central write commits after the lock, so agents.yaml is
  // never left dirty at rest to re-open the pull-trip window). Gated inside the
  // helper on centralChanged && !isDaemonProcess().
  commitCentralConfigAfterWrite(centralChanged);
  return result;
}

/**
 * Every profile any device declares, keyed by name to all declaring devices.
 * Reads every `devices/<name>/agents.yaml`; declarations never overwrite.
 */
export function profileRegistry(): Map<string, ProfileDeclaration[]> {
  const registry = new Map<string, ProfileDeclaration[]>();
  const devicesDir = path.join(getUserAgentsDir(), 'devices');
  if (!fs.existsSync(devicesDir)) return registry;

  const devices = fs
    .readdirSync(devicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const device of devices) {
    const file = path.join(devicesDir, device, 'agents.yaml');
    if (!fs.existsSync(file)) continue;

    let parsed: unknown;
    try {
      parsed = yaml.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new Error(
        `Cannot read browser declarations from ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (parsed == null) continue;
    if (!isRecord(parsed)) {
      throw new Error(`Cannot read browser declarations from ${file}: document root must be a map.`);
    }

    const browser = parsed.browser;
    if (browser == null) continue;
    if (!isRecord(browser)) {
      throw new Error(`Cannot read browser declarations from ${file}: browser must be a map.`);
    }

    for (const [name, config] of Object.entries(browser)) {
      if (!isRecord(config)) {
        throw new Error(`Cannot read browser declaration "${name}" from ${file}: profile must be a map.`);
      }
      const declarations = registry.get(name) ?? [];
      declarations.push({ device, config: config as unknown as BrowserProfileConfig });
      registry.set(name, declarations);
    }
  }

  return registry;
}

/** Devices declaring `name`, empty when nobody does. */
export function declaringDevices(name: string): string[] {
  return (profileRegistry().get(name) ?? []).map((declaration) => declaration.device);
}

/** Exactly one declaring device is identity-bearing; several are fungible. */
export function profileKind(name: string): 'identity' | 'fungible' | null {
  const count = profileRegistry().get(name)?.length ?? 0;
  if (count === 0) return null;
  return count === 1 ? 'identity' : 'fungible';
}
