/**
 * Registry-driven browser target resolution.
 *
 * The profile KIND is not a field: it falls out of how many devices declare
 * the name ({@link profileKind}). This module answers where a name should
 * connect, and never claims a leftover central profile (that race is T1).
 *
 * Three outcomes, no fourth:
 *   1. THIS device declares the name → connect locally.
 *   2. Only OTHER devices declare it → tunnel to a reachable declaring device.
 *   3. Nobody declares it → fail loud. Never auto-create a local browser
 *      under a name that means a logged-in browser somewhere else.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { machineId } from '../machine-id.js';
import {
  centralBrowserProfiles,
  declaringDevices,
  profileKind,
  profileRegistry,
  type ProfileDeclaration,
} from './registry.js';
import { parseEndpointUrl, resolveEndpoint } from './profiles.js';
import {
  connectionKey,
  parseConnectionKey,
  type BrowserProfile,
  type ConnectionKey,
} from './types.js';
import type { BrowserProfileConfig } from '../types.js';
import { probeHost } from '../hosts/ready.js';

export type DeviceProbeResult =
  | { reachable: true; os?: string }
  | { reachable: false; reason: string };

export type DeviceProbe = (device: string) => DeviceProbeResult;

export interface ResolvedBrowserTarget {
  name: string;
  kind: 'identity' | 'fungible';
  /** Device the daemon will talk to. */
  device: string;
  local: boolean;
  key: ConnectionKey;
  /** `cdp:` locally, `ssh:` when tunnelling to a declaring device. */
  target: string;
  profile: BrowserProfile;
  /**
   * Human line when the daemon picked a remote device. Command output
   * surfaces this so the caller knows WHERE the browser actually lives.
   */
  picked?: string;
  /** Native endpoints cannot be tunnelled; the CLI must re-exec on this device. */
  commandDispatch?: boolean;
}

/** Fork only fungible Electron profiles; identity-bearing ones share one connection. */
export function shouldForkProfile(
  kind: 'identity' | 'fungible',
  conn: { electron?: boolean; tasks: { size: number } },
): boolean {
  if (kind === 'identity') return false;
  return Boolean(conn.electron && conn.tasks.size > 0);
}

export function profileFromDeclaration(
  name: string,
  declaration: ProfileDeclaration,
): BrowserProfile {
  const config = declaration.config;
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
    chrome: config.chrome,
    secrets: config.secrets,
    viewport: config.viewport,
    logDir: config.logDir,
    logHost: config.logHost,
    arc: config.arc,
  };
}

