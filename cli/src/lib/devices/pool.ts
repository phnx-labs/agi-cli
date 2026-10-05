/**
 * The automatic-placement pool — which devices `--device auto` may pick from.
 *
 * One rule, in one place, so every automatic-placement path agrees: `agents run
 * --device auto`, `agents teams add --device auto`, the generic host resolver,
 * and the AGI EXT launch commands (which emit `--device auto` rather than
 * scoring devices themselves) all draw from {@link filterAutoPool}.
 *
 * The pool is an ALLOWLIST the moment the operator marks a worker. Roles are
 * stored in that device's tracked per-device doc
 * (`devices/<name>/agents.yaml` `config.role`, see `lib/device-config.ts`)
 * and sync with `agents repo push/pull`.
 *
 * | Fleet state | `--device auto` picks from |
 * |---|---|
 * | no device marked | every online device (unchanged behavior) |
 * | some marked `worker` | ONLY those workers |
 * | marked `personal` / `desktop` | never, under either state |
 * | `auto-launch.enabled` off | never, whatever its role or the mode |
 *
 * `auto.pool all` turns the WORKER allowlist off; `personal` and `desktop` stay
 * excluded, because a box the user sits at (personal) or a headed always-on
 * release/credential box (desktop) is marked precisely so agents stay off it.
 *
 * A device the operator turned off with `agents devices disable <name>`
 * (`auto-launch.enabled` = false) is dropped here too — one operator switch,
 * one place, so `disable` removes a box from EVERY automatic-placement path
 * (run/teams/ssh auto), not just one surface. Its sibling
 * `auto-launch.preferred` does not narrow the pool; it BOOSTS a member in the
 * ranker ({@link autoLaunchPreferredSet}, applied by `pickBestDevice`).
 */
import {
  autoPoolMode,
  listConfiguredDeviceRoles,
  loadAutoLaunchPreferences,
  type AutoLaunchPreference,
  type AutoPoolMode,
  type ConfiguredDeviceRole,
} from '../device-config.js';
import { normalizeHost } from '../machine-id.js';

const NEVER_AUTO: ReadonlySet<ConfiguredDeviceRole> = new Set<ConfiguredDeviceRole>(['personal', 'desktop']);

interface AutoPoolOptions {
  mode?: AutoPoolMode;
  roles?: Record<string, ConfiguredDeviceRole>;
  roster?: string[];
  autoLaunch?: Record<string, AutoLaunchPreference>;
}

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

function disabledAutoLaunchSet(pool: string[], opts: AutoPoolOptions): Set<string> {
  const prefs = opts.autoLaunch ?? loadAutoLaunchPreferences(opts.roster ?? pool);
  return new Set(
    Object.entries(prefs)
      .filter(([, pref]) => pref.enabled === false)
      .map(([name]) => normalizeHost(name)),
  );
}

export function autoLaunchPreferredSet(pool: string[], opts: AutoPoolOptions = {}): Set<string> {
  const prefs = opts.autoLaunch ?? loadAutoLaunchPreferences(opts.roster ?? pool);
  return new Set(
    Object.entries(prefs)
      .filter(([, pref]) => pref.preferred === true)
      .map(([name]) => normalizeHost(name)),
  );
}

export function isAutoPoolMember(host: string, opts: AutoPoolOptions = {}): boolean {
  return filterAutoPool([host], opts).length > 0;
}

export function listWorkerDevices(opts: Pick<AutoPoolOptions, 'roles'> = {}): string[] {
  const roles = opts.roles ?? listConfiguredDeviceRoles();
  return Object.entries(roles)
    .filter(([, role]) => role === 'worker')
    .map(([name]) => name);
}

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
