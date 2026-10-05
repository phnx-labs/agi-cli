/** Resolve Agents permission groups and caller identities for the standalone
 * engine. The engine alone writes helper policy and peer files. */

import * as fs from 'fs';
import * as path from 'path';
import { getUserPermissionsDir, getPermissionsDir } from '../state.js';

// Walk all permission group YAMLs (user dir wins) and collect `Computer(<bundle-id>)` patterns
// from `allow:`; returns distinct ids. Line-by-line regex like buildPermissionsFromGroups, as YAML
// parsers stumble on nested quotes.
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

/** Default peer set: the standalone `computer` executable, this CLI's runtime, and Rush.app if
 * installed, realpath()ed to the path the helper sees via proc_pidpath. Path-based, not
 * codesign-team-id, because the CLI is unsigned (npm). */
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

/** Parse a `host:port` VNC endpoint, port defaulting to 5901. Pure. The `--vnc` flag is parsed here
 * because the platform gate must know a remote desktop was named before spawning the engine
 * (`shouldBlockOffPlatform`). */
function parseVncEndpoint(raw: string | undefined): { host: string; port: number } | null {
  if (!raw || raw.length === 0) return null;
  const idx = raw.lastIndexOf(':');
  const host = idx >= 0 ? raw.slice(0, idx) : raw;
  const portStr = idx >= 0 ? raw.slice(idx + 1) : '5901';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: host || '127.0.0.1', port };
}

// Resolve the TCP endpoint for a remote daemon (the Windows helper), reached over an `ssh -L`
// tunnel. COMPUTER_HELPER_TCP is `host:port` (host defaults to 127.0.0.1); COMPUTER_HELPER_TOKEN
// is the secret sent in the first `auth` frame.
export function resolveTcpEndpoint(): { host: string; port: number; token: string | null } | null {
  const raw = process.env.COMPUTER_HELPER_TCP;
  if (!raw || raw.length === 0) return null;
  const [hostPart, portPart] = raw.includes(':') ? raw.split(':') : ['127.0.0.1', raw];
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = process.env.COMPUTER_HELPER_TOKEN;
  return { host: hostPart || '127.0.0.1', port, token: token && token.length > 0 ? token : null };
}

// Resolve the VNC/RFB endpoint for driving a remote GUI desktop (x11vnc/Xvnc, e.g. headless
// Linux). COMPUTER_HELPER_VNC is `host:port` (port defaults to 5901); COMPUTER_HELPER_VNC_PASSWORD
// is the password.
export function resolveVncEndpoint(): { host: string; port: number; password: string } | null {
  const parsed = parseVncEndpoint(process.env.COMPUTER_HELPER_VNC);
  if (!parsed) return null;
  return { ...parsed, password: process.env.COMPUTER_HELPER_VNC_PASSWORD ?? '' };
}
