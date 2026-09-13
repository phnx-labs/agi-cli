/**
 * Seed the hermetic vitest device registry with the live Windows e2e host.
 *
 * `tests/setup.ts` (RUSH-2042) redirects `AGENTS_DEVICES_DIR` to a fork-private
 * empty directory so unit tests cannot leak fixtures into the real fleet
 * registry. The live Windows-host e2e suites (`computer/ssh-tunnel.e2e.test.ts`,
 * `browser/drivers/ssh.e2e.test.ts`) still need a real `DeviceProfile` for
 * `AGENTS_TEST_WIN_HOST` so `resolveRemoteDevice` can dial it. Without this
 * seed every e2e run fails immediately with `Unknown device 'win-mini'` —
 * which is what turned `tests-windows-host-e2e.yml` red after #1572 even when
 * the runner had a correct real registry and tailnet reach to win-mini.
 *
 * Source priority:
 *   1. Real fleet registry (`~/.agents/.history/devices/registry.json`) — copy
 *      the named entry into the private dir (read-only on the real file).
 *   2. `ssh -G <host>` — synthesize a minimal windows profile from OpenSSH's
 *      resolved user/hostname (covers a fresh crabbox runner that has Host
 *      config + key auth but never ran `agents devices sync`).
 *
 * Never writes to the real registry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

interface SshGFields {
  user: string;
  hostname: string;
}

interface SeedE2eWinHostOpts {
  host: string;
  /** Private `AGENTS_DEVICES_DIR` (fork-temp from setup.ts). */
  devicesDir: string;
  /** Absolute path to the real fleet registry.json (may not exist). */
  realRegistryPath: string;
  /** Injectable `ssh -G` resolver for tests. Defaults to a real `ssh -G` spawn (5s timeout). */
  resolveSshG?: (host: string) => SshGFields | null;
  /** Fixed now for deterministic tests. Defaults to `new Date().toISOString()`. */
  now?: string;
}

/** Parse `ssh -G` stdout into user + hostname. Returns null when either is missing. */
export function parseSshG(stdout: string): SshGFields | null {
  let user = '';
  let hostname = '';
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(user|hostname)\s+(\S+)/i.exec(line.trim());
    if (!m) continue;
    if (m[1].toLowerCase() === 'user') user = m[2];
    else hostname = m[2];
  }
  if (!user || !hostname) return null;
  // OpenSSH defaults hostname to the Host alias when HostName is unset; that is
  // still a usable dial target — OpenSSH resolves it via the user's ssh_config.
  return { user, hostname };
}

/** True when `hostname` looks like a raw IPv4/IPv6 address rather than a DNS name. */
export function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  if (hostname.includes(':')) return true; // rough IPv6
  return false;
}

/**
 * Minimal windows DeviceProfile-shaped entry from ssh -G fields. Shape matches
 * `DeviceProfile` in `src/lib/devices/registry.ts` so `sshTargetFor` /
 * `hostNameFor` accept it without a real `upsertDevice` (which needs locks +
 * module state).
 */
export function synthesizeWindowsDevice(
  name: string,
  fields: SshGFields,
  now: string,
): Record<string, unknown> {
  const address = isIpLiteral(fields.hostname)
    ? { via: 'manual' as const, ip: fields.hostname }
    : { via: 'manual' as const, dnsName: fields.hostname };
  return {
    name,
    platform: 'windows',
    shell: 'powershell',
    user: fields.user,
    address,
    auth: { method: 'key' },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultResolveSshG(host: string): SshGFields | null {
  // Process timeout only: `ssh -G` does not open a connection.
  const r = spawnSync('ssh', ['-G', host], {
    encoding: 'utf-8',
    timeout: 5_000,
    env: process.env,
  });
  if (r.error || r.status !== 0 || !r.stdout) return null;
  return parseSshG(r.stdout);
}

function readRegistry(file: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* missing or corrupt — treat as empty */
  }
  return {};
}

/**
 * Ensure `devicesDir/registry.json` contains an entry for `host`.
 * @returns `'real' | 'ssh-g' | 'already' | 'missing'` — how the entry was sourced.
 */
export function seedHermeticE2eWinHost(opts: SeedE2eWinHostOpts): 'real' | 'ssh-g' | 'already' | 'missing' {
  const host = opts.host.trim();
  if (!host) return 'missing';

  fs.mkdirSync(opts.devicesDir, { recursive: true });
  const privateRegPath = path.join(opts.devicesDir, 'registry.json');
  const priv = readRegistry(privateRegPath);
  if (priv[host] && typeof priv[host] === 'object') return 'already';

  // 1. Prefer the real fleet registry (dev machine / provisioned runner).
  const real = readRegistry(opts.realRegistryPath);
  const realEntry = real[host];
  if (realEntry && typeof realEntry === 'object') {
    priv[host] = realEntry;
    fs.writeFileSync(privateRegPath, JSON.stringify(priv, null, 2) + '\n', { mode: 0o600 });
    return 'real';
  }

  // 2. Synthesize from OpenSSH's resolved Host config.
  const resolve = opts.resolveSshG ?? defaultResolveSshG;
  const fields = resolve(host);
  if (!fields) return 'missing';
  // Bare alias hostnames are fine: synthesizeWindowsDevice sets address.dnsName
  // to the alias and OpenSSH resolves via the user's config (same as dialing the bare name).
  const now = opts.now ?? new Date().toISOString();
  priv[host] = synthesizeWindowsDevice(host, fields, now);
  fs.writeFileSync(privateRegPath, JSON.stringify(priv, null, 2) + '\n', { mode: 0o600 });
  return 'ssh-g';
}
