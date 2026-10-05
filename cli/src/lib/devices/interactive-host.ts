import { getConfigValue } from '../device-config.js';
import { RESERVED_DEVICE_NAMES } from './registry.js';

const INTERACTIVE_DEVICE_SENTINEL = 'interactive';

export function isDeviceInteractive(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === INTERACTIVE_DEVICE_SENTINEL;
}

export function resolveInteractiveDevice(): string | null {
  const pinned = getConfigValue('interactive.host').value;
  if (typeof pinned !== 'string' || !pinned.trim()) return null;
  const host = pinned.trim();
  if (RESERVED_DEVICE_NAMES.has(host.toLowerCase())) return null;
  return host;
}

export function interactiveUnsetError(): string {
  return (
    `--device interactive needs an interactive host pinned, and none is set.\n` +
    `  Set it on the machine you sit at:  agents config set interactive.host <device>`
  );
}
