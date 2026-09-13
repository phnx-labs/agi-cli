/**
 * humans.yaml — owner identity, channels, and notification policy.
 *
 * Canonical file: ~/.agents/humans.yaml
 * Schema version: 1
 *
 * This module is the single read/write seam for humans.yaml. All channel/
 * notify consumers should read owner config from here.
 */
import * as fs from 'fs';
import * as yaml from 'yaml';
import type { HumansConfig, HumanOwner } from './types.js';
import { getHumansFilePath } from './state.js';

const HUMANS_VERSION = 1 as const;

const HUMANS_HEADER = `# humans.yaml — owner identity and notification channels
# Managed by agents-cli. See: agents humans --help
`;

/**
 * Read and parse humans.yaml. Returns null when the file does not exist or
 * is not a valid v1 config — never throws.
 */
export function readHumans(): HumansConfig | null {
  const filePath = getHumansFilePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const doc = parsed as Record<string, unknown>;
    if (doc['version'] !== HUMANS_VERSION) return null;
    return doc as unknown as HumansConfig;
  } catch {
    return null;
  }
}

/**
 * Write a HumansConfig to ~/.agents/humans.yaml. Creates the file with the
 * canonical header. Overwrites any existing content.
 */
export function writeHumans(config: HumansConfig): void {
  const filePath = getHumansFilePath();
  const body = yaml.stringify(config, { lineWidth: 120 });
  fs.writeFileSync(filePath, HUMANS_HEADER + body, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Return the effective owner notification destination from humans.yaml.
 * The owner's normal-severity policy selects the channel; when no normal
 * policy is declared, the first addressable channel is the default.
 */
export function getOwnerNotifyFromHumans(): { channel: string; to: string } | null {
  return getOwnerNotifyDestinationsFromHumans()[0] ?? null;
}

/**
 * Return every addressable owner destination selected by the normal-severity
 * policy, in policy order. A config without a policy keeps the historical
 * single-channel behavior by selecting the first addressable channel.
 */
export function getOwnerNotifyDestinationsFromHumans(): Array<{ channel: string; to: string }> {
  const owner = readHumans()?.owner;
  const channels = owner?.channels ?? [];
  const preferredIds = owner?.policy?.normal ?? [];
  const selected = preferredIds.length > 0
    ? preferredIds.map((id) => channels.find((entry) => entry.id === id))
    : [channels.find((entry) => entry.to)];
  const seen = new Set<string>();
  const destinations = selected
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.id && entry.to))
    .map((entry) => ({ channel: entry.id, to: entry.to! }))
    .filter((entry) => {
      const key = `${entry.channel}\0${entry.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (destinations.length > 0) return destinations;
  const firstAddressable = channels.find((entry) => entry.id && entry.to);
  if (firstAddressable?.to) return [{ channel: firstAddressable.id, to: firstAddressable.to }];
  const migrated = owner?.notify;
  if (migrated?.channel && migrated.to) return [migrated];
  return [];
}

/**
 * Read the owner block from humans.yaml. Returns null if missing.
 */
export function getOwnerFromHumans(): HumanOwner | null {
  return readHumans()?.owner ?? null;
}
