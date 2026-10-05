import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';
import { type DeviceProfile } from './registry.js';

const UNIVERSAL_TERMS = new Set<string>([
  'dumb',
  'ansi',
  'vt100',
  'vt102',
  'vt220',
  'linux',
  'cygwin',
  'xterm',
  'xterm-color',
  'xterm-16color',
  'xterm-256color',
  'screen',
  'screen-256color',
  'tmux',
  'tmux-256color',
  'rxvt',
  'rxvt-unicode',
  'rxvt-unicode-256color',
]);

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 8000;

export function shouldSyncTerminfo(params: {
  term?: string;
  shell: DeviceProfile['shell'];
  interactive: boolean;
}): boolean {
  if (!params.interactive) return false;
  if (params.shell === 'powershell') return false;
  const term = params.term?.trim();
  if (!term) return false;
  if (UNIVERSAL_TERMS.has(term)) return false;
  return true;
}

export function terminfoHostKey(device: Pick<DeviceProfile, 'user' | 'name'>, addr: string | undefined): string {
  // Cache per user and dial host: one account's install says nothing about another account's terminfo.
  const host = addr ?? device.name;
  return device.user ? `${device.user}@${host}` : host;
}

function stampDir(cacheRoot?: string): string {
  return path.join(cacheRoot ?? getCacheDir(), 'devices', 'terminfo');
}

function stampFile(host: string, term: string, cacheRoot?: string): string {
  const safe = `${host}__${term}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stampDir(cacheRoot), safe);
}

export function terminfoSynced(host: string, term: string, cacheRoot?: string): boolean {
  try {
    const st = fs.statSync(stampFile(host, term, cacheRoot));
    return Date.now() - st.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export function markTerminfoSynced(host: string, term: string, cacheRoot?: string): void {
  try {
    fs.mkdirSync(stampDir(cacheRoot), { recursive: true });
    fs.writeFileSync(stampFile(host, term, cacheRoot), `${new Date().toISOString()}\n`);
  } catch {
  }
}

export function localTerminfoSource(term: string): string | null {
  try {
    const res = spawnSync('infocmp', ['-x', term], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (res.status === 0 && res.stdout && res.stdout.trim().length > 0) {
      return res.stdout;
    }
  } catch {
  }
  return null;
}

export function syncTerminfoToDevice(opts: {
  device: DeviceProfile;
  host: string;
  term: string | undefined;
  sshArgs: string[];
  sshEnv: Record<string, string>;
}): boolean {
  // Propagation is an interactive-login optimization; every failure degrades to an ordinary SSH login.
  const term = opts.term?.trim();
  if (!term) return false;
  if (terminfoSynced(opts.host, term)) return false;

  const source = localTerminfoSource(term);
  if (!source) return false;

  try {
    const res = spawnSync('ssh', opts.sshArgs, {
      input: source,
      env: { ...process.env, ...opts.sshEnv },
      timeout: PUSH_TIMEOUT_MS,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (res.status === 0) {
      markTerminfoSynced(opts.host, term);
      return true;
    }
  } catch {
  }
  return false;
}
