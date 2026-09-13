/**
 * One address grammar for every `--host` an extracted CLI accepts (PHNX-4090).
 *
 * This file is copied verbatim into agents-cli, computer-cli, browser-cli and
 * secrets-cli, each with the same test vectors — deliberately not a published
 * package, so no engine grows a runtime dependency on another. Keep the four
 * copies identical; a change lands in all of them in the same delivery.
 *
 *   ssh://[user@]host[:ssh-port]   the authority port is the SSH port, never 9222
 *   cdp://host[:port]              default 9222
 *   vnc://host[:port]              default 5901
 *   tcp://host:port                no default — a helper RPC endpoint needs one
 *   wss://host/path, ws://…        a remote DevTools socket
 *   firefox-bidi://host[:port]     the browser's BiDi endpoint
 *   [user@]host                    implicit ssh://
 *
 * A query (`?port=9222&os=windows`) is preserved for the consumer that knows
 * what it means. Passwords never travel in an address: `user:secret@host` fails
 * loud, and so does any scheme not listed above.
 */

export const ADDRESS_SCHEMES = ['ssh', 'cdp', 'vnc', 'tcp', 'wss', 'ws', 'firefox-bidi'] as const;

export type AddressScheme = (typeof ADDRESS_SCHEMES)[number];

/** Ports a scheme implies when the address carries none. `tcp` has no default. */
export const DEFAULT_PORTS: Readonly<Partial<Record<AddressScheme, number>>> = {
  ssh: 22,
  cdp: 9222,
  vnc: 5901,
};

export interface Address {
  scheme: AddressScheme;
  user?: string;
  host: string;
  /** The port written in the authority, if any. See {@link addressPort} for the default. */
  port?: number;
  /** A non-root path (`wss://hub/devtools` → `/devtools`). */
  path?: string;
  query: Record<string, string>;
  /** The trimmed input, for messages. */
  raw: string;
}

const SCHEME_SET = new Set<string>(ADDRESS_SCHEMES);

/** A bare OpenSSH target: `host` or `user@host`, letters, digits, `.`, `_`, `-`. */
const IMPLICIT_SSH = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

export function parseAddress(input: string): Address {
  const raw = input.trim();
  if (!raw) throw new Error('empty address');

  if (!raw.includes('://')) {
    if (!IMPLICIT_SSH.test(raw) || raw.startsWith('-')) {
      throw new Error(`Invalid address ${JSON.stringify(raw)}. Expected scheme://host or user@host.`);
    }
    const at = raw.indexOf('@');
    return {
      scheme: 'ssh',
      user: at > 0 ? raw.slice(0, at) : undefined,
      host: at > 0 ? raw.slice(at + 1) : raw,
      query: {},
      raw,
    };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid address ${JSON.stringify(raw)}.`);
  }

  const scheme = url.protocol.replace(/:$/, '');
  if (!SCHEME_SET.has(scheme)) {
    throw new Error(`unsupported address scheme ${JSON.stringify(scheme)} in ${JSON.stringify(raw)}; expected one of ${ADDRESS_SCHEMES.join(', ')}`);
  }
  if (url.password) {
    throw new Error('passwords are not allowed in addresses');
  }
  const host = url.hostname;
  if (!host) throw new Error(`Invalid address ${JSON.stringify(raw)}: missing host`);
  const user = url.username ? decodeURIComponent(url.username) : undefined;
  if (user?.startsWith('-') || host.startsWith('-')) {
    throw new Error(`Invalid address ${JSON.stringify(raw)}: host or user cannot start with -`);
  }

  const port = url.port ? Number.parseInt(url.port, 10) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    throw new Error(`Invalid address ${JSON.stringify(raw)}: bad port`);
  }

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return {
    scheme: scheme as AddressScheme,
    user,
    host,
    port,
    path: url.pathname && url.pathname !== '/' ? url.pathname : undefined,
    query,
    raw,
  };
}

/** The effective port: written, else the scheme's default, else undefined. */
export function addressPort(addr: Address): number | undefined {
  return addr.port ?? DEFAULT_PORTS[addr.scheme];
}

/** `user@host` (or bare `host`) for an `ssh` address — what OpenSSH is given. */
export function sshTarget(addr: Address): string {
  if (addr.scheme !== 'ssh') {
    throw new Error(`expected ssh:// or user@host, got ${addr.scheme}:// (${addr.raw})`);
  }
  return addr.user ? `${addr.user}@${addr.host}` : addr.host;
}

/**
 * OpenSSH options carrying a non-default SSH port. `-o Port=N` rather than
 * `-p`/`-P` so the same argv serves both `ssh` and `scp`.
 */
export function sshPortArgs(addr: Address): string[] {
  if (addr.scheme !== 'ssh') {
    throw new Error(`expected ssh:// or user@host, got ${addr.scheme}:// (${addr.raw})`);
  }
  return addr.port === undefined ? [] : ['-o', `Port=${addr.port}`];
}

/** `host:port` for a `vnc` address, defaulting the RFB display port. */
export function vncEndpoint(addr: Address): string {
  if (addr.scheme !== 'vnc') {
    throw new Error(`expected vnc://, got ${addr.scheme}:// (${addr.raw})`);
  }
  return `${addr.host}:${addressPort(addr)}`;
}

/** `host:port` for a `tcp` address. A helper RPC endpoint has no default port. */
export function tcpEndpoint(addr: Address): string {
  if (addr.scheme !== 'tcp') {
    throw new Error(`expected tcp://, got ${addr.scheme}:// (${addr.raw})`);
  }
  if (addr.port === undefined) {
    throw new Error(`tcp:// requires a port (${addr.raw})`);
  }
  return `${addr.host}:${addr.port}`;
}

/**
 * The DevTools port a browser endpoint means. On `ssh://` the authority port is
 * the SSH port, so the DevTools port comes only from `?port=`; `cdp://` and
 * `ssh://` default to 9222, path-addressed sockets (`wss://`) have none.
 */
export function browserEndpointPort(addr: Address): number | undefined {
  const fromQuery = addr.query.port ? Number.parseInt(addr.query.port, 10) : undefined;
  if (fromQuery !== undefined) {
    if (!Number.isInteger(fromQuery) || fromQuery <= 0 || fromQuery > 65535) {
      throw new Error(`Invalid address ${JSON.stringify(addr.raw)}: bad ?port`);
    }
    return fromQuery;
  }
  if (addr.scheme === 'ssh') return 9222;
  if (addr.port !== undefined) return addr.port;
  return addr.scheme === 'cdp' ? 9222 : undefined;
}
