
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

