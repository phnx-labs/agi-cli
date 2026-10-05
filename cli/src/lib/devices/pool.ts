/** The automatic-placement pool for `--device auto`, one rule for every caller (filterAutoPool):
 * only `worker`-marked devices once any is marked, else every online one. `personal`/`desktop`
 * and `auto-launch.enabled` off are never picked; `auto.pool all` drops the worker allowlist. */
import {
  autoPoolMode,
  listConfiguredDeviceRoles,
  loadAutoLaunchPreferences,
  type AutoLaunchPreference,
  type AutoPoolMode,
  type ConfiguredDeviceRole,
} from '../device-config.js';
import { normalizeHost } from '../machine-id.js';

/** Roles that automatic placement never picks, whatever the pool mode: `personal` (a box you sit
 * at) and `desktop` (a headed always-on release/credential box). Neither is headless fan-out
 * capacity, and landing agent work there is what the mark prevents. Only `worker` is eligible. */
const NEVER_AUTO: ReadonlySet<ConfiguredDeviceRole> = new Set<ConfiguredDeviceRole>(['personal', 'desktop']);

interface AutoPoolOptions {
  /** Pool mode; defaults to the configured `auto.pool`. */
  mode?: AutoPoolMode;
  /** Configured roles by device name; defaults to the fleet-shared block. */
  roles?: Record<string, ConfiguredDeviceRole>;
  /** Device names to resolve roles for when `roles` is not given, so a fleet-wide role default
   * reaches a device with no per-device doc. Ignored once `roles` is supplied; see {@link
   * listConfiguredDeviceRoles}. */
  roster?: string[];
  /** Auto-launch flags by device name; defaults to the fleet-shared block for the roster. A device
   * with `enabled: false` is dropped from the pool. Inject `{}` in a pure unit test to keep the
   * rule off disk, as `roles: {}` does. See {@link loadAutoLaunchPreferences}. */
  autoLaunch?: Record<string, AutoLaunchPreference>;
}

/** Narrow a candidate host list to the devices automatic placement may pick, keeping input order.
 * An empty result is a real answer ("you marked workers and none is a candidate now"): callers
 * surface their own no-healthy-device error rather than widening back to the full fleet. */
export function filterAutoPool(pool: string[], opts: AutoPoolOptions = {}): string[] {
  const roles = opts.roles ?? listConfiguredDeviceRoles(opts.roster ?? pool);
  const byHost = new Map(Object.entries(roles).map(([name, role]) => [normalizeHost(name), role]));
  const roleOf = (host: string) => byHost.get(normalizeHost(host));
  const disabled = disabledAutoLaunchSet(pool, opts);
  const eligible = pool.filter((host) => {
    if (disabled.has(normalizeHost(host))) return false;
    const role = roleOf(host);
    return role === undefined || !NEVER_AUTO.has(role);
  });
  const mode = opts.mode ?? autoPoolMode();
  if (mode === 'all') return eligible;
  const anyWorkerMarked = [...byHost.values()].some((role) => role === 'worker');
  if (!anyWorkerMarked) return eligible;
  return eligible.filter((host) => roleOf(host) === 'worker');
}

/** Normalized hosts the operator turned off with `auto-launch.enabled` = false. */
function disabledAutoLaunchSet(pool: string[], opts: AutoPoolOptions): Set<string> {
  const prefs = opts.autoLaunch ?? loadAutoLaunchPreferences(opts.roster ?? pool);
  return new Set(
    Object.entries(prefs)
      .filter(([, pref]) => pref.enabled === false)
      .map(([name]) => normalizeHost(name)),
  );
}

/** Normalized hosts boosted with `auto-launch.preferred` = true, which `pickBestDevice` ranks
 * first. Unlike the disable drop, a preference never removes a device: an eligible non-preferred
 * box is still picked when no preferred one is available. */
export function autoLaunchPreferredSet(pool: string[], opts: AutoPoolOptions = {}): Set<string> {
  const prefs = opts.autoLaunch ?? loadAutoLaunchPreferences(opts.roster ?? pool);
  return new Set(
    Object.entries(prefs)
      .filter(([, pref]) => pref.preferred === true)
      .map(([name]) => normalizeHost(name)),
  );
}

/** True when this host is one automatic placement may pick. */
export function isAutoPoolMember(host: string, opts: AutoPoolOptions = {}): boolean {
  return filterAutoPool([host], opts).length > 0;
}

/** Device names explicitly marked `worker`, in registry order. */
export function listWorkerDevices(opts: Pick<AutoPoolOptions, 'roles'> = {}): string[] {
  const roles = opts.roles ?? listConfiguredDeviceRoles();
  return Object.entries(roles)
    .filter(([, role]) => role === 'worker')
    .map(([name]) => name);
}

/** One line naming why the pool is what it is, for the `--device auto` banner and no-healthy-device
 * error. Empty when no role narrows anything, so callers can append it unconditionally. */
export function describeAutoPool(opts: AutoPoolOptions = {}): string {
  const roles = opts.roles ?? listConfiguredDeviceRoles(opts.roster);
  const mode = opts.mode ?? autoPoolMode();
  const workers = listWorkerDevices({ roles });
  if (mode === 'all') {
    return workers.length > 0 ? 'auto.pool=all (worker marks ignored)' : '';
  }
  if (workers.length === 0) return '';
  return `workers: ${workers.join(', ')}`;
}
