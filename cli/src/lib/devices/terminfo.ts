/** Terminfo propagation for `agents ssh` interactive logins. Terminals with a custom `TERM`
 * (Ghostty, kitty, ...) break backspace, colors, and alt-screen when the remote lacks the entry,
 * so push `infocmp -x` into remote `tic -x -`. Failures are swallowed; success is cached per host. */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getCacheDir } from '../state.js';
import { type DeviceProfile } from './registry.js';

/** Terminfo names ncurses ships essentially everywhere, so pushing them is wasted work; anything
 * else is a sync candidate. Conservative on purpose: when unsure, push (`tic` is idempotent and
 * the result is cached). */
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

/** How long a successful sync suppresses re-syncing the same host+TERM. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Cap on the push so a stalled remote can't delay the login indefinitely. */
const PUSH_TIMEOUT_MS = 8000;

/** Decide whether an interactive login warrants a terminfo push. Pure, so the gating is testable
 * without ssh or the filesystem; `interactive` is true only for a real login (no remote command)
 * on a human tty. */
export function shouldSyncTerminfo(params: {
  term?: string;
  shell: DeviceProfile['shell'];
  interactive: boolean;
}): boolean {
  if (!params.interactive) return false;
  if (params.shell === 'powershell') return false; // Windows console ignores terminfo
  const term = params.term?.trim();
  if (!term) return false;
  if (UNIVERSAL_TERMS.has(term)) return false;
  return true;
}

/** Cache key for a device: the remote user@host, not just host. terminfo compiles into the per-user
 * `~/.terminfo`, so `alice@box` and `bob@box` are distinct targets; host-only keying would let the
 * first user's stamp suppress the second's sync. */
export function terminfoHostKey(device: Pick<DeviceProfile, 'user' | 'name'>, addr: string | undefined): string {
  const host = addr ?? device.name;
  return device.user ? `${device.user}@${host}` : host;
}

/** Directory holding per-host+TERM sync stamps. `cacheRoot` override is for tests. */
function stampDir(cacheRoot?: string): string {
  return path.join(cacheRoot ?? getCacheDir(), 'devices', 'terminfo');
}

/** Filesystem-safe stamp name for a host+TERM pair. */
function stampFile(host: string, term: string, cacheRoot?: string): string {
  const safe = `${host}__${term}`.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(stampDir(cacheRoot), safe);
}

/** True when a fresh successful-sync stamp exists for this host+TERM. */
export function terminfoSynced(host: string, term: string, cacheRoot?: string): boolean {
  try {
    const st = fs.statSync(stampFile(host, term, cacheRoot));
    return Date.now() - st.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/** Record a successful sync so repeat logins skip the push. Best-effort. */
export function markTerminfoSynced(host: string, term: string, cacheRoot?: string): void {
  try {
    fs.mkdirSync(stampDir(cacheRoot), { recursive: true });
    fs.writeFileSync(stampFile(host, term, cacheRoot), `${new Date().toISOString()}\n`);
  } catch {
    /* a cache write failure just means we re-sync next time — never fatal */
  }
}

/** Export the local terminfo source for a TERM, or null if it can't be produced. */
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
    /* infocmp missing or errored — nothing we can push */
  }
  return null;
}

/** Best-effort: ensure `device` has the terminfo entry for the local `$TERM` before an interactive
 * login. Never throws; returns whether a push succeeded (false when skipped, cached, or failed). */
export function syncTerminfoToDevice(opts: {
  device: DeviceProfile;
  host: string;
  term: string | undefined;
  /** ssh argv for a non-interactive `tic -x -` exec against this device. */
  sshArgs: string[];
  /** Env overlay for that ssh (askpass wiring for password devices). */
  sshEnv: Record<string, string>;
}): boolean {
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
    /* connection failed / timed out — fail-safe, login proceeds unaffected */
  }
  return false;
}
