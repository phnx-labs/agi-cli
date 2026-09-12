/** Resolve Agents permission groups and caller identities for the standalone
 * engine. The engine alone writes helper policy and peer files. */

import * as fs from 'fs';
import * as path from 'path';
import { getUserPermissionsDir, getPermissionsDir } from '../state.js';

// Walk all permission group YAMLs (user dir wins on name collision) and
// collect Computer(<bundle-id>) patterns from each group's `allow:` list.
// Returns distinct bundle ids. Line-by-line regex extraction matches
// buildPermissionsFromGroups: YAML parsers stumble on the nested quotes in
// some rule values, but the strict pattern below catches our shape cleanly.
export function loadComputerAllowList(): string[] {
  const seenFiles = new Set<string>();
  const allowed = new Set<string>();

  for (const baseDir of [getUserPermissionsDir(), getPermissionsDir()]) {
    const groupsDir = path.join(baseDir, 'groups');
    if (!fs.existsSync(groupsDir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(groupsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

      // User dir wins on filename collision.
      const stem = entry.name.replace(/\.(yaml|yml)$/, '');
      if (seenFiles.has(stem)) continue;
      seenFiles.add(stem);

      const filePath = path.join(groupsDir, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Strict regex: optional whitespace, dash, quoted Computer(<id>).
      // Only honors `allow:` lines — `deny:` Computer patterns would be a
      // contradiction (everything is deny-by-default already).
      let inAllow = false;
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        const sectionMatch = line.match(/^(\w+)\s*:\s*$/);
        if (sectionMatch) {
          inAllow = sectionMatch[1] === 'allow';
          continue;
        }
        if (!inAllow) continue;
        const ruleMatch = line.match(/^\s*-\s*"Computer\(([^)]+)\)"\s*$/);
        if (ruleMatch) {
          const bundleId = ruleMatch[1].trim();
          if (bundleId.length > 0) allowed.add(bundleId);
        }
      }
    }
  }

  return [...allowed].sort();
}

/**
 * Default peer set: the standalone `computer` executable, this `agents` CLI's
 * own runtime, plus Rush.app if it's installed. realpath() the symlink chain so
 * we record the on-disk path the helper will see via proc_pidpath, not the shim
 * path.
 *
 * The standalone's path is the one that changed with PHNX-4075: the daemon's
 * caller is now the engine process, not this CLI. `agents`' own execPath stays
 * on the list because the engine may be a `.js` bin run through this same
 * runtime (`invocation()` in computer-client.ts), in which case proc_pidpath
 * still reports the runtime.
 *
 * Why path-based instead of codesign-team-id? The agents CLI is unsigned
 * today (npm distribution), and even if we sign Rush.app the team-id
 * check would need a separate roundtrip. Path is concrete and fast; the
 * daemon already runs as the user so anyone who can swap a binary at
 * these paths can do worse via other means.
 */
export function loadDefaultPeers(opts: { computerBin?: string } = {}): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    try {
      out.add(fs.realpathSync(p));
    } catch {
      out.add(p);
    }
  };

  // The standalone engine — the process that actually opens the socket now.
  if (opts.computerBin) add(opts.computerBin);

  // The runtime currently running this CLI. Still a possible proc_pidpath when
  // the engine is a .js bin executed through it.
  if (process.execPath) add(process.execPath);

  // Rush.app — the consumer Electron client. Both the helper-binary and
  // the main app binary are possible callers depending on how Rush wires
  // the RPC client.
  const rushCandidates = [
    '/Applications/Rush.app/Contents/MacOS/Rush',
    '/Applications/Rush.app/Contents/MacOS/Electron',
  ];
  for (const p of rushCandidates) {
    if (fs.existsSync(p)) add(p);
  }

  return [...out].sort();
}

/**
 * Parse a `host:port` VNC endpoint, defaulting the port to 5901. Pure.
 *
 * Kept on the consumer side because the `--vnc` FLAG is parsed here — the
 * platform gate has to know whether a remote desktop was named before the
 * engine is ever spawned (see `shouldBlockOffPlatform`). The RFB protocol
 * implementation itself went to the engine.
 */
export function parseVncEndpoint(raw: string | undefined): { host: string; port: number } | null {
  if (!raw || raw.length === 0) return null;
  const idx = raw.lastIndexOf(':');
  const host = idx >= 0 ? raw.slice(0, idx) : raw;
  const portStr = idx >= 0 ? raw.slice(idx + 1) : '5901';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: host || '127.0.0.1', port };
}

// Resolve the TCP endpoint for a remote daemon (the Windows helper), if
// configured. That helper binds loopback TCP and is reached over an `ssh -L`
// tunnel, so the endpoint is a local forwarded port. COMPUTER_HELPER_TCP is
// "host:port" (host defaults to 127.0.0.1); COMPUTER_HELPER_TOKEN is the shared
// secret sent in the first `auth` frame.
export function resolveTcpEndpoint(): { host: string; port: number; token: string | null } | null {
  const raw = process.env.COMPUTER_HELPER_TCP;
  if (!raw || raw.length === 0) return null;
  const [hostPart, portPart] = raw.includes(':') ? raw.split(':') : ['127.0.0.1', raw];
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = process.env.COMPUTER_HELPER_TOKEN;
  return { host: hostPart || '127.0.0.1', port, token: token && token.length > 0 ? token : null };
}

// Resolve the VNC/RFB endpoint for driving a remote GUI desktop over the RFB
// protocol (an x11vnc/Xvnc server — e.g. a headless Linux desktop or an LXD
// container exposing x11vnc on the host's Tailscale IP). COMPUTER_HELPER_VNC is
// "host:port" (port defaults to 5901); COMPUTER_HELPER_VNC_PASSWORD is the VNC
// password.
export function resolveVncEndpoint(): { host: string; port: number; password: string } | null {
  const parsed = parseVncEndpoint(process.env.COMPUTER_HELPER_VNC);
  if (!parsed) return null;
  return { ...parsed, password: process.env.COMPUTER_HELPER_VNC_PASSWORD ?? '' };
}