/** Runtime key: profile name plus the resolved device. Drops `@endpoint-N`. */
export function profileConnectionKey(profileName: string, device: string): ConnectionKey {
  return connectionKey(profileName, device);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    let prev = row[0]!;
    row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = row[j + 1]!;
      const cost = a[i] === b[j] ? 0 : 1;
      row[j + 1] = Math.min(row[j]! + 1, row[j + 1]! + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** Declared names that look like `query` — used in the undeclared error. */
export function similarProfileNames(query: string, names: string[]): string[] {
  const q = query.toLowerCase();
  const maxDist = Math.max(2, Math.floor(q.length / 4));
  return names
    .filter((name) => {
      const x = name.toLowerCase();
      if (x === q) return false;
      if (x.includes(q) || q.includes(x)) return Math.min(x.length, q.length) >= 3;
      return levenshtein(x, q) <= maxDist;
    })
    .sort();
}

function lines(...parts: string[]): string {
  return parts.filter((part) => part != null && part !== '').join('\n');
}

export function undeclaredProfileError(name: string): Error {
  const central = centralBrowserProfiles();
  if (central[name]) {
    return new Error(
      lines(
        `Browser profile "${name}" is not declared by any device.`,
        `It still lives in the central agents.yaml browser: map.`,
        `Claim it on the machine that hosts that browser with: agents browser profiles claim ${name}`,
      ),
    );
  }

  const registry = profileRegistry();
  const similar = similarProfileNames(name, [...registry.keys()]);
  const similarLines = similar.map((candidate) => {
    const devices = (registry.get(candidate) ?? []).map((entry) => entry.device);
    return devices.length > 0
      ? `  ${candidate} (declared on ${devices.join(', ')})`
      : `  ${candidate}`;
  });

  return new Error(
    lines(
      `Browser profile "${name}" is not declared by any device.`,
      ...(similarLines.length > 0
        ? ['Similar names:', ...similarLines]
        : ['No device declares a similar name.']),
      `Create it on the machine that hosts the browser: agents browser profiles create ${name} --browser <chrome|comet|chromium|brave|edge|arc|custom>`,
      `Or, if it is a leftover central profile, claim it: agents browser profiles claim ${name}`,
    ),
  );
}

export function unreachableDeclaringDevicesError(
  name: string,
  devices: string[],
  failures: string[],
): Error {
  return new Error(
    lines(
      `Browser profile "${name}" is declared on ${devices.join(', ')}, but none of those devices are reachable.`,
      ...failures.map((line) => `  ${line}`),
      `A local browser will not be launched — that would be a logged-out copy of an identity-bearing profile.`,
    ),
  );
}

/**
 * Build the SSH endpoint used to tunnel to a declaring device's own browser.
 *
 * A `cdp://localhost:N` declaration on that device is THIS machine's loopback
 * if used as-is — that is the original bug. Rewrite it to `ssh://<device>?port=N`.
 * An already-`ssh://` declaration is used as written.
 */
function isWindowsOs(os?: string): boolean {
  if (!os) return false;
  const normalized = os.toLowerCase();
  return (
    normalized.includes('windows') ||
    normalized === 'win32' ||
    normalized === 'win64' ||
    normalized === 'windows_nt'
  );
}

export function sshEndpointForDeclaration(
  device: string,
  config: BrowserProfileConfig,
  endpointName?: string,
  os?: string,
): string {
  const profile = profileFromDeclaration('_', { device, config });
  const resolved = resolveEndpoint(profile, endpointName);
  if (resolved.target.startsWith('ssh:')) return resolved.target;
  // Native Arc endpoints (arc-native:) must NOT be rewritten into SSH tunnels
  // (PHNX-2399). They dispatch the whole command to the owner device instead.
  if (resolved.target.startsWith('arc-native:')) return resolved.target;
  const parsed = parseEndpointUrl(resolved.target);
  const port = parsed?.port ?? 9222;
  const osQuery = isWindowsOs(os) ? '&os=windows' : '';
  return `ssh://${device}?port=${port}${osQuery}`;
}

function defaultProbe(device: string): DeviceProbeResult {
  try {
    const result = probeHost(device);
    if (result.reachable) return { reachable: true, os: result.os };
    return { reachable: false, reason: `ssh to ${device} failed` };
  } catch (error) {
    return {
      reachable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Decide where `name` connects. Never claims a central leftover. Never
 * falls back to a local browser when the name is declared elsewhere.
 */
export function resolveBrowserTarget(
  name: string,
  opts: {
    endpointName?: string;
    here?: string;
    probe?: DeviceProbe;
  } = {},
): ResolvedBrowserTarget {
  const here = opts.here ?? machineId();
  const kind = profileKind(name);
  const declarations = profileRegistry().get(name) ?? [];
  if (kind === null || declarations.length === 0) {
    throw undeclaredProfileError(name);
  }

  const devices = declaringDevices(name);
  const local = declarations.find((entry) => entry.device === here);

  if (local) {
    const profile = profileFromDeclaration(name, local);
    const resolved = resolveEndpoint(profile, opts.endpointName);
    return {
      name,
      kind,
      device: here,
      local: true,
      key: profileConnectionKey(name, here),
      target: resolved.target,
      profile: {
        ...profile,
        binary: resolved.binary,
        targetFilter: resolved.targetFilter,
      },
    };
  }

  const probe = opts.probe ?? defaultProbe;
  const candidates = [...declarations].sort((a, b) => a.device.localeCompare(b.device));
  const failures: string[] = [];

  for (const declaration of candidates) {
    const result = probe(declaration.device);
    if (!result.reachable) {
      failures.push(`${declaration.device}: ${result.reason}`);
      continue;
    }
    const profile = profileFromDeclaration(name, declaration);
    const resolved = resolveEndpoint(profile, opts.endpointName);
    const target = sshEndpointForDeclaration(
      declaration.device,
      declaration.config,
      opts.endpointName,
      result.os,
    );
    const picked =
      candidates.length > 1
        ? `Using ${name} on ${declaration.device} (declared on ${devices.join(', ')})`
        : `Using ${name} on ${declaration.device}`;
    return {
      name,
      kind,
      device: declaration.device,
      local: false,
      key: profileConnectionKey(name, declaration.device),
      target,
      profile: {
        ...profile,
        binary: resolved.binary,
        targetFilter: resolved.targetFilter,
      },
      picked,
      commandDispatch: resolved.target.startsWith('arc-native:'),
    };
  }

  throw unreachableDeclaringDevicesError(name, devices, failures);
}

/**
 * Rename a leftover `<name>@endpoint-N` runtime dir to the new
 * `<name>@<device>` key so logins in chrome-data are not orphaned.
 *
 * Only when exactly one legacy dir exists and the destination does not —
 * several endpoint dirs stay put so a multi-endpoint profile is not merged.
 */
/**
 * Adopt a leftover `@endpoint-N` runtime dir onto the new key ONLY for a
 * local connect. Doing this for a tunnel key would rename this machine's
 * pre-T2 logged-out chrome-data onto `comet-local@zion`, and connectProfile
 * would then attach localhost CDP instead of tunnelling.
 */
export function adoptLegacyRuntimeIfLocal(
  local: boolean,
  profileName: string,
  newKey: ConnectionKey,
  runtimeRoot: string,
): void {
  if (!local) return;
  migrateLegacyRuntimeDir(profileName, newKey, runtimeRoot);
}

export function migrateLegacyRuntimeDir(
  profileName: string,
  newKey: ConnectionKey,
  runtimeRoot: string,
): void {
  const dest = path.join(runtimeRoot, newKey);
  if (fs.existsSync(dest)) return;
  if (!fs.existsSync(runtimeRoot)) return;

  const legacy = fs.readdirSync(runtimeRoot).filter((entry) => {
    const parsed = parseConnectionKey(entry);
    return (
      parsed.profile === profileName &&
      parsed.endpoint !== undefined &&
      /^endpoint-\d+$/.test(parsed.endpoint) &&
      parsed.fork === undefined
    );
  });
  if (legacy.length !== 1) return;
  fs.renameSync(path.join(runtimeRoot, legacy[0]!), dest);
}

/** True when a live key is a leftover `@endpoint-N` key of `profileName`. */
export function isLegacyEndpointKey(key: string, profileName: string): boolean {
  const parsed = parseConnectionKey(key);
  return (
    parsed.profile === profileName &&
    parsed.endpoint !== undefined &&
    /^endpoint-\d+$/.test(parsed.endpoint)
  );
}
