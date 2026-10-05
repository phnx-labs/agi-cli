// Legacy folding prefers the new tree, renames when possible, and leaves the compatibility link.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createLink } from './platform/links.js';

function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

function userDir(): string {
  return path.join(homeDir(), '.agents');
}

function systemDir(): string {
  return path.join(userDir(), '.system');
}

function legacySystemDir(): string {
  return path.join(homeDir(), '.agents-system');
}

export function foldLegacySystemRepo(): void {
  const LEGACY_SYSTEM_DIR = legacySystemDir();
  const SYSTEM_DIR = systemDir();
  const USER_DIR = userDir();

  let legacyStat: fs.Stats | null = null;
  try { legacyStat = fs.lstatSync(LEGACY_SYSTEM_DIR); } catch {  }
  if (!legacyStat) return;
  if (legacyStat.isSymbolicLink()) return;
  if (!legacyStat.isDirectory()) return;

  try {
    fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  } catch {  }

  if (!fs.existsSync(SYSTEM_DIR)) {
    try {
      fs.renameSync(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
      try { createLink(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch {  }
      console.error('Folded ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
      return;
    } catch {
    }
  }

  try {
    copyDirSkipExisting(LEGACY_SYSTEM_DIR, SYSTEM_DIR);
    fs.rmSync(LEGACY_SYSTEM_DIR, { recursive: true, force: true });
    try { createLink(SYSTEM_DIR, LEGACY_SYSTEM_DIR); } catch {  }
    console.error('Merged ~/.agents-system/ into ~/.agents/.system/ (left back-compat symlink)');
  } catch {  }
}

export function copyDirSkipExisting(src: string, dest: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (fs.existsSync(d)) {
      if (entry.isDirectory()) {
        const dStat = fs.lstatSync(d);
        if (dStat.isDirectory()) copyDirSkipExisting(s, d);
      }
      continue;
    }
    try {
      fs.renameSync(s, d);
    } catch {
      try {
        if (entry.isDirectory()) {
          copyDirSkipExisting(s, d);
        } else if (entry.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(s), d);
        } else {
          fs.copyFileSync(s, d);
        }
      } catch {  }
    }
  }
}
