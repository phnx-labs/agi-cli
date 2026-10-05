
import * as fs from 'fs';
import * as path from 'path';
import { getUserPermissionsDir, getPermissionsDir } from '../state.js';

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

// Trust concrete realpaths: legitimate launchers differ, but arbitrary same-team processes stay excluded.
export function loadDefaultPeers(opts: { computerBin?: string } = {}): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    try {
      out.add(fs.realpathSync(p));
    } catch {
      out.add(p);
    }
  };

  if (opts.computerBin) add(opts.computerBin);

  if (process.execPath) add(process.execPath);

  const rushCandidates = [
    '/Applications/Rush.app/Contents/MacOS/Rush',
    '/Applications/Rush.app/Contents/MacOS/Electron',
  ];
  for (const p of rushCandidates) {
    if (fs.existsSync(p)) add(p);
  }

  return [...out].sort();
}

function parseVncEndpoint(raw: string | undefined): { host: string; port: number } | null {
  if (!raw || raw.length === 0) return null;
  const idx = raw.lastIndexOf(':');
  const host = idx >= 0 ? raw.slice(0, idx) : raw;
  const portStr = idx >= 0 ? raw.slice(idx + 1) : '5901';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: host || '127.0.0.1', port };
}

export function resolveTcpEndpoint(): { host: string; port: number; token: string | null } | null {
  const raw = process.env.COMPUTER_HELPER_TCP;
  if (!raw || raw.length === 0) return null;
  const [hostPart, portPart] = raw.includes(':') ? raw.split(':') : ['127.0.0.1', raw];
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) return null;
  const token = process.env.COMPUTER_HELPER_TOKEN;
  return { host: hostPart || '127.0.0.1', port, token: token && token.length > 0 ? token : null };
}

export function resolveVncEndpoint(): { host: string; port: number; password: string } | null {
  const parsed = parseVncEndpoint(process.env.COMPUTER_HELPER_VNC);
  if (!parsed) return null;
  return { ...parsed, password: process.env.COMPUTER_HELPER_VNC_PASSWORD ?? '' };
}
