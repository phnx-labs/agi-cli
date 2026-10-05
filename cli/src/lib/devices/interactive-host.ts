/** The `interactive` device sentinel: "wherever the human is sitting", one box pinned as
 * `interactive.host`, unlike `--device auto` which picks by load. A fixed token works on every
 * fleet, unlike a host name in a skill. */
import { getConfigValue } from '../device-config.js';
import { RESERVED_DEVICE_NAMES } from './registry.js';

const INTERACTIVE_DEVICE_SENTINEL = 'interactive';

export function isDeviceInteractive(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === INTERACTIVE_DEVICE_SENTINEL;
}

/** The device pinned as `interactive.host`, or null when unset. Callers must refuse on null, not
 * fall back to the local machine: the sentinel exists to reach a watched screen, and silently
 * running on a headless worker is the failure it prevents. */
export function resolveInteractiveDevice(): string | null {
  const pinned = getConfigValue('interactive.host').value;
  if (typeof pinned !== 'string' || !pinned.trim()) return null;
  const host = pinned.trim();
  // Defensive only. `interactive.host` rejects reserved sentinels at write time
  // (assertValidDeviceName), the right layer since refusing on read could only say "none is set".
  // This catches a config written by an older version.
  if (RESERVED_DEVICE_NAMES.has(host.toLowerCase())) return null;
  return host;
}

export function interactiveUnsetError(): string {
  return (
    `--device interactive needs an interactive host pinned, and none is set.\n` +
    `  Set it on the machine you sit at:  agents config set interactive.host <device>`
  );
}
